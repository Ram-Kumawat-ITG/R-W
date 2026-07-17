// Shopify Carrier Service callback — retail store (ns-retail).
//
// Mirrors wholesale/app/api/shipping/rates.js 1:1 — same logic, same env
// var names. Each Shopify store (retail vs wholesale) has its OWN carrier
// service registered pointing at its OWN callback URL; the OAuth
// credentials in THIS app's .env may point at a different USPS/UPS
// account than wholesale's. When you change one of these two files,
// update the other to match.
//
// Registered with Shopify via the `carrierServiceCreate` Admin GraphQL
// mutation (one-time per store; run in GraphiQL or via an admin button).
// At checkout Shopify POSTs the cart's origin + destination + items here
// and expects this exact response shape:
//
//   { rates: [{ service_name, service_code, total_price, currency, ... }] }
//
// Critical contract:
//   • total_price is a STRING in MINOR UNITS (cents). "500" = $5.00.
//   • This endpoint MUST return HTTP 200 on every code path. Any 4xx/5xx
//     breaks checkout — customer sees "no shipping available" and can't
//     complete the purchase. On any error we still return 200 with
//     { rates: [] } so Shopify can fall back gracefully.
//
// What this endpoint does:
//   1. Verifies the Shopify HMAC header (log-only; carrier-service
//      callbacks aren't standard-signed — see history at the HMAC block).
//   2. Reads items + origin + destination from the Shopify payload and
//      filters out any "Processing Fee" cart lines added by the UI
//      extension (defensive — fee is disabled today).
//   3. Fetches the `pack:XXX` tag for every cart product via one bulk
//      GraphQL call to Shopify Admin API (auth via unauthenticated.admin
//      using RETAIL_SHOP_DOMAIN). If ANY product is missing a valid
//      `pack:` tag → returns empty rates (customer sees "no shipping
//      available"). This is the back-pressure that forces the merchant
//      to tag every product before it can ship.
//   4. Classifies the cart into 9 packing categories (S / S1 / M / L /
//      LL / G1 / G2 / G4 / FA), selects the smallest box tier that fits
//      via the 6-step selectBox() algorithm, and computes the package
//      weight = items + tare + packing buffer.
//   5. Calls USPS + UPS direct-carrier APIs in parallel with the picked
//      box's real dims + weight:
//        • USPS Web Tools v3 (USPS_CLIENT_ID / USPS_CLIENT_SECRET)
//        • UPS Rating v2403  (UPS_CLIENT_ID / UPS_CLIENT_SECRET / UPS_SHIPPER_NUMBER)
//      Dedups by (carrier, service), applies the tiered handling markup
//      (see `tieredMarkupCents`), zeroes both when free-shipping fires
//      ($500+ NS-only cart), sorts cheapest-first, and returns rates
//      with the picked box surfaced in service_name + description.
//   6. If NEITHER carrier returns rates (credentials missing / API down):
//      returns an EMPTY rates list — never quotes placeholder prices.
//
// SETUP — both carriers (one-time):
//   USPS:   registration.usps.com → APIs → OAuth credentials
//   UPS:    developer.ups.com → My Apps → OAuth 2.0
//
// Env vars required in addition to carrier creds:
//   RETAIL_SHOP_DOMAIN — the retail Shopify shop this app is installed on
//   (used by the Admin API tag-fetch call). Any carrier whose env vars
//   aren't set is silently skipped — no errors.

import crypto from "node:crypto";
import { unauthenticated } from "../../shopify.server";

// ═══════════════════════════════════════════════════════════════════════
// CONFIG — every tunable value lives here, single source of truth. Edit
// this block to change fees / thresholds / markup / caching behaviour —
// no code hunting elsewhere in the file. All values are DYNAMIC in the
// sense that tax / shipping / customer address come from live Shopify
// data; only these operational constants are declared here.
// ═══════════════════════════════════════════════════════════════════════
const CONFIG = {
  // Handling markup added to every non-free shipping option, tiered
  // by total cart quantity (values in CENTS on the wire).
  // The drop-ship reverse-calc in wholesale/app/services/dropship/*.js
  // must mirror these numbers — keep them in sync across repos.
  handlingMarkupCents: {
    upTo2Items: 200, // +$2 for 1-2 items
    threeItems: 300, // +$3 for 3 items
    fourPlusItems: 500, // +$5 for 4+ items
  },

  // Free-shipping rule (both conditions must hold to trigger $0
  // shipping). Vendor match is case-insensitive + trimmed.
  freeShipping: {
    vendor: "Natural Solutions",
    thresholdUsd: 500,
  },

  // Retail no longer charges the 3% card surcharge and no longer fetches
  // tax here — Shopify handles retail tax natively. Wholesale still has
  // its own fee logic in wholesale/app/api/shipping/rates.js; keep both
  // in sync when handling markup or free-shipping rules change.
};

