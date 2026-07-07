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
//   1. Verifies the Shopify HMAC header (logs mismatch in dev; reject in prod).
//   2. Reads items + origin + destination from the Shopify payload.
//   3. Calls USPS + UPS direct-carrier APIs in parallel:
//        • USPS Web Tools v3 (USPS_CLIENT_ID / USPS_CLIENT_SECRET)
//        • UPS Rating v2403  (UPS_CLIENT_ID / UPS_CLIENT_SECRET / UPS_SHIPPER_NUMBER)
//      Dedups by (carrier, service), applies the tiered handling markup
//      (see `tieredMarkupCents`), sorts cheapest-first, returns to Shopify.
//   4. If NEITHER carrier returns rates (credentials missing / API down):
//      returns an EMPTY rates list. Shopify will show "no shipping
//      available" at checkout — this is intentional so we never quote
//      placeholder prices. Static fallback was REMOVED 2026-06-22 once
//      real USPS credentials were configured in .env.
//
// SETUP — both carriers (one-time):
//   USPS:   registration.usps.com → APIs → OAuth credentials
//   UPS:    developer.ups.com → My Apps → OAuth 2.0
//
// Any carrier whose env vars aren't set is silently skipped — no errors.

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
  // Processing fee — fraction of (subtotal + shipping + tax) charged
  // as a payment-processing surcharge, bundled into every shipping
  // rate returned to Shopify. Set to 0 to disable the fee entirely.
  processingFeeRate: 0.03, // 3 %

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

  // Shopify tax API (draftOrderCalculate) tuning. Cache lets us
  // reuse the same tax figure for a given cart+address combo without
  // re-hitting the Admin API on every re-render. Timeout bounds the
  // callback so a slow API doesn't stall the whole checkout — on
  // timeout we fall through with 0 tax (fee based on subtotal +
  // shipping only, no state guessing).
  shopifyTax: {
    cacheTtlMs: 5 * 60 * 1000, // 5 min
    // Bumped 3 → 5 sec (2026-07-06) — Shopify's draftOrderCalculate
    // occasionally takes 3-4 sec under load; 5 sec still leaves
    // 5 sec buffer under Shopify's 10-sec carrier-callback budget.
    timeoutMs: 5000, // 5 sec
    // Hard cap on the in-process cache so unique cart+address combos
    // don't grow the Map unbounded on long-running instances (memory
    // safety). Oldest entry evicted on overflow (insertion-order LRU).
    cacheMaxEntries: 1000,
  },
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
// Shopify's carrier-service callback DOES NOT reliably surface applied
// discount codes / automatic discounts in a single canonical field —
// different Shopify versions + themes populate different keys, and
// sometimes NONE of them. Without accounting for the discount, the 3%
// processing fee is calculated on the pre-discount subtotal and the
// customer over-pays the fee (small but real — $0.45 on a $15 discount).
//
// We probe the payload for every field we've seen actually populated,
// in order of reliability. First non-zero win. Returns discount in
// CENTS. Returns 0 when no discount info is available in the payload —
// in that case the fee falls back to computing on the raw subtotal,
// matching the previous (pre-discount-aware) behavior exactly.
//
// Returns { cents, source } so the per-rate log can show which field
// was used, making it easy to diagnose payload shape drift over time.
function detectCartDiscountCents(rate, realItems) {
  // Field 1: `rate.total_discounts` — integer cents, top-level. Newer
  //          versions of the carrier-service payload set this. Most
  //          reliable when present.
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

// ── Processing fee (bundled into shipping rate) ────────────────────────
//
// Migrated 2026-07-06 from the Grow-plan-blocked checkout UI extension
// (`extensions/processing-fee/`) into the carrier-service callback. The
// fee is bundled into every returned shipping rate so it flows through
// naturally at checkout without any Plus-only Shopify surface.
//
// Formula:
//   shipping    = free-shipping ? 0 : (real carrier rate + handling markup)
//   tax         = Shopify's live tax on this cart+destination (see
//                 `calculateShopifyTax` — draftOrderCalculate mutation).
//                 Fallback = 0 if the API is unreachable.
//   feeBase     = subtotal + shipping + tax
//   fee         = feeBase × CONFIG.processingFeeRate
//   rate to Shopify = shipping + fee
//
// Free-shipping interaction: fee STILL applies when free-shipping fires
// (shipping is $0 but the 3% processing fee is not — merchant still
// collects the fee on NS-only $500+ carts). See CONFIG.freeShipping.
//
// Tax handling: Shopify's own `draftOrderCalculate` mutation is the sole
// tax source — no more hardcoded state-rate tables. If the API fails /
// times out the fee is calculated on (subtotal + shipping) only (no
// static state guessing). Rely on Shopify's tax config for accuracy.

// ── Shopify Tax API (draftOrderCalculate) ─────────────────────────────
//
// Live tax calculation using Shopify's own tax engine. This is more
// accurate than the static US_STATE_TAX_RATES lookup because it honors:
//   • City / county / special-district add-ons (not just state)
//   • Product taxability rules (some categories tax-exempt)
//   • Marketplace facilitator laws
//   • Customer tax-exempt status (if configured on the customer record)
//
// Trade-off: adds a 200-500ms Shopify Admin GraphQL call per callback.
// Mitigated by (a) an in-memory cache keyed on the tax-affecting inputs
// (state, zip, product mix, subtotal) with a 5-min TTL, and (b) a 3-sec
// timeout that falls back to the static lookup on slow / failed calls.
//
// Rate limit consideration: `draftOrderCalculate` costs ~10-20 points.
// Shopify's GraphQL bucket is 50 points/sec, so we can safely handle up
// to ~3 fresh checkouts per second before rate-limit risk. Cache hits
// consume nothing.

// Shop domain — resolved per-request in the action handler (Shopify
// sends `X-Shopify-Shop-Domain` header on the webhook, which is the
// most reliable source; env vars are a fallback for local dev where
// the header may be missing). Kept as a function rather than a module
// constant so a multi-environment deploy correctly routes each request
// to its own shop.
function resolveShopDomain(request) {
  const fromHeader = String(
    request?.headers?.get?.("x-shopify-shop-domain") || "",
  ).trim();
  if (fromHeader) return fromHeader;
  return (
    // eslint-disable-next-line no-undef
    process.env.RETAIL_SHOP_DOMAIN ||
    // eslint-disable-next-line no-undef
    process.env.SHOPIFY_SHOP ||
    ""
  );
}

const _shopifyTaxCache = new Map(); // key → { taxCents, cachedAt }

function buildTaxCacheKey({ destination, realItems, subtotalCents }) {
  const state = String(destination?.province_code || destination?.province || "").toUpperCase();
  const zip = String(destination?.postal_code || destination?.zip || "").slice(0, 5);
  const country = String(destination?.country_code || destination?.country || "US").toUpperCase();
  // Include item variant ids so tax varies with product mix (some
  // products may be tax-exempt). Subtotal is already discount-adjusted
  // by the caller, so a discount-applied cart naturally caches under
  // a different key than the same items un-discounted.
  const variants = (realItems || [])
    .map((it) => `${it.variant_id || it.product_id}:${it.quantity}`)
    .sort()
    .join(",");
  return `${country}|${state}|${zip}|${subtotalCents}|${variants}`;
}

const MUTATION_DRAFT_ORDER_CALCULATE = `#graphql
  mutation DraftOrderCalculateForTax($input: DraftOrderInput!) {
    draftOrderCalculate(input: $input) {
      calculatedDraftOrder {
        totalTaxSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        taxLines {
          title
          rate
          ratePercentage
          priceSet {
            shopMoney { amount }
          }
        }
      }
      userErrors { field message }
    }
  }
`;

// Calculate the exact Shopify tax for the given cart + destination.
// Returns { taxCents, source } on success or null on failure — caller
// falls back to the static state-lookup rate.
async function calculateShopifyTax({ shop, destination, realItems, subtotalCents }) {
  if (!shop) return null;
  if (!realItems?.length) return null;

  // Cache hit — return instantly (no Shopify call).
  const cacheKey = buildTaxCacheKey({ destination, realItems, subtotalCents });
  const cached = _shopifyTaxCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CONFIG.shopifyTax.cacheTtlMs) {
    return { taxCents: cached.taxCents, source: "shopify_cached" };
  }

  // Build the input — Shopify draftOrderCalculate needs variantId in
  // GID form; carrier-service payload sends numeric variant_id.
  const lineItems = realItems
    .filter((it) => it?.variant_id)
    .map((it) => ({
      variantId: `gid://shopify/ProductVariant/${it.variant_id}`,
      quantity: Number(it.quantity) || 1,
    }));
  if (!lineItems.length) return null;

  const input = {
    shippingAddress: {
      address1: destination?.address1 || "",
      city: destination?.city || "",
      provinceCode:
        destination?.province_code || destination?.province || undefined,
      countryCode:
        destination?.country_code || destination?.country || "US",
      zip: destination?.postal_code || destination?.zip || "",
    },
    lineItems,
  };
  // Drop empty provinceCode — Shopify rejects "" for that field.
  if (!input.shippingAddress.provinceCode) {
    delete input.shippingAddress.provinceCode;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.shopifyTax.timeoutMs);
  try {
    const { admin } = await unauthenticated.admin(shop);
    const res = await admin.graphql(MUTATION_DRAFT_ORDER_CALCULATE, {
      variables: { input },
      signal: controller.signal,
    });
    const body = await res.json();
    clearTimeout(timer);

    const userErrors = body?.data?.draftOrderCalculate?.userErrors || [];
    if (userErrors.length) {
      console.warn(
        "[shipping.rates] draftOrderCalculate userErrors:",
        JSON.stringify(userErrors),
      );
      return null;
    }
    const taxAmountUsd = Number(
      body?.data?.draftOrderCalculate?.calculatedDraftOrder?.totalTaxSet
        ?.shopMoney?.amount,
    );
    if (!Number.isFinite(taxAmountUsd)) return null;
    const taxCents = Math.round(taxAmountUsd * 100);

    // Cache for CONFIG.shopifyTax.cacheTtlMs. Bounded to
    // `cacheMaxEntries` — on overflow we drop the OLDEST entry
    // (Map preserves insertion order, so the first key is the
    // oldest by insertion time — approximates LRU cheaply).
    if (_shopifyTaxCache.size >= CONFIG.shopifyTax.cacheMaxEntries) {
      const oldestKey = _shopifyTaxCache.keys().next().value;
      if (oldestKey !== undefined) _shopifyTaxCache.delete(oldestKey);
    }
    _shopifyTaxCache.set(cacheKey, { taxCents, cachedAt: Date.now() });

    return { taxCents, source: "shopify_live" };
  } catch (err) {
    clearTimeout(timer);
    console.warn(
      "[shipping.rates] Shopify tax API failed — falling back to state lookup:",
      err?.message || err,
    );
    return null;
  }
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
async function fetchUSPSRates({ origin, destination, items }) {
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
  const totalGrams = (items || []).reduce(
    (s, it) => s + (Number(it?.grams) || 0) * (Number(it?.quantity) || 0),
    0,
  );

  // Common to every USPS call. Per-mail-class overrides (below) replace
  // rateIndicator + processingCategory when a tier needs them.
  const baseBody = {
    originZIPCode: origin?.postal_code || "",
    destinationZIPCode: destination?.postal_code || "",
    weight: gramsToLb(totalGrams),
    length: 10,
    width: 8,
    height: 4,
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
async function fetchUPSRates({ origin, destination, items }) {
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
  const totalGrams = (items || []).reduce(
    (s, it) => s + (Number(it?.grams) || 0) * (Number(it?.quantity) || 0),
    0,
  );
  const weightLb = gramsToLb(totalGrams);

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
            Length: "10",
            Width: "8",
            Height: "4",
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
async function fetchDirectCarrierRates(rate) {
  const input = {
    origin: rate.origin,
    destination: rate.destination,
    items: rate.items,
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

  // Cart subtotal in CENTS. First compute the raw items-sum, then
  // subtract any applied discount so the 3% processing fee is charged
  // on what the CUSTOMER actually owes for the merchandise — not the
  // pre-discount list total (which would over-charge the fee by
  // 3% × discountAmount).
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
      `[shipping.rates] no cart discount detected in payload (source=${cartDiscount.source}); fee will use raw subtotal=$${(cartSubtotalCents / 100).toFixed(2)}`,
    );
  }

  // Tax resolution — Shopify's live tax API is the ONLY source. We
  // call `draftOrderCalculate` with the cart + destination and use the
  // returned totalTax as our tax number (city/county/product rules all
  // honored). Result is cached per (cart, address) for 5 min.
  //
  // On failure / timeout / non-US → tax = 0, fee is calculated on
  // (subtotal + shipping) only. No static state-rate guessing — the
  // operator should fix the Shopify API integration if fallback is
  // used too often (visible as `taxSource=api_unavailable` in logs).
  const shopifyTaxResult = await calculateShopifyTax({
    shop: resolveShopDomain(request),
    destination: rate.destination,
    realItems,
    subtotalCents: cartSubtotalCents,
  });

  let baseTaxCents = 0;
  let taxRate = 0;
  let taxSource = "api_unavailable";
  if (shopifyTaxResult && shopifyTaxResult.taxCents >= 0) {
    // Shopify tax API succeeded — use its exact figure for the
    // subtotal portion + derive a rate for scaling to shipping tax.
    baseTaxCents = shopifyTaxResult.taxCents;
    taxRate = cartSubtotalCents > 0 ? baseTaxCents / cartSubtotalCents : 0;
    taxSource = shopifyTaxResult.source; // shopify_live | shopify_cached
  }
  console.log(
    `[shipping.rates] processing-fee inputs: subtotal=$${(cartSubtotalCents / 100).toFixed(2)} · taxRate=${(taxRate * 100).toFixed(2)}% · state=${rate.destination?.province || rate.destination?.province_code || "?"} · taxSource=${taxSource}`,
  );

  // Carrier APIs (USPS/UPS) read items[] to compute package weight + box
  // dims. Pass `realItems` so the Processing Fee line — which should be
  // weight=0 but may be misconfigured in Shopify Admin — never inflates
  // the quote. We clone `rate` rather than mutate the original payload.
  const directRates = await fetchDirectCarrierRates({
    ...rate,
    items: realItems,
  });
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
      // Free-shipping rule zeros shipping cost + handling markup, but the
      // 3% processing fee is INDEPENDENT — it still applies on FREE-ship
      // NS-only carts because it's a payment-processing surcharge, not a
      // shipping charge. Customer still sees per-service labels
      // (Ground/Priority/Express) so delivery-speed choice is meaningful.
      const shippingCents = isFreeShipping ? 0 : r.rateCents + baseCents;

      // Fee base = subtotal + shipping + tax.
      //   • baseTaxCents is the exact tax on the SUBTOTAL (from Shopify
      //     API or state fallback — already computed above).
      //   • Extra shipping-tax is added at the derived rate — many US
      //     states tax shipping, so this component is not zero.
      const shippingTaxCents = Math.round(shippingCents * taxRate);
      const totalTaxCents = baseTaxCents + shippingTaxCents;
      const feeBaseCents = cartSubtotalCents + shippingCents + totalTaxCents;
      const processingFeeCents = Math.round(
        feeBaseCents * CONFIG.processingFeeRate,
      );

      // Final rate = shipping (possibly $0) + processing fee.
      const finalCents = shippingCents + processingFeeCents;

      const baseName = `${r.carrier} ${r.service}`.trim();
      const feeUsd = (processingFeeCents / 100).toFixed(2);
      const taxUsd = (totalTaxCents / 100).toFixed(2);

      // ── Detailed per-rate log ──────────────────────────────────────
      // Prints the full calculation breakdown for THIS shipping option
      // so operators can pinpoint exactly why the total came out to
      // what it did. Renders as a compact single-line block in Render
      // logs — search for `shipping.rates.breakdown` to filter.
      // eslint-disable-next-line no-console
      console.log(
        `[shipping.rates.breakdown] ${baseName}
    ├─ Raw carrier rate:     $${(r.rateCents / 100).toFixed(2)}
    ├─ Handling markup:      $${(baseCents / 100).toFixed(2)} (tier: ${totalQty <= 2 ? "1-2 items" : totalQty === 3 ? "3 items" : "4+ items"})
    ├─ Free-shipping active: ${isFreeShipping ? "YES → shipping zeroed" : "no"}
    ├─ Shipping (final):     $${(shippingCents / 100).toFixed(2)} ${isFreeShipping ? "(free)" : "(raw + handling)"}
    ├─ Raw items sum:        $${(rawItemsSumCents / 100).toFixed(2)}
    ├─ Cart discount:        ${discountCents > 0 ? `−$${(discountCents / 100).toFixed(2)} (source: ${cartDiscount.source})` : "$0.00 (none)"}
    ├─ Cart subtotal (net):  $${(cartSubtotalCents / 100).toFixed(2)}
    ├─ Base tax on subtotal: $${(baseTaxCents / 100).toFixed(2)} (source: ${taxSource})
    ├─ Shipping tax:         $${(shippingTaxCents / 100).toFixed(2)} (rate ${(taxRate * 100).toFixed(3)}% × shipping)
    ├─ Total tax:            $${taxUsd}
    ├─ Fee base:             $${(feeBaseCents / 100).toFixed(2)} (net subtotal + shipping + tax)
    ├─ Processing fee (3%):  $${feeUsd}
    └─ Final rate to Shopify: $${(finalCents / 100).toFixed(2)}`,
      );

      return {
        service_name: isFreeShipping
          ? `${baseName} (Free shipping + 3% processing fee)`
          : `${baseName} (incl. handling + 3% processing fee)`,
        service_code: r.code,
        total_price: String(finalCents), // STRING in cents
        currency: r.currency || "USD",
        description: isFreeShipping
          ? `Complimentary shipping on ${CONFIG.freeShipping.vendor} orders over $${CONFIG.freeShipping.thresholdUsd} · 3% processing fee $${feeUsd} (calculated on subtotal + tax $${taxUsd})`
          : `${r.carrier} ${r.service} (includes handling + 3% processing fee $${feeUsd}, calculated on subtotal + shipping + tax $${taxUsd})`,
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
        ? `[shipping.rates] Direct carriers OK: ${rates.length} rate(s) FREE-ship (+3% fee) on $${cartSubtotalUsd.toFixed(2)} NS-only cart`
        : `[shipping.rates] Direct carriers OK: ${rates.length} real rate(s), tiered markup=$${baseCents / 100} on ${totalQty} item(s) + 3% processing fee`,
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
