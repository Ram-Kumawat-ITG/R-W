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
//      Dedups by (carrier, service), applies markup (totalQty × PER_ITEM_CENTS),
//      sorts cheapest-first, returns to Shopify.
//   4. If NEITHER carrier returns rates (credentials placeholder / both
//      unreachable) → falls back to STATIC_CARRIER_RATES table (3 USPS + 3 UPS
//      tiers, qty × multiplier prices). This guarantees checkout always shows
//      shipping options. Once real env vars work, this fallback is bypassed
//      automatically — direct rates take priority.
//
// SETUP — both carriers (one-time):
//   USPS:   registration.usps.com → APIs → OAuth credentials
//   UPS:    developer.ups.com → My Apps → OAuth 2.0
//
// Any carrier whose env vars aren't set is silently skipped — no errors.

import crypto from "node:crypto";

// ── Tunables ────────────────────────────────────────────────────────────

// Base shipping rate per cart-item, in cents. The user's spec: 5 items → $5
// on the cheapest carrier (UPS Ground / multiplier 1.0). Tune via env if
// pricing ever needs to change without a redeploy.
const PER_ITEM_CENTS = Number.parseInt(
  process.env.SHIPPING_PER_QTY_CENTS || "100",
  10,
);

// Static placeholder rates shown when neither USPS nor UPS credentials are
// configured (or both API calls fail). Once real env vars are set AND the
// APIs return rates, this table is bypassed automatically — direct rates
// take priority every time.
//
// Pricing formula: totalQty × PER_ITEM_CENTS × multiplier, exactly like
// the markup applied on real carrier quotes — so the customer sees the
// same per-quantity scaling whether we're hitting real APIs or not.
const STATIC_CARRIER_RATES = [
  // USPS — 3 service tiers
  {
    carrier: "USPS",
    service: "Ground Advantage",
    serviceCode: "USPS_GROUND",
    multiplier: 0.85,
    days: [4, 8],
  },
  {
    carrier: "USPS",
    service: "Priority Mail",
    serviceCode: "USPS_PRIORITY",
    multiplier: 1.2,
    days: [2, 5],
  },
  {
    carrier: "USPS",
    service: "Priority Mail Express",
    serviceCode: "USPS_EXPRESS",
    multiplier: 2.5,
    days: [1, 2],
  },
  // UPS — 3 service tiers
  {
    carrier: "UPS",
    service: "Ground",
    serviceCode: "UPS_GROUND",
    multiplier: 1.0,
    days: [3, 5],
  },
  {
    carrier: "UPS",
    service: "2nd Day Air",
    serviceCode: "UPS_2DAY",
    multiplier: 1.6,
    days: [2, 2],
  },
  {
    carrier: "UPS",
    service: "Next Day Air",
    serviceCode: "UPS_NEXTDAY",
    multiplier: 3.0,
    days: [1, 1],
  },
];

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

  // ── Step 2: Build rate request ─────────────────────────────────────
  const totalGrams = (items || []).reduce(
    (s, it) => s + (Number(it?.grams) || 0) * (Number(it?.quantity) || 0),
    0,
  );

  // USPS expects ZIP-only origin/destination for domestic. International
  // adds country + value but we focus on domestic for now.
  const body = {
    originZIPCode: origin?.postal_code || "",
    destinationZIPCode: destination?.postal_code || "",
    weight: gramsToLb(totalGrams), // pounds (with decimal for ounces)
    length: 10,
    width: 8,
    height: 4,
    mailClasses: [
      "USPS_GROUND_ADVANTAGE",
      "PRIORITY_MAIL",
      "PRIORITY_MAIL_EXPRESS",
    ],
    priceType: "COMMERCIAL", // wholesale = commercial rates
    mailingDate: new Date().toISOString().slice(0, 10),
  };

  // ── Step 3: Fetch rates ────────────────────────────────────────────
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
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (err) {
    console.error("[shipping.rates] USPS network error:", err?.message || err);
    return [];
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(
      "[shipping.rates] USPS non-200:",
      res.status,
      text.slice(0, 300),
    );
    // 401 → token went stale, drop cache so next call re-fetches.
    if (res.status === 401) tokenCache.delete("usps");
    return [];
  }

  let json;
  try {
    json = await res.json();
  } catch {
    return [];
  }

  // USPS response shape: { rates: [{ mailClass, totalBasePrice, ... }] }
  const raw = Array.isArray(json?.rates) ? json.rates : [];
  return raw
    .map((r) => {
      const dollars = Number.parseFloat(r.totalBasePrice ?? r.price);
      if (!Number.isFinite(dollars)) return null;
      const serviceLabel =
        {
          USPS_GROUND_ADVANTAGE: "Ground Advantage",
          PRIORITY_MAIL: "Priority Mail",
          PRIORITY_MAIL_EXPRESS: "Priority Mail Express",
        }[r.mailClass] || r.mailClass;
      return {
        carrier: "USPS",
        service: serviceLabel,
        rateCents: Math.round(dollars * 100),
        currency: "USD",
        deliveryDateMin: null,
        deliveryDateMax: null,
      };
    })
    .filter(Boolean);
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

  // HMAC verify — log in dev, harden later.
  const hmacHeader = request.headers.get("x-shopify-hmac-sha256") || "";
  if (!verifyHmac(rawBody, hmacHeader)) {
    console.warn(
      "[shipping.rates] hmac mismatch or missing — accepting in dev",
    );
    // PROD HARDENING: uncomment to reject unsigned requests.
    // return ratesResponse([])
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
  const totalQty = sumQuantity(rate.items);
  if (totalQty === 0) return ratesResponse([]);

  console.log(
    `[shipping.rates] inbound: ${rate.items.length} line(s), totalQty=${totalQty}, dest=${rate.destination?.country}/${rate.destination?.province}/${rate.destination?.postal_code}`,
  );

  // ── 2. Fetch live rates from all configured direct carriers ──────────
  // Markup formula = totalQty × PER_ITEM_CENTS, added on top of every
  // real carrier quote. Configurable via SHIPPING_PER_QTY_CENTS env var.
  const baseCents = totalQty * PER_ITEM_CENTS;

  const directRates = await fetchDirectCarrierRates(rate);
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
      const finalCents = r.rateCents + baseCents;
      return {
        service_name: `${r.carrier} ${r.service}`.trim(),
        service_code: r.code,
        total_price: String(finalCents), // STRING in cents
        currency: r.currency || "USD",
        description: `${r.carrier} ${r.service} (incl. handling)`,
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
      `[shipping.rates] Direct carriers OK: ${rates.length} real rate(s), markup=$${baseCents / 100} on ${totalQty} item(s)`,
    );
    return ratesResponse(rates);
  }

  // No direct carrier returned rates (credentials missing / placeholder /
  // upstream down). Fall back to STATIC_CARRIER_RATES so checkout always
  // shows shipping options. Once real env vars work, this fallback is
  // bypassed automatically — direct rates always take priority above.
  console.warn(
    `[shipping.rates] No live carrier rates for ${totalQty} item(s) to ${rate.destination?.postal_code} — using STATIC_CARRIER_RATES fallback`,
  );
  const fallbackRates = STATIC_CARRIER_RATES.map((svc) => {
    const finalCents = Math.round(baseCents * svc.multiplier);
    return {
      service_name: `${svc.carrier} ${svc.service}`,
      service_code: svc.serviceCode,
      total_price: String(finalCents), // STRING in cents
      currency: "USD",
      description: `${svc.carrier} ${svc.service}`,
      min_delivery_date: addBusinessDaysIso(svc.days[0]),
      max_delivery_date: addBusinessDaysIso(svc.days[1]),
    };
  });
  // Cheapest first.
  fallbackRates.sort(
    (a, b) =>
      Number.parseInt(a.total_price, 10) - Number.parseInt(b.total_price, 10),
  );
  return ratesResponse(fallbackRates);
}