// ═══════════════════════════════════════════════════════════════════════
// PACKING config — box tiers, unit-cost table, packing-material buffer
// ═══════════════════════════════════════════════════════════════════════
//
// Everything the box-selection engine needs to size an order. Numbers
// come from two sources:
//   1. Stephanie's raw packing rules (converted to deterministic
//      "unit-cost" math — see PROGRAM.md 2026-07-13 for derivation).
//   2. Trace's July 2026 corrections after review (weight fix on 9x6x4,
//      G4 fit correction, real-measured 18x14x8 tare, etc.).
//
// Client-provisional (2026-07-15): the new S/S1 split is being finalized
// with Trace + Stephanie. Numbers can be tuned in seconds — merchant
// approval gate + manual dim/weight override on every order acts as the
// safety net for any algorithm miss.
const PACKING = {
  // Unit-cost per category — how much "space" one of each takes in a
  // box, expressed as a unit fraction. Derived from the 9x6x4 envelope
  // baseline (capacity = 3 units):
  //   - 3 × S = 3 units → 1 S = 0.75  (extra-small: Chromium, D3)
  //   - 3 × S1 = 3 units → 1 S1 = 1   (small: Adrenal TLP, Body RGN)
  //   - 1 × M + 1 × S1 = 3 units → 1 M = 2
  //   - 1 × L alone = 3 units → 1 L = 3
  //   - 4 × G1 = 3 → 1 G1 = 0.75
  //   - 3 × G2 = 3 → 1 G2 = 1
  //   - 2 × G4 = 3 → 1 G4 = 1.5 (client corrected 2026-07-13; was 3)
  //   - 60 × FA = 9 (fits 11x9x4) → 1 FA = 0.15
  // LL uses the separate `liquids` capacity, not unitCost.
  unitCost: {
    S: 0.75,
    S1: 1,
    M: 2,
    L: 3,
    G1: 0.75,
    G2: 1,
    G4: 1.5,
    FA: 0.15,
    // LL — no entry; LL count checked against box.liquids separately
  },

  // Packing-material weight added to every package (bubble wrap, paper,
  // peanuts, tape). Trace explicitly asked for over-weight rather than
  // under (cited a real $3.15 UPS bulge adjustment). Numbers are our
  // estimates pending Stephanie's worst-case measurement — safe to raise
  // if under-weight surfaces at billing time.
  packingBufferOz: {
    envelope: 2,
    box: 5,
  },

  // Box tiers — ordered smallest to largest. `selectBox` iterates in this
  // order and picks the FIRST tier where the cart fits. Client confirmed
  // "smallest-that-fits" (Q8) because the approval gate catches any
  // wrong pick.
  //
  // Field reference:
  //   name       — human-readable identifier for logs
  //   type       — "envelope" or "box" (drives packingBufferOz lookup)
  //   L,W,H      — dimensions in inches (sent to USPS + UPS)
  //   tareOz     — empty box/envelope weight in ounces
  //   units      — non-liquid space capacity in unit-cost terms
  //   liquids    — large-liquid (LL) capacity (0 for envelopes)
  //   glassMax   — optional cap on total glass count for that tier
  //   glassMin   — minimum glass count that TRIGGERS this tier (Enersync)
  //   faMax      — optional cap on FA count
  //   partitioned — true for Enersync boxes (glass safety)
  //   glassSize  — Enersync-only, "1oz" or "2oz" (majority-size match)
  //   fragilePreferred — true for UPS mini (glass-safety trigger)
  //   tinyExtrasOnly — true for 18x13x3 (only S + FA allowed as extras)
  //
  // Tare-weight corrections logged 2026-07-13:
  //   9x6x4 envelope: 2.7 → 0.7 oz (Trace's original sheet had a typo)
  //   18x14x8 box:    ~14 → 17 oz  (Trace actually weighed = 1 lb 1 oz)
  boxTiers: [
    // ── Envelopes + UPS mini (small, ordered by capacity) ─────────────
    { name: "9x6x4 envelope",   type: "envelope", L: 9,  W: 6,  H: 4,  tareOz: 0.7,  units: 3, liquids: 0, glassMax: 4 },
    { name: "8x6x3 UPS mini",   type: "box",      L: 8,  W: 6,  H: 3,  tareOz: 2.7,  units: 3, liquids: 0, glassMax: 6, fragilePreferred: true },
    { name: "11x9x4 envelope",  type: "envelope", L: 11, W: 9,  H: 4,  tareOz: 0.7,  units: 9, liquids: 0, faMax: 60 },
    // ── Liquid boxes (ordered by liquid capacity) ─────────────────────
    // "Extras" numbers per client's Q1: 3 for smallest, 4 for mid, 6-8 for big.
    { name: "8x6x6 box",        type: "box",      L: 8,  W: 6,  H: 6,  tareOz: 3.9,  units: 3, liquids: 1 },
    { name: "10x7x6 box",       type: "box",      L: 10, W: 7,  H: 6,  tareOz: 5.0,  units: 4, liquids: 2 },
    { name: "11x4x12 box",      type: "box",      L: 11, W: 4,  H: 12, tareOz: 5.7,  units: 4, liquids: 3 },
    { name: "16x11x3 box",      type: "box",      L: 16, W: 11, H: 3,  tareOz: 7.5,  units: 4, liquids: 4 },
    { name: "12x12x5 box",      type: "box",      L: 12, W: 12, H: 5,  tareOz: 9.6,  units: 4, liquids: 4 },
    // 18x13x3 — per client Q2: "no extra room when full liquids, only FA or
    // very small bottle like Aquamax/Chromium might fit". `tinyExtrasOnly`
    // flag makes selectBox reject any cart with L/M/S1/G* items.
    { name: "18x13x3 box",      type: "box",      L: 18, W: 13, H: 3,  tareOz: 9.3,  units: 1, liquids: 6, tinyExtrasOnly: true },
    { name: "15x12x9 box",      type: "box",      L: 15, W: 12, H: 9,  tareOz: 11.5, units: 6, liquids: 12 },
    // 18x14x8 — Trace measured 17 oz (1 lb 1 oz). Prior estimate was ~14.
    { name: "18x14x8 box",      type: "box",      L: 18, W: 14, H: 8,  tareOz: 17.0, units: 8, liquids: 16 },
    // ── Enersync (partitioned) — triggered by 12+ glass ───────────────
    // Client Q5: NOT strictly glass-only. Example: 12×G1 + 3×Adrenal TLP
    // fits in Enersync 1oz. So `units: 4` allows up to 4 unit-cost of
    // extras alongside the glass partitions.
    { name: "Enersync 1oz",     type: "box",      L: 10, W: 7,  H: 6,  tareOz: 7.0,  units: 4, liquids: 0, glassMin: 12, partitioned: true, glassSize: "1oz" },
    { name: "Enersync 2oz",     type: "box",      L: 11, W: 7,  H: 8,  tareOz: 13.2, units: 4, liquids: 0, glassMin: 12, partitioned: true, glassSize: "2oz" },
    // 13x13x10 is pending — Trace will weigh when back in stock. NOT
    // added to the tier list until she provides real tare weight.
    // 16x12x10 was explicitly excluded per Q7 answer.
  ],
};

// Handling-markup resolver — reads `CONFIG.handlingMarkupCents`. The
// drop-ship reverse-calc in wholesale mirrors this tiering exactly.
function tieredMarkupCents(qty) {
  if (qty <= 2) return CONFIG.handlingMarkupCents.upTo2Items;
  if (qty === 3) return CONFIG.handlingMarkupCents.threeItems;
  return CONFIG.handlingMarkupCents.fourPlusItems;
}

// ── Discount detection from the carrier-service payload ──────────────
//
// Used only for observability — the per-rate breakdown log shows the net
// (post-discount) cart subtotal alongside the raw items sum so ops can
// see at a glance whether a customer's discount landed in the payload.
// Nothing in the returned rate depends on this value; free-shipping still
// checks the pre-discount subtotal (Shopify's carrier-service payload
// doesn't reliably expose post-discount totals across all themes).
//
// Shopify populates the discount across multiple fields depending on
// Shopify version + theme. We probe them in order of reliability and
// return the first non-zero value in CENTS. Returns 0 on no match.
// The { source } field records which field won so payload-shape drift
// is diagnosable in production logs.
function detectCartDiscountCents(rate, realItems) {
  // Field 0a: `rate.order_totals.discount_amount` — integer CENTS.
  //           Confirmed present in real 2026-07-07 production payload
  //           dumps: Shopify carrier-service now sends an `order_totals`
  //           block { subtotal_price, total_price, discount_amount }
  //           on every callback. When any discount (line-level OR
  //           order-level) is active, this field carries the total
  //           applied discount in cents. Highest-confidence source.
  const orderTotalDiscount = Number(rate?.order_totals?.discount_amount);
  if (Number.isFinite(orderTotalDiscount) && orderTotalDiscount > 0) {
    return {
      cents: Math.round(orderTotalDiscount),
      source: "order_totals.discount_amount",
    };
  }

  // Field 0b: derived from `order_totals.subtotal_price` vs
  //           `order_totals.total_price` — belt-and-braces in case
  //           Shopify sometimes populates the totals but leaves
  //           `discount_amount` at 0. Both values are cents already
  //           (no dollars/cents heuristic needed for this block).
  const otSubtotal = Number(rate?.order_totals?.subtotal_price);
  const otTotal = Number(rate?.order_totals?.total_price);
  if (
    Number.isFinite(otSubtotal) &&
    Number.isFinite(otTotal) &&
    otSubtotal > otTotal &&
    otSubtotal > 0
  ) {
    return {
      cents: Math.round(otSubtotal - otTotal),
      source: "order_totals (subtotal − total)",
    };
  }

  // Field 1: `rate.total_discounts` — integer cents, top-level. Older
  //          shape of the carrier-service payload set this. Kept as a
  //          fallback for backward compatibility.
  const topLevel = Number(rate?.total_discounts);
  if (Number.isFinite(topLevel) && topLevel > 0) {
    return { cents: Math.round(topLevel), source: "rate.total_discounts" };
  }

  // Field 2: sum of `items[].discount_allocations[].amount` — per-line
  //          allocations of a cart-level discount. Shopify sends these
  //          as strings in dollars (e.g. "5.00") on some themes, and
  //          cents on others — heuristic: values > 100 are treated as
  //          cents, everything smaller is treated as dollars.
  let allocSum = 0;
  for (const it of realItems || []) {
    for (const alloc of it?.discount_allocations || []) {
      const raw = Number(alloc?.amount ?? alloc?.discount_amount);
      if (!Number.isFinite(raw) || raw <= 0) continue;
      allocSum += raw > 100 ? raw : raw * 100;
    }
  }
  if (allocSum > 0) {
    return {
      cents: Math.round(allocSum),
      source: "items[].discount_allocations",
    };
  }

  // Field 3: derive from `rate.subtotal_price` (post-discount cart
  //          total that Shopify sometimes sends alongside the items)
  //          vs the sum of items[].price × quantity. If the two
  //          differ, the delta IS the applied discount (in cents).
  const subtotalFromRate = Number(rate?.subtotal_price);
  if (Number.isFinite(subtotalFromRate) && subtotalFromRate > 0) {
    const itemsSum = (realItems || []).reduce(
      (s, it) =>
        s + (Number(it?.price) || 0) * (Number(it?.quantity) || 0),
      0,
    );
    // Some themes send subtotal_price in dollars, others cents.
    // Normalize to cents by matching against itemsSum's magnitude.
    const subtotalCents =
      subtotalFromRate < itemsSum / 10
        ? Math.round(subtotalFromRate * 100)
        : Math.round(subtotalFromRate);
    if (subtotalCents > 0 && subtotalCents < itemsSum) {
      return {
        cents: itemsSum - subtotalCents,
        source: "rate.subtotal_price (derived)",
      };
    }
  }

  return { cents: 0, source: "none" };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function ratesResponse(rates) {
  // Shopify expects the bare `{ rates: [...] }` shape — NO envelope wrapping.
  return new Response(JSON.stringify({ rates: rates || [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function verifyHmac(rawBody, headerValue) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret || !headerValue) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(headerValue, "utf8"),
    );
  } catch {
    return false;
  }
}

function sumQuantity(items) {
  return (items || []).reduce(
    (sum, it) => sum + (Number(it?.quantity) || 0),
    0,
  );
}

// ── Processing Fee line detection ──────────────────────────────────────
//
// Mirrors wholesale/app/api/shipping/rates.js. The Checkout UI extension
// (extensions/processing-fee/src/Checkout.jsx) adds a "Processing Fee"
// cart line item (variant priced at $0.01, quantity = cents-of-fee).
// When Shopify POSTs the carrier-service callback, this line appears in
// `rate.items[]` alongside real merchandise. We MUST exclude it from:
//   • totalQty   → otherwise the fee's high quantity pushes the handling-
//                  markup tier to "4+ items → $5" on every cart
//   • carrier weight calc → the fee variant should be weight=0 but
//                           depending on Shopify Admin config it may
//                           carry default weight that inflates carrier
//                           quotes
//
// Detection: variant_id match first (fast + exact), then title regex as
// a defensive fallback for misconfigured products / variant-id drift.
// Keep PROCESSING_FEE_VARIANT_ID in sync with FEE_VARIANT_GID in
// extensions/processing-fee/src/Checkout.jsx — different value from
// the wholesale store (separate product per store).
const PROCESSING_FEE_VARIANT_ID = null; // TODO: replace with retail Processing Fee variant numeric id
const PROCESSING_FEE_TITLE_RE = /processing\s*fee/i;

function isProcessingFeeItem(it) {
  if (!it) return false;
  if (
    PROCESSING_FEE_VARIANT_ID != null &&
    Number(it.variant_id) === PROCESSING_FEE_VARIANT_ID
  ) {
    return true;
  }
  const name = String(it.name || it.title || '').trim();
  return PROCESSING_FEE_TITLE_RE.test(name);
}

// Add N business days from today and return an ISO date string —
// Shopify shows this next to the price in the customer's checkout view.
function addBusinessDaysIso(daysFromToday) {
  const d = new Date();
  d.setDate(d.getDate() + Math.max(0, daysFromToday));
  return d.toISOString();
}

// USPS / UPS / FedEx APIs want pounds (LB) for weight. DHL uses kg —
// converted inline within fetchDHLRates.
function gramsToLb(grams) {
  return Math.max(0.1, Math.round(((Number(grams) || 0) / 453.592) * 10) / 10);
}

// ═══════════════════════════════════════════════════════════════════════
// PRODUCT CLASSIFICATION — pure tag-based (2026-07-16)
// ═══════════════════════════════════════════════════════════════════════
//
// Every product in the retail Shopify store must carry ONE `pack:XXX` tag
// naming its packing category. Nine allowed values:
//
//   pack:FA   Frequency App (flat card — vendor "Frequency Apps")
//   pack:LL   Large liquid  (Liquid Life, Miracle II, Body FX-heavy, etc.)
//   pack:G4   4 oz glass tincture
//   pack:G2   2 oz glass tincture
//   pack:G1   1 oz glass tincture
//   pack:L    Large bottle (non-liquid)
//   pack:M    Medium bottle
//   pack:S1   Small bottle (capsules)
//   pack:S    Extra small bottle (Chromium, D3, Lypozyme, Aquamax)
//
// The merchant assigns these via Shopify admin — Product edit page → Tags.
// This gives 100 % explicit control per product (no weight/name guessing).
//
// Runtime: on every carrier callback we do ONE bulk GraphQL query to
// Shopify Admin API asking for `tags` on all product IDs in the cart, then
// parse each product's tags to find the `pack:` prefix.
//
// Missing tag policy:
//   If ANY cart item's product has no `pack:` tag, the whole rate
//   response is EMPTY — customer sees "no shipping available." This is
//   intentional back-pressure: it forces the merchant to tag every
//   product before it can ship.

const PACK_TAG_PREFIX = "pack:";
const ALLOWED_CATEGORIES = new Set([
  "FA", "LL", "G4", "G2", "G1", "L", "M", "S1", "S",
  // Pending taxonomy lock-in (2026-07-17 — PM Q1 answer):
  //   XL     — oversized non-liquid items (e.g. Body FX). Route to largest
  //            tier for now; per-product mapping arrives via Trace's
  //            worksheet.
  //   OTHER  — products that ship in their own retail box (e.g. Three Lac,
  //            Trimsulin). The engine shouldn't try to fit them into a
  //            picked tier; treat as "own shipment/dimension" placeholder
  //            (flagged overflow so merchant reviews). Full "own dims"
  //            handling waits for per-product metafields.
  "XL", "OTHER",
]);

// Extract the packing category from a product's `tags` array. Returns
// null if no `pack:XXX` tag is present or the value is unrecognized.
function extractPackingCategory(tags) {
  if (!Array.isArray(tags)) return null;
  for (const raw of tags) {
    const tag = String(raw || "").trim();
    if (!tag.toLowerCase().startsWith(PACK_TAG_PREFIX)) continue;
    // Preserve the merchant's original casing after the prefix so
    // "pack:S1" stays "S1", not "s1". The allow-list check below still
    // uppercases for tolerance against typos like "pack:s1".
    const value = tag.slice(PACK_TAG_PREFIX.length).trim();
    const normalized = value.toUpperCase();
    if (ALLOWED_CATEGORIES.has(normalized)) return normalized;
    // Unknown category — treat as missing so operator can fix the typo.
    return null;
  }
  return null;
}

// Bulk-fetch tags for every product ID in the cart via one Shopify Admin
// GraphQL call, using the app's stored OAuth session for the retail shop
// (`unauthenticated.admin(shop)` — same pattern used by customerTags.js,
// cdo.portal.service.js, etc.). Returns Map<productId string, tags array>.
// Never throws — on any failure (missing session, network, GraphQL error)
// returns an empty Map so the caller treats every item as "no tag" and
// falls back to empty rates.
//
// Shop resolution: the carrier-service callback doesn't include a shop
// domain header, so we read RETAIL_SHOP_DOMAIN from env (falling back to
// SHOPIFY_SHOP for parity with the rest of the file). This must match
// the shop domain this app is installed on — the same one whose OAuth
// session token was persisted at install time.
async function fetchProductTagsFromShopify(productIds) {
  if (!productIds || productIds.length === 0) return new Map();

  const rawShop =
    process.env.RETAIL_SHOP_DOMAIN || process.env.SHOPIFY_SHOP || "";
  const shop = String(rawShop || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  if (!shop) {
    console.warn(
      "[shipping.rates] RETAIL_SHOP_DOMAIN env var not set — cannot fetch product tags. Every quote will be empty until it's configured.",
    );
    return new Map();
  }

  let admin;
  try {
    const authed = await unauthenticated.admin(shop);
    admin = authed.admin;
  } catch (err) {
    console.warn(
      "[shipping.rates] product-tags session lookup failed:",
      err?.message || String(err),
    );
    return new Map();
  }

  const gids = productIds.map((id) => `gid://shopify/Product/${id}`);
  const query = `#graphql
    query CartProductTags($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          tags
        }
      }
    }
  `;

  const startedAt = Date.now();
  let body;
  try {
    const res = await admin.graphql(query, { variables: { ids: gids } });
    body = await res.json();
  } catch (err) {
    console.warn(
      "[shipping.rates] product-tags GraphQL call failed:",
      err?.message || String(err),
      `· elapsed=${Date.now() - startedAt}ms`,
    );
    return new Map();
  }

  if (Array.isArray(body?.errors) && body.errors.length) {
    console.warn(
      "[shipping.rates] product-tags GraphQL errors:",
      JSON.stringify(body.errors).slice(0, 400),
    );
    return new Map();
  }

  const result = new Map();
  for (const node of body?.data?.nodes || []) {
    if (!node?.id) continue;
    const idStr = String(node.id).replace("gid://shopify/Product/", "");
    result.set(idStr, Array.isArray(node.tags) ? node.tags : []);
  }
  console.log(
    `[shipping.rates] product-tags fetched · ${result.size}/${productIds.length} product(s) resolved · elapsed=${Date.now() - startedAt}ms`,
  );
  return result;
}

// Aggregate cart-level classification. Given the cart's line items and a
// pre-fetched Map<productId, tags[]>, produce per-line categories, the
// bucketed counts, and a `missing` list of items that lack a valid
// `pack:` tag. Callers should refuse to quote rates if `missing.length > 0`.
function classifyCart(items, tagsByProductId) {
  const counts = {
    FA: 0, LL: 0, G4: 0, G2: 0, G1: 0, L: 0, M: 0, S1: 0, S: 0,
    // Pending-taxonomy categories (structural only until Trace's worksheet):
    XL: 0, OTHER: 0,
  };
  const perLine = [];
  const missing = [];

  for (const it of items || []) {
    const productId = String(it?.product_id || "");
    const tags = tagsByProductId.get(productId) || [];
    const category = extractPackingCategory(tags);
    const qty = Number(it?.quantity) || 1;

    if (!category) {
      missing.push({
        productId,
        variantId: it?.variant_id ?? null,
        sku: it?.sku || null,
        name: it?.name || "",
        tagsFound: tags,
      });
      perLine.push({
        variantId: it?.variant_id ?? null,
        sku: it?.sku || null,
        name: it?.name || "",
        grams: Number(it?.grams) || 0,
        quantity: qty,
        category: null,
      });
      continue;
    }

    counts[category] += qty;
    perLine.push({
      variantId: it?.variant_id ?? null,
      sku: it?.sku || null,
      name: it?.name || "",
      grams: Number(it?.grams) || 0,
      quantity: qty,
      category,
    });
  }

  return { counts, perLine, missing };
}

// ═══════════════════════════════════════════════════════════════════════
// BOX SELECTION — cart classification counts → picked box tier
// ═══════════════════════════════════════════════════════════════════════
//
// The core algorithm. Given a cart's per-category counts (from
// classifyCart), pick the smallest box in PACKING.boxTiers that fits.
// Client-confirmed priority (see PROGRAM.md 2026-07-13 approvals):
//
//   STEP 1: totalGlass >= 12 → Enersync (1oz or 2oz by majority)
//           Extras allowed up to Enersync.units (Q5 answer).
//   STEP 2: (G1 + G2) >= 3 AND totalItems <= 5 AND no L AND no LL
//           → 8x6x3 UPS mini (glass-safety trigger, Q6 answer)
//   STEP 3: any LL > 0 → smallest liquid box that fits
//           iterate ordered liquid tiers; first where liquids AND units OK
//           18x13x3 tinyExtrasOnly enforced — only S + FA allowed
//   STEP 4: any FA > 0 (no LL) → 11x9x4 envelope if fits
//   STEP 5: bottles/glass only, no LL:
//             unitDemand <= 3 → 9x6x4 envelope
//             unitDemand <= 9 → 11x9x4 envelope
//             larger        → next tier that fits
//   STEP 6: nothing fits → largest tier + overflow flag (approval gate
//           handles it manually)
//
// Returns { box, overflow }. Box is a PACKING.boxTiers entry (with
// `name`, `L`, `W`, `H`, `tareOz`, `type`). Overflow=true means no
// tier's capacity satisfied — merchant should manually pick.
function selectBox(cartCounts) {
  const c = cartCounts || {};
  const totalGlass = (c.G1 || 0) + (c.G2 || 0) + (c.G4 || 0);
  const totalItems =
    (c.S || 0) + (c.S1 || 0) + (c.M || 0) + (c.L || 0) +
    (c.LL || 0) + (c.G1 || 0) + (c.G2 || 0) + (c.G4 || 0) + (c.FA || 0);
  // Non-liquid, non-FA unit demand (LL uses `liquids`, FA uses `faMax`).
  const unitDemand =
    (c.S || 0) * PACKING.unitCost.S +
    (c.S1 || 0) * PACKING.unitCost.S1 +
    (c.M || 0) * PACKING.unitCost.M +
    (c.L || 0) * PACKING.unitCost.L +
    (c.G1 || 0) * PACKING.unitCost.G1 +
    (c.G2 || 0) * PACKING.unitCost.G2 +
    (c.G4 || 0) * PACKING.unitCost.G4;
  // FA can share space with other items (they're flat cards). Treat FA
  // demand separately via `faMax` on the envelope tier (60 in 11x9x4).
  const faDemand = c.FA || 0;
  const llDemand = c.LL || 0;

  // Non-tiny categories used to check `tinyExtrasOnly` (18x13x3).
  const hasNonTinyExtras =
    (c.S1 || 0) > 0 || (c.M || 0) > 0 || (c.L || 0) > 0 ||
    (c.G1 || 0) > 0 || (c.G2 || 0) > 0 || (c.G4 || 0) > 0 ||
    (c.XL || 0) > 0 || (c.OTHER || 0) > 0;

  // ── STEP 0 (pending taxonomy): pack:XL or pack:OTHER in cart ─────────
  //
  // Placeholder routing until Trace's classification worksheet lands with
  // per-product XL vs OTHER assignments (2026-07-17 PM Q1 answer). The tag
  // structure is live so merchants can tag their edge-case products, but
  // the engine can't yet size an XL/OTHER package correctly:
  //   • XL   — oversized non-liquid (e.g. Body FX). Route to largest tier
  //            with overflow flag so merchant approval-gate reviews.
  //   • OTHER — ships in its own retail box (e.g. Three Lac, Trimsulin).
  //            No engine tier applies; return largest tier + overflow +
  //            a distinct log so ops sees this needs own-dim handling.
  // Full "own-dimension" routing waits for per-product metafields with
  // real L/W/H on the OTHER items.
  if ((c.XL || 0) > 0 || (c.OTHER || 0) > 0) {
    const largest = PACKING.boxTiers[PACKING.boxTiers.length - 1];
    console.warn(
      `[shipping.rates] cart contains pack:XL(${c.XL || 0}) / pack:OTHER(${c.OTHER || 0}) — pending taxonomy; routing to ${largest.name} + overflow`,
    );
    return { box: largest, overflow: true };
  }

  // ── STEP 1: 12+ glass → Enersync ────────────────────────────────────
  if (totalGlass >= 12 && llDemand === 0) {
    // Majority size decides which Enersync (Q5). Ties → 2oz (bigger box,
    // conservative for mixed carts).
    const majoritySize =
      (c.G1 || 0) > ((c.G2 || 0) + (c.G4 || 0)) ? "1oz" : "2oz";
    const enersync = PACKING.boxTiers.find(
      (b) => b.partitioned && b.glassSize === majoritySize,
    );
    // Verify the non-glass extras fit within Enersync's units budget.
    // (Client Q5: 12×G1 + 3×Adrenal TLP fits — 3 S1 = 3 units, budget 4.)
    const nonGlassUnits =
      (c.S || 0) * PACKING.unitCost.S +
      (c.S1 || 0) * PACKING.unitCost.S1 +
      (c.M || 0) * PACKING.unitCost.M +
      (c.L || 0) * PACKING.unitCost.L;
    if (enersync && nonGlassUnits <= enersync.units) {
      return { box: enersync, overflow: false };
    }
    // Otherwise fall through — extras too big, hit the regular box path.
  }

  // ── STEP 2: Small order with 3+ small glass → UPS mini ─────────────
  // Client Q6: "small order" = ≤ 5 total items, no LL, no L (or larger)
  const smallGlassCount = (c.G1 || 0) + (c.G2 || 0);
  if (
    smallGlassCount >= 3 &&
    llDemand === 0 &&
    (c.L || 0) === 0 &&
    totalItems <= 5
  ) {
    const upsMini = PACKING.boxTiers.find((b) => b.fragilePreferred);
    if (upsMini && unitDemand <= upsMini.units && totalGlass <= (upsMini.glassMax || 999)) {
      return { box: upsMini, overflow: false };
    }
  }

  // ── STEP 3: Any large liquid → smallest liquid box ─────────────────
  //
  // The `tinyExtrasOnly` flag (currently only on 18x13x3) is stricter than
  // a simple non-tiny-extras rejection. Per Trace (2026-07-14 + 2026-07-17
  // clarification via PM):
  //   (a) Cart has any M/L/S1/G* items → reject outright.
  //   (b) Box at MAX liquid capacity + cart has any S bottles → skip to
  //       next tier. Only Frequency Apps (flat cards) may sit alongside
  //       6 large liquids. Whether a single S bottle can squeeze in is
  //       still under review; conservative default is S-blocked when full.
  //   (c) Box has leftover liquid room → S + FA both fit (guarded by
  //       normal unit-budget check below).
  if (llDemand > 0) {
    const liquidBoxes = PACKING.boxTiers.filter((b) => b.liquids > 0);
    for (const box of liquidBoxes) {
      if (box.tinyExtrasOnly) {
        if (hasNonTinyExtras) continue;
        const liquidRoomLeft = box.liquids - llDemand;
        if (liquidRoomLeft <= 0 && (c.S || 0) > 0) continue;
      }
      if (box.liquids >= llDemand && box.units >= unitDemand) {
        return { box, overflow: false };
      }
    }
    // No liquid box fits — overflow to largest tier
    const largest = PACKING.boxTiers[PACKING.boxTiers.length - 1];
    return { box: largest, overflow: true };
  }

  // ── STEP 4: FA + small items (no LL) → 11x9x4 envelope ────────────
  if (faDemand > 0) {
    const largeEnv = PACKING.boxTiers.find((b) => b.name === "11x9x4 envelope");
    if (
      largeEnv &&
      faDemand <= (largeEnv.faMax || 60) &&
      unitDemand <= largeEnv.units
    ) {
      return { box: largeEnv, overflow: false };
    }
  }

  // ── STEP 5: Only bottles/glass, no LL — pick by unit demand ───────
  // Iterate non-liquid boxes smallest to largest. Skip UPS mini + Enersync
  // (special-purpose only) and skip tinyExtrasOnly boxes.
  const nonLiquidBoxes = PACKING.boxTiers.filter(
    (b) =>
      b.liquids === 0 && !b.fragilePreferred && !b.partitioned && !b.tinyExtrasOnly,
  );
  for (const box of nonLiquidBoxes) {
    if (box.units >= unitDemand + faDemand * PACKING.unitCost.FA) {
      // Glass max check (envelope has glassMax:4 for 9x6x4)
      if (box.glassMax !== undefined && totalGlass > box.glassMax) continue;
      return { box, overflow: false };
    }
  }

  // Iterate all remaining boxes (including liquid ones as last resort)
  // in case the cart is huge — but flag as overflow so merchant knows.
  const largest = PACKING.boxTiers[PACKING.boxTiers.length - 1];
  return { box: largest, overflow: true };
}

// ═══════════════════════════════════════════════════════════════════════
// PACKAGE WEIGHT COMPUTATION
// ═══════════════════════════════════════════════════════════════════════
//
// Total package weight = sum of item weights + empty box tare + packing
// material buffer. Sent to USPS + UPS for accurate rate quotes.
function computePackageWeight(items, box) {
  const itemsGrams = (items || []).reduce(
    (sum, it) => sum + (Number(it?.grams) || 0) * (Number(it?.quantity) || 1),
    0,
  );
  const itemsOz = itemsGrams / 28.3495;
  const tareOz = box?.tareOz || 0;
  const bufferOz = box?.type
    ? PACKING.packingBufferOz[box.type] || 0
    : PACKING.packingBufferOz.box;

  const totalOz = itemsOz + tareOz + bufferOz;
  const totalLbs = Math.max(0.1, Math.round((totalOz / 16) * 10) / 10);

  return {
    itemsOz: Math.round(itemsOz * 10) / 10,
    tareOz,
    bufferOz,
    totalOz: Math.round(totalOz * 10) / 10,
    totalLbs,
  };
}

// In-memory OAuth token cache keyed by carrier. Most direct-carrier APIs
// use OAuth client_credentials and return a token with ~1h TTL. We cache
// it across requests so we don't burn one auth call per checkout.
const tokenCache = new Map();
function getCachedToken(key) {
  const entry = tokenCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    tokenCache.delete(key);
    return null;
  }
  return entry.token;
}
function setCachedToken(key, token, ttlSeconds) {
  // Refresh 5 min before actual expiry to dodge edge-case races.
  tokenCache.set(key, {
    token,
    expiresAt: Date.now() + Math.max(60, ttlSeconds - 300) * 1000,
  });
}

// ════════════════════════════════════════════════════════════════════════
// DIRECT CARRIER INTEGRATIONS — free, no aggregator fees
//
// Each carrier returns a normalized shape so the dispatcher can merge them:
//   { carrier, service, rateCents, currency, deliveryDateMin, deliveryDateMax }
//
// SIGNUP PREREQS (one-time, per-store):
//   USPS    → registration.usps.com → APIs → Get OAuth Client ID/Secret
//   UPS     → developer.ups.com → Add Apps → OAuth 2.0 credentials
//   FedEx   → developer.fedex.com → API Catalog → OAuth credentials
//   DHL     → developer.dhl.com → DHL Express → Get API key
//
// Set the corresponding env vars; any carrier whose key is missing is
// silently skipped by the dispatcher.
// ════════════════════════════════════════════════════════════════════════

// ── USPS Web Tools v3 (live + ready to use once env vars are set) ───────
//
// USPS Prices API V3. OAuth 2.0 client_credentials flow, then a POST to
// the base-rates search endpoint. Free for unlimited rate quotes.
//
// Env vars required:
//   USPS_CLIENT_ID
//   USPS_CLIENT_SECRET
//   (Optional override) USPS_API_BASE = https://apis.usps.com
async function fetchUSPSRates({ origin, destination, items, selectedBox, packageWeight }) {
  const clientId = process.env.USPS_CLIENT_ID;
  const clientSecret = process.env.USPS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return [];

  const base = process.env.USPS_API_BASE || "https://apis.usps.com";

  // ── Step 1: Get / reuse OAuth token ────────────────────────────────
  let token = getCachedToken("usps");
  if (!token) {
    try {
      const tokenRes = await fetch(`${base}/oauth2/v3/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
      });
      if (!tokenRes.ok) {
        console.error("[shipping.rates] USPS oauth failed:", tokenRes.status);
        return [];
      }
      const tokenJson = await tokenRes.json();
      token = tokenJson.access_token;
      setCachedToken("usps", token, Number(tokenJson.expires_in) || 3600);
    } catch (err) {
      console.error("[shipping.rates] USPS oauth error:", err?.message || err);
      return [];
    }
  }

  // ── Step 2: Build common rate request payload ──────────────────────
  // USPS v3 `/prices/v3/base-rates/search` quotes ONE mail class per
  // call. To show Ground + Priority + Priority Express tiers, we fan
  // out three parallel calls and merge the results.
  //
  // Required fields (per USPS OpenAPI schema — missing any one returns
  // HTTP 400 "OASValidation … Object has missing required fields"):
  //   originZIPCode, destinationZIPCode, weight, length, width, height,
  //   mailClass, processingCategory, rateIndicator,
  //   destinationEntryFacilityType, priceType, mailingDate.
  //
  // `MACHINABLE` + `SP` (single piece) + `NONE` (no facility entry) are
  // the right defaults for a small parcel handed to a retail PO.
  // Legacy weight from raw item grams (kept as fallback if selectBox
  // didn't run for some reason — should never happen in normal flow).
  const totalGrams = (items || []).reduce(
    (s, it) => s + (Number(it?.grams) || 0) * (Number(it?.quantity) || 0),
    0,
  );

  // Dimensions + weight come from the box-selection engine
  // (`selectedBox` + `packageWeight`). Fallback to legacy 10×8×4 +
  // summed grams is defensive resilience only — real requests always
  // pass both.
  const weightLbs = packageWeight?.totalLbs ?? gramsToLb(totalGrams);
  const lengthIn = selectedBox?.L ?? 10;
  const widthIn = selectedBox?.W ?? 8;
  const heightIn = selectedBox?.H ?? 4;

  // Common to every USPS call. Per-mail-class overrides (below) replace
  // rateIndicator + processingCategory when a tier needs them.
  const baseBody = {
    originZIPCode: origin?.postal_code || "",
    destinationZIPCode: destination?.postal_code || "",
    weight: weightLbs,
    length: lengthIn,
    width: widthIn,
    height: heightIn,
    destinationEntryFacilityType: "NONE",
    priceType: "COMMERCIAL",
    mailingDate: new Date().toISOString().slice(0, 10),
  };

  // Each mail class has its own valid (rateIndicator, processingCategory)
  // combo. USPS rejects mismatches with "Could not find working sku from
  // SSF ingredients" — these values come from the USPS Prices v3 product
  // catalogue and are not interchangeable across classes.
  //
  //   SP / MACHINABLE  — Single Piece, machinable parcel (Ground, Priority)
  //   PA / MACHINABLE  — Priority Alert, used for Priority Mail Express
  //   SP / MACHINABLE  — also works for First-Class Package (<13 oz)
  //
  // If any class returns 400 with a "no sku" error, USPS doesn't sell
  // that combo for the given weight/zone — that class is silently dropped
  // from the response so the other classes still show.
  const MAIL_CLASSES = [
    {
      code: "USPS_GROUND_ADVANTAGE",
      label: "Ground Advantage",
      rateIndicator: "SP",
      processingCategory: "MACHINABLE",
    },
    {
      code: "PRIORITY_MAIL",
      label: "Priority Mail",
      rateIndicator: "SP",
      processingCategory: "MACHINABLE",
    },
    {
      code: "PRIORITY_MAIL_EXPRESS",
      label: "Priority Mail Express",
      rateIndicator: "PA",
      processingCategory: "MACHINABLE",
    },
    {
      code: "FIRST-CLASS_PACKAGE_SERVICE",
      label: "First-Class Package",
      rateIndicator: "SP",
      processingCategory: "MACHINABLE",
    },
  ];

  // ── Step 3: One call per mail class, in parallel ───────────────────
  async function fetchOne({ code, label, rateIndicator, processingCategory }) {
    let res;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      res = await fetch(`${base}/prices/v3/base-rates/search`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          ...baseBody,
          mailClass: code,
          rateIndicator,
          processingCategory,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
    } catch (err) {
      console.error(
        `[shipping.rates] USPS ${code} network error:`,
        err?.message || err,
      );
      return null;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        `[shipping.rates] USPS ${code} non-200:`,
        res.status,
        text.slice(0, 300),
      );
      if (res.status === 401) tokenCache.delete("usps");
      return null;
    }

    let json;
    try {
      json = await res.json();
    } catch {
      return null;
    }

    // v3 base-rates/search response: { totalBasePrice: 5.50, rates: [...], ... }
    // Top-level totalBasePrice is the cheapest match; we use that.
    const dollars = Number.parseFloat(
      json?.totalBasePrice ?? json?.rates?.[0]?.price,
    );
    if (!Number.isFinite(dollars)) return null;
    return {
      carrier: "USPS",
      service: label,
      rateCents: Math.round(dollars * 100),
      currency: "USD",
      deliveryDateMin: null,
      deliveryDateMax: null,
    };
  }

  const results = await Promise.all(MAIL_CLASSES.map(fetchOne));
  return results.filter(Boolean);
}

// ── UPS Rating API v2403 ────────────────────────────────────────────────
//
// SIGNUP: developer.ups.com → My Apps → New App → OAuth 2.0 client credentials.
// Env vars required:
//   UPS_CLIENT_ID, UPS_CLIENT_SECRET — OAuth credentials
//   UPS_SHIPPER_NUMBER              — your UPS account number (6 chars)
//   UPS_API_BASE                    — optional override (sandbox vs prod)
//
// Auth: OAuth 2.0 client_credentials. Authorization header is HTTP Basic
// (base64 of client_id:client_secret), body is form-encoded
// `grant_type=client_credentials`. Token returns with TTL ~14400s.
//
// Rates: POST {base}/api/rating/v2403/Shop returns rates for ALL available
// services in one call (vs `/Rate` which targets a single service code).
async function fetchUPSRates({ origin, destination, items, selectedBox, packageWeight }) {
  const clientId = process.env.UPS_CLIENT_ID;
  const clientSecret = process.env.UPS_CLIENT_SECRET;
  const shipperNumber = process.env.UPS_SHIPPER_NUMBER;
  if (!clientId || !clientSecret || !shipperNumber) return [];

  const base = process.env.UPS_API_BASE || "https://onlinetools.ups.com";

  // ── Step 1: OAuth token (cached) ────────────────────────────────
  let token = getCachedToken("ups");
  if (!token) {
    try {
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString(
        "base64",
      );
      const tokenRes = await fetch(`${base}/security/v1/oauth/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "grant_type=client_credentials",
      });
      if (!tokenRes.ok) {
        console.error("[shipping.rates] UPS oauth failed:", tokenRes.status);
        return [];
      }
      const tokenJson = await tokenRes.json();
      token = tokenJson.access_token;
      setCachedToken("ups", token, Number(tokenJson.expires_in) || 14400);
    } catch (err) {
      console.error("[shipping.rates] UPS oauth error:", err?.message || err);
      return [];
    }
  }

  // ── Step 2: Build rate request ──────────────────────────────────
  //
  // Dimensions + weight come from the box-selection engine
  // (`selectedBox` + `packageWeight`). UPS requires all numeric values
  // as STRINGS. Fallback to legacy 10×8×4 + summed grams is defensive
  // resilience only — real requests always pass both.
  const totalGrams = (items || []).reduce(
    (s, it) => s + (Number(it?.grams) || 0) * (Number(it?.quantity) || 0),
    0,
  );
  const weightLb = packageWeight?.totalLbs ?? gramsToLb(totalGrams);
  const boxL = String(selectedBox?.L ?? 10);
  const boxW = String(selectedBox?.W ?? 8);
  const boxH = String(selectedBox?.H ?? 4);

  const addr = (a) => ({
    AddressLine: [a?.address1 || "", a?.address2 || ""].filter(Boolean),
    City: a?.city || "",
    StateProvinceCode: a?.province_code || a?.province || "",
    PostalCode: a?.postal_code || "",
    CountryCode: a?.country_code || a?.country || "US",
  });

  const body = {
    RateRequest: {
      Request: {
        RequestOption: "Shop",
        TransactionReference: { CustomerContext: "NS Retail checkout" },
      },
      Shipment: {
        Shipper: {
          Name: "NS Retail",
          ShipperNumber: shipperNumber,
          Address: addr(origin),
        },
        ShipTo: { Name: "Customer", Address: addr(destination) },
        ShipFrom: { Name: "NS Retail", Address: addr(origin) },
        Package: {
          PackagingType: { Code: "02", Description: "Customer Supplied" },
          Dimensions: {
            UnitOfMeasurement: { Code: "IN", Description: "Inches" },
            Length: boxL,
            Width: boxW,
            Height: boxH,
          },
          PackageWeight: {
            UnitOfMeasurement: { Code: "LBS", Description: "Pounds" },
            Weight: String(weightLb),
          },
        },
      },
    },
  };

  // ── Step 3: Fetch rates ─────────────────────────────────────────
  let res;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    res = await fetch(`${base}/api/rating/v2403/Shop`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        transId: `ns-${Date.now()}`,
        transactionSrc: "NS_Retail",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (err) {
    console.error("[shipping.rates] UPS network error:", err?.message || err);
    return [];
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(
      "[shipping.rates] UPS non-200:",
      res.status,
      text.slice(0, 300),
    );
    if (res.status === 401) tokenCache.delete("ups");
    return [];
  }

  let json;
  try {
    json = await res.json();
  } catch {
    return [];
  }

  // UPS service code → human-readable label
  const UPS_SERVICE_NAMES = {
    "01": "Next Day Air",
    "02": "2nd Day Air",
    "03": "Ground",
    "07": "Worldwide Express",
    "08": "Worldwide Expedited",
    11: "Standard",
    12: "3 Day Select",
    13: "Next Day Air Saver",
    14: "Next Day Air Early",
    54: "Worldwide Express Plus",
    59: "2nd Day Air A.M.",
    65: "Saver",
  };

  // Response shape: { RateResponse: { RatedShipment: [...] } } — but
  // RatedShipment may be a single object if only one service was returned.
  const rsRaw = json?.RateResponse?.RatedShipment;
  const rsArr = Array.isArray(rsRaw) ? rsRaw : rsRaw ? [rsRaw] : [];
  return rsArr
    .map((rs) => {
      const code = rs?.Service?.Code;
      const dollars = Number.parseFloat(rs?.TotalCharges?.MonetaryValue);
      if (!code || !Number.isFinite(dollars)) return null;
      return {
        carrier: "UPS",
        service:
          UPS_SERVICE_NAMES[code] ||
          rs?.Service?.Description ||
          `Service ${code}`,
        rateCents: Math.round(dollars * 100),
        currency: rs?.TotalCharges?.CurrencyCode || "USD",
        deliveryDateMin: rs?.GuaranteedDelivery?.BusinessDaysInTransit
          ? addBusinessDaysIso(
              Number(rs.GuaranteedDelivery.BusinessDaysInTransit),
            )
          : null,
        deliveryDateMax: rs?.GuaranteedDelivery?.BusinessDaysInTransit
          ? addBusinessDaysIso(
              Number(rs.GuaranteedDelivery.BusinessDaysInTransit),
            )
          : null,
      };
    })
    .filter(Boolean);
}

// ── Dispatcher: USPS + UPS in parallel ─────────────────────────────────
//
// Extra params (2026-07-15): `selectedBox` + `packageWeight` are threaded
// through to the carrier fetchers so both USPS and UPS quote using the
// REAL picked box (dims + total weight incl. tare + buffer) instead of
// the hardcoded 10×8×4 placeholder they used before.
async function fetchDirectCarrierRates(rate, { selectedBox, packageWeight }) {
  const input = {
    origin: rate.origin,
    destination: rate.destination,
    items: rate.items,
    selectedBox,
    packageWeight,
  };
  const results = await Promise.all([
    fetchUSPSRates(input).catch((e) => {
      console.error("[shipping.rates] USPS failed:", e?.message || e);
      return [];
    }),
    fetchUPSRates(input).catch((e) => {
      console.error("[shipping.rates] UPS failed:", e?.message || e);
      return [];
    }),
  ]);
  return results.flat();
}

// ── Route handlers ──────────────────────────────────────────────────────

export async function loader() {
  // Shopify occasionally GETs to verify the URL responds.
  return ratesResponse([]);
}

export async function action({ request }) {
  if (request.method !== "POST") return ratesResponse([]);

  let rawBody;
  try {
    rawBody = await request.text();
  } catch (err) {
    console.error("[shipping.rates] failed to read body:", err?.message || err);
    return ratesResponse([]);
  }

  // HMAC verify — LOG-ONLY (never reject).
  //
  // Per Shopify docs, Carrier Service callbacks are NOT HMAC-signed
  // the same way regular webhooks are. Security for this endpoint
  // relies on the callback URL being unguessable + only registerable
  // via authenticated `carrierServiceCreate` mutation (attacker can't
  // point Shopify at their own URL). Empirically we DO sometimes see
  // an `X-Shopify-Hmac-Sha256` header on the request, but its value
  // often doesn't match a webhook-secret HMAC — likely because either
  // (a) it's set by a proxy (Cloudflare / Render), (b) Shopify's
  // carrier signing uses a different secret than SHOPIFY_API_SECRET,
  // or (c) the SHOPIFY_API_SECRET env var is stale.
  //
  // Hard-rejecting on a mismatch breaks production checkout (customer
  // sees "no shipping available"). So we verify FOR AUDIT ONLY — the
  // result is logged but the request is always accepted. If a real
  // tampering pattern shows up in logs, tighten this then.
  //
  // History:
  //   2026-07-06 — added hard-reject when secret is set → broke
  //                production carrier callbacks (both no-header AND
  //                invalid-header cases rejected legitimate Shopify
  //                requests).
  //   2026-07-07 — reverted to log-only. Do NOT re-add hard-reject
  //                without confirming Shopify actually signs THIS
  //                endpoint with SHOPIFY_API_SECRET.
  const hmacHeader = request.headers.get("x-shopify-hmac-sha256") || "";
  if (hmacHeader && !verifyHmac(rawBody, hmacHeader)) {
    console.warn(
      "[shipping.rates] hmac header present but did not match SHOPIFY_API_SECRET — accepting anyway (carrier-service callbacks aren't standard-signed; see 2026-07-07 hotfix note).",
    );
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.error("[shipping.rates] invalid JSON body");
    return ratesResponse([]);
  }

  const rate = payload?.rate;
  if (!rate || !rate.destination || !Array.isArray(rate.items)) {
    console.warn("[shipping.rates] missing rate.destination or rate.items");
    return ratesResponse([]);
  }

  // ── 1. Aggregate cart ────────────────────────────────────────────────
  //
  // Strip the Processing Fee cart line out of EVERY downstream calculation
  // (markup tier, carrier weight). See `isProcessingFeeItem` for detection
  // rules. `realItems` is the items array we treat as the customer's
  // actual merchandise; `rate.items` is the raw Shopify payload we keep
  // around only for logging.
  const realItems = (rate.items || []).filter(
    (it) => !isProcessingFeeItem(it),
  );
  const feeLinesExcluded = rate.items.length - realItems.length;

  const totalQty = sumQuantity(realItems);
  if (totalQty === 0) return ratesResponse([]);

  console.log(
    `[shipping.rates] inbound: ${rate.items.length} line(s) (${feeLinesExcluded} processing-fee excluded), realQty=${totalQty}, dest=${rate.destination?.country}/${rate.destination?.province}/${rate.destination?.postal_code}`,
  );


  // ── 1a. Free-shipping rule (retail store) ─────────────────────────
  //
  // Mirrors wholesale/app/api/shipping/rates.js §1a. Both conditions must
  // hold:
  //   (a) Every line item's vendor is exactly "Natural Solutions"
  //       (case-insensitive, trimmed — guards against trailing spaces in
  //       admin-typed vendor names).
  //   (b) Cart subtotal (sum of items[].price * quantity, pre-discount)
  //       is >= $500 USD.
  //
  // When both are met, the real carrier rate + handling markup are both
  // zeroed and the service_name is decorated so the customer sees why.
  // Customer still picks Ground vs Priority vs Express — they're all
  // shown at $0 with their respective delivery windows so the pick has
  // meaning. Pre-discount subtotal is by design: Shopify's carrier-
  // service payload doesn't expose post-discount totals.
  //
  // Vendor + threshold both come from CONFIG (top of file).
  const allItemsNaturalSolutions =
    realItems.length > 0 &&
    realItems.every(
      (it) =>
        (it?.vendor || "").trim().toLowerCase() ===
        CONFIG.freeShipping.vendor.toLowerCase(),
    );
  const cartSubtotalUsd =
    realItems.reduce(
      (sum, it) =>
        sum + (Number(it?.price) || 0) * (Number(it?.quantity) || 0),
      0,
    ) / 100;
  const isFreeShipping =
    allItemsNaturalSolutions &&
    cartSubtotalUsd >= CONFIG.freeShipping.thresholdUsd;

  if (isFreeShipping) {
    console.log(
      `[shipping.rates] FREE shipping ELIGIBLE — vendor=NS × ${realItems.length} line(s), subtotal=$${cartSubtotalUsd.toFixed(2)}`,
    );
  }

  // ── 2. Fetch live rates from all configured direct carriers ──────────
  // Handling markup is TIERED by total cart quantity (see `tieredMarkupCents`):
  //   1–2 items → +$2, 3 → +$3, 4+ → +$5.
  // Added on top of every real carrier quote.
  const baseCents = tieredMarkupCents(totalQty);

  // Cart subtotal in CENTS — raw items-sum and its discount-adjusted
  // counterpart. Neither is used for rate math today (fee is removed);
  // both are surfaced in the per-rate breakdown log for observability.
  const rawItemsSumCents = realItems.reduce(
    (sum, it) => sum + (Number(it?.price) || 0) * (Number(it?.quantity) || 0),
    0,
  );
  const cartDiscount = detectCartDiscountCents(rate, realItems);
  const discountCents = cartDiscount.cents;
  const cartSubtotalCents = Math.max(0, rawItemsSumCents - discountCents);

  if (discountCents > 0) {
    console.log(
      `[shipping.rates] applied cart discount detected · rawItemsSum=$${(rawItemsSumCents / 100).toFixed(2)} · discount=−$${(discountCents / 100).toFixed(2)} · discountSource=${cartDiscount.source} · net subtotal=$${(cartSubtotalCents / 100).toFixed(2)}`,
    );
  } else {
    console.log(
      `[shipping.rates] no cart discount detected in payload (source=${cartDiscount.source}); net subtotal=$${(cartSubtotalCents / 100).toFixed(2)}`,
    );
  }

  // ── Product classification (pure tag-based — 2026-07-16) ─────────────
  //
  // Each cart line's packing category is read from a `pack:XXX` tag on
  // the Shopify product (assigned by the merchant in admin). We fetch
  // those tags in one bulk GraphQL call using the product IDs from the
  // carrier-service payload, then classify the cart. If ANY item is
  // missing a valid `pack:` tag we refuse to quote rates — the customer
  // sees "no shipping available" until the merchant tags the product.
  //
  // Rationale: the carrier-service payload does NOT include product tags
  // (verified 2026-07-07 payload dump), so we have to fetch. Empty rates
  // is the deliberate back-pressure signal to force merchant to tag every
  // product before shipping quotes will render.
  const uniqueProductIds = Array.from(
    new Set(
      (realItems || [])
        .map((it) => (it?.product_id != null ? String(it.product_id) : null))
        .filter(Boolean),
    ),
  );
  const tagsByProductId = await fetchProductTagsFromShopify(uniqueProductIds);
  const classification = classifyCart(realItems, tagsByProductId);

  if (classification.missing.length > 0) {
    console.warn(
      `[shipping.rates] ABORT — ${classification.missing.length} cart item(s) missing pack: tag; returning empty rates. Missing:`,
      classification.missing
        .map(
          (m) =>
            `productId=${m.productId} "${m.name}"${m.sku ? ` [${m.sku}]` : ""} tagsFound=[${(m.tagsFound || []).join(", ")}]`,
        )
        .join(" | "),
    );
    return ratesResponse([]);
  }

  const categorySummary = Object.entries(classification.counts)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");
  console.log(
    `[shipping.rates] cart classified → ${categorySummary || "(empty)"}`,
  );
  console.log(
    `[shipping.rates.classification] per-line:`,
    classification.perLine
      .map(
        (l) =>
          `${l.category}${l.quantity > 1 ? `×${l.quantity}` : ""} — ${l.name}${l.sku ? ` [${l.sku}]` : ""} (${l.grams}g)`,
      )
      .join(" | "),
  );

  // ── Box selection + package weight ───────────────────────────────────
  //
  // Pick the smallest box tier that fits the cart's classified contents
  // (see selectBox() docs for the exact priority order). If overflow
  // (nothing fits), we still return a box — the largest tier — flagged
  // so the merchant approval gate can catch it.
  //
  // Package weight = items grams + box tare + packing-material buffer.
  // Sent verbatim to USPS + UPS in the fetch below.
  const { box: selectedBox, overflow: boxOverflow } = selectBox(
    classification.counts,
  );
  const packageWeight = computePackageWeight(realItems, selectedBox);
  console.log(
    `[shipping.rates] box selected: ${selectedBox.name}` +
      ` (${selectedBox.L}×${selectedBox.W}×${selectedBox.H} in, tare ${selectedBox.tareOz}oz)` +
      ` · weight items=${packageWeight.itemsOz}oz + tare=${packageWeight.tareOz}oz` +
      ` + buffer=${packageWeight.bufferOz}oz = ${packageWeight.totalOz}oz` +
      ` (${packageWeight.totalLbs} lbs)` +
      (boxOverflow ? " · OVERFLOW — approval gate should catch this" : ""),
  );

  // Carrier APIs (USPS/UPS) read items[] to compute package weight + box
  // dims. Pass `realItems` so the Processing Fee line — which should be
  // weight=0 but may be misconfigured in Shopify Admin — never inflates
  // the quote. We clone `rate` rather than mutate the original payload.
  const directRates = await fetchDirectCarrierRates(
    {
      ...rate,
      items: realItems,
    },
    { selectedBox, packageWeight },
  );
  if (directRates && directRates.length) {
    // Dedup by (carrier, service) — pick cheapest variant per service.
    const dedup = new Map();
    for (const r of directRates) {
      const code = `${r.carrier}_${r.service}`
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
      if (!dedup.has(code) || dedup.get(code).rateCents > r.rateCents) {
        dedup.set(code, { ...r, code });
      }
    }

    const rates = Array.from(dedup.values()).map((r) => {
      // Free-shipping zeros both the raw carrier rate AND the handling
      // markup. Otherwise: shipping = carrier rate + tiered markup.
      const shippingCents = isFreeShipping ? 0 : r.rateCents + baseCents;

      // Final rate to Shopify = shipping only (carrier rate + handling
      // markup, or $0 when free-shipping fires). Tax is applied by
      // Shopify's own settings on the checkout summary line.
      const finalCents = shippingCents;

      const baseName = `${r.carrier} ${r.service}`.trim();

      // ── Detailed per-rate log ──────────────────────────────────────
      // Compact breakdown of the calculation for THIS shipping option.
      // Search Render logs for `shipping.rates.breakdown` to filter.
      // eslint-disable-next-line no-console
      console.log(
        `[shipping.rates.breakdown] ${baseName}
    ├─ Box selected:         ${selectedBox.name} (${selectedBox.L}×${selectedBox.W}×${selectedBox.H} in)${boxOverflow ? " · OVERFLOW" : ""}
    ├─ Package weight:       ${packageWeight.totalOz} oz (${packageWeight.totalLbs} lbs)
    ├─   items:              ${packageWeight.itemsOz} oz
    ├─   box tare:           ${packageWeight.tareOz} oz
    ├─   packing buffer:     ${packageWeight.bufferOz} oz
    ├─ Raw carrier rate:     $${(r.rateCents / 100).toFixed(2)}
    ├─ Handling markup:      $${(baseCents / 100).toFixed(2)} (tier: ${totalQty <= 2 ? "1-2 items" : totalQty === 3 ? "3 items" : "4+ items"})
    ├─ Free-shipping active: ${isFreeShipping ? "YES → shipping zeroed" : "no"}
    ├─ Raw items sum:        $${(rawItemsSumCents / 100).toFixed(2)}
    ├─ Cart discount:        ${discountCents > 0 ? `−$${(discountCents / 100).toFixed(2)} (source: ${cartDiscount.source})` : "$0.00 (none)"}
    ├─ Cart subtotal (net):  $${(cartSubtotalCents / 100).toFixed(2)}
    └─ Final rate to Shopify: $${(finalCents / 100).toFixed(2)}${isFreeShipping ? " (free)" : " (raw + handling)"}`,
      );

      // Box info surfaced in checkout: service_name gets a compact
      // dimension suffix so the customer sees the package they'll
      // receive; description gets the full box label (Enersync 1oz,
      // UPS mini, etc.). Helps merchant + customer verify the tag-based
      // classifier picked the right box (see `pack:XXX` tags on the
      // product page).
      const boxDims = `${selectedBox.L}×${selectedBox.W}×${selectedBox.H} in`;
      const boxLabel = selectedBox.name
        ? `${selectedBox.name} (${boxDims})`
        : boxDims;

      return {
        service_name: isFreeShipping
          ? `${baseName} (Free shipping · Box ${boxDims})`
          : `${baseName} (incl. handling · Box ${boxDims})`,
        service_code: r.code,
        total_price: String(finalCents), // STRING in cents
        currency: r.currency || "USD",
        description: isFreeShipping
          ? `Complimentary shipping on ${CONFIG.freeShipping.vendor} orders over $${CONFIG.freeShipping.thresholdUsd} · Package: ${boxLabel}`
          : `${r.carrier} ${r.service} (includes handling markup) · Package: ${boxLabel}`,
        ...(r.deliveryDateMin ? { min_delivery_date: r.deliveryDateMin } : {}),
        ...(r.deliveryDateMax ? { max_delivery_date: r.deliveryDateMax } : {}),
      };
    });

    // Cheapest first.
    rates.sort(
      (a, b) =>
        Number.parseInt(a.total_price, 10) - Number.parseInt(b.total_price, 10),
    );

    console.log(
      isFreeShipping
        ? `[shipping.rates] Direct carriers OK: ${rates.length} rate(s) FREE-ship on $${cartSubtotalUsd.toFixed(2)} NS-only cart`
        : `[shipping.rates] Direct carriers OK: ${rates.length} real rate(s), tiered markup=$${baseCents / 100} on ${totalQty} item(s)`,
    );
    return ratesResponse(rates);
  }

  // No live carrier returned rates — credentials missing, API down, or
  // destination unsupported. Return an empty list so Shopify shows "no
  // shipping available" at checkout. We DO NOT quote placeholder prices
  // here; the merchant should fix the credentials or the address.
  console.warn(
    `[shipping.rates] No live carrier rates for ${totalQty} item(s) to ${rate.destination?.postal_code} — returning empty (check USPS/UPS env vars + API status)`,
  );
  return ratesResponse([]);
}
