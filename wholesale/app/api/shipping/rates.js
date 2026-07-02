// Shopify Carrier Service callback — wholesale store.
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
//        • USPS Web Tools v3 (USPS_CLIENT_ID / USPS_CLIENT_SECRET) — fans out
//          one call per mail class (Ground Advantage / Priority / Express /
//          First-Class Package) so each tier's required rateIndicator +
//          processingCategory combo is sent correctly.
//        • UPS Rating v2403 (UPS_CLIENT_ID / UPS_CLIENT_SECRET / UPS_SHIPPER_NUMBER)
//      Dedups by (carrier, service), applies the tiered handling markup
//      (see `tieredMarkupCents` below), sorts cheapest-first, returns to Shopify.
//   4. If NEITHER carrier returns rates (credentials missing / both APIs
//      unreachable) → returns an EMPTY rates list. Shopify shows "no
//      shipping available" at checkout; the merchant must fix the
//      credentials or the address. Static fallback was REMOVED 2026-06-22
//      once real USPS credentials were configured in .env.
//
// SETUP — both carriers (one-time):
//   USPS:   registration.usps.com → APIs → OAuth credentials
//   UPS:    developer.ups.com → My Apps → OAuth 2.0
//
// Any carrier whose env vars aren't set is silently skipped — no errors.

import crypto from 'node:crypto'

// ── Tunables ────────────────────────────────────────────────────────────

// Wholesale handling markup, tiered by total cart quantity. The product
// owner's spec (revised 2026-06-25 — the prior 4-item $4 tier was removed,
// 4+ items now charges a flat $5 capped fee):
//
//   1–2 products → +$2
//   3 products   → +$3
//   4 or more    → +$5
//
// Cents on the wire. The same formula is mirrored in the retail handler
// (ns-retail/app/api/shipping/rates.js) so both stores quote consistent
// handling, and the drop-ship reverse-calc in
// services/dropship/dropship.service.js strips this exact tier from
// retail-cloned wholesale orders.
function tieredMarkupCents(qty) {
  if (qty <= 2) return 200
  if (qty === 3) return 300
  return 500
}

// ── Helpers ─────────────────────────────────────────────────────────────

function ratesResponse(rates) {
  // Shopify expects the bare `{ rates: [...] }` shape — NO envelope wrapping.
  return new Response(JSON.stringify({ rates: rates || [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function verifyHmac(rawBody, headerValue) {
  const secret = process.env.SHOPIFY_API_SECRET
  if (!secret || !headerValue) return false
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64')
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(headerValue, 'utf8'),
    )
  } catch {
    return false
  }
}

function sumQuantity(items) {
  return (items || []).reduce(
    (sum, it) => sum + (Number(it?.quantity) || 0),
    0,
  )
}

// ── Processing Fee line detection ──────────────────────────────────────
//
// The Checkout UI extension (extensions/checkout-ui/src/Checkout.jsx) adds
// a "Processing Fee" cart line item (variant priced at $0.01, quantity =
// cents-of-fee). When Shopify POSTs the carrier-service callback, this
// line appears in `rate.items[]` alongside the real merchandise. We MUST
// exclude it from:
//   • totalQty   → otherwise the fee's 9095-unit quantity pushes the
//                  handling-markup tier to "4+ items → $5" on every cart
//   • vendor check → free-shipping rule requires every line vendor be
//                    "Natural Solutions"; the fee product may have a
//                    different vendor (or none) and would silently
//                    disqualify NS-only carts
//   • subtotalUSD → the fee adds to the $500 free-shipping threshold;
//                   should be the customer's REAL spend, not what we
//                   tacked on top
//   • carrier weight calc → the fee variant should be weight=0 but
//                           depending on Shopify Admin config it may
//                           carry default weight that inflates carrier
//                           quotes
//
// Detection: title regex — since 2026-07-01 the extension provisions
// exact-price fee variants on-demand (see extensions/checkout-ui/src/
// Checkout.jsx + /api/cdo/fee-variant), so there is no single stable
// variant_id to match anymore. Every fee variant is created on the
// same "Processing Fee" product with title starting "Processing Fee",
// so the regex is authoritative. The variant_id fast-path is kept as
// a defensive optimization but defaults to null.
const PROCESSING_FEE_VARIANT_ID = null
const PROCESSING_FEE_TITLE_RE = /processing\s*fee/i

function isProcessingFeeItem(it) {
  if (!it) return false
  if (
    PROCESSING_FEE_VARIANT_ID != null &&
    Number(it.variant_id) === PROCESSING_FEE_VARIANT_ID
  ) {
    return true
  }
  const name = String(it.name || it.title || '').trim()
  return PROCESSING_FEE_TITLE_RE.test(name)
}

// Add N business days from today and return an ISO date string —
// Shopify shows this next to the price in the customer's checkout view.
function addBusinessDaysIso(daysFromToday) {
  const d = new Date()
  d.setDate(d.getDate() + Math.max(0, daysFromToday))
  return d.toISOString()
}

// USPS / UPS / FedEx APIs want pounds (LB) for weight. DHL uses kg —
// converted inline within fetchDHLRates.
function gramsToLb(grams) {
  return Math.max(0.1, Math.round(((Number(grams) || 0) / 453.592) * 10) / 10)
}

// In-memory OAuth token cache keyed by carrier. Most direct-carrier APIs
// use OAuth client_credentials and return a token with ~1h TTL. We cache
// it across requests so we don't burn one auth call per checkout.
const tokenCache = new Map()
function getCachedToken(key) {
  const entry = tokenCache.get(key)
  if (!entry) return null
  if (Date.now() >= entry.expiresAt) {
    tokenCache.delete(key)
    return null
  }
  return entry.token
}
function setCachedToken(key, token, ttlSeconds) {
  // Refresh 5 min before actual expiry to dodge edge-case races.
  tokenCache.set(key, {
    token,
    expiresAt: Date.now() + (Math.max(60, ttlSeconds - 300) * 1000),
  })
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
  const clientId = process.env.USPS_CLIENT_ID
  const clientSecret = process.env.USPS_CLIENT_SECRET
  if (!clientId || !clientSecret) return []

  const base = process.env.USPS_API_BASE || 'https://apis.usps.com'

  // ── Step 1: Get / reuse OAuth token ────────────────────────────────
  let token = getCachedToken('usps')
  if (!token) {
    try {
      const tokenRes = await fetch(`${base}/oauth2/v3/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
      })
      if (!tokenRes.ok) {
        console.error('[shipping.rates] USPS oauth failed:', tokenRes.status)
        return []
      }
      const tokenJson = await tokenRes.json()
      token = tokenJson.access_token
      setCachedToken('usps', token, Number(tokenJson.expires_in) || 3600)
    } catch (err) {
      console.error('[shipping.rates] USPS oauth error:', err?.message || err)
      return []
    }
  }

  // ── Step 2: Build common rate request payload ──────────────────────
  // USPS v3 `/prices/v3/base-rates/search` quotes ONE mail class per
  // call. To show multiple tiers we fan out one parallel call per class.
  //
  // Required fields (per USPS OpenAPI schema — missing any one returns
  // HTTP 400 "OASValidation … Object has missing required fields"):
  //   originZIPCode, destinationZIPCode, weight, length, width, height,
  //   mailClass, processingCategory, rateIndicator,
  //   destinationEntryFacilityType, priceType, mailingDate.
  const totalGrams = (items || []).reduce(
    (s, it) => s + (Number(it?.grams) || 0) * (Number(it?.quantity) || 0),
    0,
  )

  const baseBody = {
    originZIPCode: origin?.postal_code || '',
    destinationZIPCode: destination?.postal_code || '',
    weight: gramsToLb(totalGrams),
    length: 10,
    width: 8,
    height: 4,
    destinationEntryFacilityType: 'NONE',
    priceType: 'COMMERCIAL', // wholesale = commercial rates
    mailingDate: new Date().toISOString().slice(0, 10),
  }

  // Each mail class has its own valid (rateIndicator, processingCategory)
  // combo. USPS rejects mismatches with "Could not find working sku from
  // SSF ingredients" — these values come from the USPS Prices v3 product
  // catalogue and are not interchangeable across classes.
  //
  //   SP / MACHINABLE  — Single Piece, machinable parcel
  //                      (Ground Advantage, Priority Mail, First-Class Package)
  //   PA / MACHINABLE  — Priority Alert (Priority Mail Express)
  //
  // If any class returns 400 with a "no sku" error, USPS doesn't sell
  // that combo for the given weight/zone — that class is silently dropped
  // from the response so the other classes still show.
  const MAIL_CLASSES = [
    {
      code: 'USPS_GROUND_ADVANTAGE',
      label: 'Ground Advantage',
      rateIndicator: 'SP',
      processingCategory: 'MACHINABLE',
    },
    {
      code: 'PRIORITY_MAIL',
      label: 'Priority Mail',
      rateIndicator: 'SP',
      processingCategory: 'MACHINABLE',
    },
    {
      code: 'PRIORITY_MAIL_EXPRESS',
      label: 'Priority Mail Express',
      rateIndicator: 'PA',
      processingCategory: 'MACHINABLE',
    },
    {
      code: 'FIRST-CLASS_PACKAGE_SERVICE',
      label: 'First-Class Package',
      rateIndicator: 'SP',
      processingCategory: 'MACHINABLE',
    },
  ]

  // ── Step 3: One call per mail class, in parallel ───────────────────
  async function fetchOne({ code, label, rateIndicator, processingCategory }) {
    let res
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      res = await fetch(`${base}/prices/v3/base-rates/search`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          ...baseBody,
          mailClass: code,
          rateIndicator,
          processingCategory,
        }),
        signal: controller.signal,
      })
      clearTimeout(timeout)
    } catch (err) {
      console.error(`[shipping.rates] USPS ${code} network error:`, err?.message || err)
      return null
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error(`[shipping.rates] USPS ${code} non-200:`, res.status, text.slice(0, 300))
      if (res.status === 401) tokenCache.delete('usps')
      return null
    }

    let json
    try {
      json = await res.json()
    } catch {
      return null
    }

    // v3 base-rates/search response: { totalBasePrice: 5.50, rates: [...], ... }
    // Top-level totalBasePrice is the cheapest match; we use that.
    const dollars = Number.parseFloat(json?.totalBasePrice ?? json?.rates?.[0]?.price)
    if (!Number.isFinite(dollars)) return null
    return {
      carrier: 'USPS',
      service: label,
      rateCents: Math.round(dollars * 100),
      currency: 'USD',
      deliveryDateMin: null,
      deliveryDateMax: null,
    }
  }

  const results = await Promise.all(MAIL_CLASSES.map(fetchOne))
  return results.filter(Boolean)
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
  const clientId = process.env.UPS_CLIENT_ID
  const clientSecret = process.env.UPS_CLIENT_SECRET
  const shipperNumber = process.env.UPS_SHIPPER_NUMBER
  if (!clientId || !clientSecret || !shipperNumber) return []

  const base = process.env.UPS_API_BASE || 'https://onlinetools.ups.com'

  // ── Step 1: OAuth token (cached) ────────────────────────────────
  let token = getCachedToken('ups')
  if (!token) {
    try {
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
      const tokenRes = await fetch(`${base}/security/v1/oauth/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: 'grant_type=client_credentials',
      })
      if (!tokenRes.ok) {
        console.error('[shipping.rates] UPS oauth failed:', tokenRes.status)
        return []
      }
      const tokenJson = await tokenRes.json()
      token = tokenJson.access_token
      setCachedToken('ups', token, Number(tokenJson.expires_in) || 14400)
    } catch (err) {
      console.error('[shipping.rates] UPS oauth error:', err?.message || err)
      return []
    }
  }

  // ── Step 2: Build rate request ──────────────────────────────────
  const totalGrams = (items || []).reduce(
    (s, it) => s + (Number(it?.grams) || 0) * (Number(it?.quantity) || 0),
    0,
  )
  const weightLb = gramsToLb(totalGrams)

  const addr = (a) => ({
    AddressLine: [a?.address1 || '', a?.address2 || ''].filter(Boolean),
    City: a?.city || '',
    StateProvinceCode: a?.province_code || a?.province || '',
    PostalCode: a?.postal_code || '',
    CountryCode: a?.country_code || a?.country || 'US',
  })

  const body = {
    RateRequest: {
      Request: { RequestOption: 'Shop', TransactionReference: { CustomerContext: 'NS Wholesale checkout' } },
      Shipment: {
        Shipper: {
          Name: 'NS Wholesale',
          ShipperNumber: shipperNumber,
          Address: addr(origin),
        },
        ShipTo: { Name: 'Customer', Address: addr(destination) },
        ShipFrom: { Name: 'NS Wholesale', Address: addr(origin) },
        Package: {
          PackagingType: { Code: '02', Description: 'Customer Supplied' },
          Dimensions: {
            UnitOfMeasurement: { Code: 'IN', Description: 'Inches' },
            Length: '10', Width: '8', Height: '4',
          },
          PackageWeight: {
            UnitOfMeasurement: { Code: 'LBS', Description: 'Pounds' },
            Weight: String(weightLb),
          },
        },
      },
    },
  }

  // ── Step 3: Fetch rates ─────────────────────────────────────────
  let res
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    res = await fetch(`${base}/api/rating/v2403/Shop`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        transId: `ns-${Date.now()}`,
        transactionSrc: 'NS_Wholesale',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    clearTimeout(timeout)
  } catch (err) {
    console.error('[shipping.rates] UPS network error:', err?.message || err)
    return []
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.error('[shipping.rates] UPS non-200:', res.status, text.slice(0, 300))
    if (res.status === 401) tokenCache.delete('ups')
    return []
  }

  let json
  try { json = await res.json() } catch { return [] }

  // UPS service code → human-readable label
  const UPS_SERVICE_NAMES = {
    '01': 'Next Day Air',
    '02': '2nd Day Air',
    '03': 'Ground',
    '07': 'Worldwide Express',
    '08': 'Worldwide Expedited',
    '11': 'Standard',
    '12': '3 Day Select',
    '13': 'Next Day Air Saver',
    '14': 'Next Day Air Early',
    '54': 'Worldwide Express Plus',
    '59': '2nd Day Air A.M.',
    '65': 'Saver',
  }

  // Response shape: { RateResponse: { RatedShipment: [...] } } — but
  // RatedShipment may be a single object if only one service was returned.
  const rsRaw = json?.RateResponse?.RatedShipment
  const rsArr = Array.isArray(rsRaw) ? rsRaw : rsRaw ? [rsRaw] : []
  return rsArr
    .map((rs) => {
      const code = rs?.Service?.Code
      const dollars = Number.parseFloat(rs?.TotalCharges?.MonetaryValue)
      if (!code || !Number.isFinite(dollars)) return null
      return {
        carrier: 'UPS',
        service: UPS_SERVICE_NAMES[code] || rs?.Service?.Description || `Service ${code}`,
        rateCents: Math.round(dollars * 100),
        currency: rs?.TotalCharges?.CurrencyCode || 'USD',
        deliveryDateMin: rs?.GuaranteedDelivery?.BusinessDaysInTransit
          ? addBusinessDaysIso(Number(rs.GuaranteedDelivery.BusinessDaysInTransit))
          : null,
        deliveryDateMax: rs?.GuaranteedDelivery?.BusinessDaysInTransit
          ? addBusinessDaysIso(Number(rs.GuaranteedDelivery.BusinessDaysInTransit))
          : null,
      }
    })
    .filter(Boolean)
}

// ── Dispatcher: USPS + UPS in parallel ─────────────────────────────────
async function fetchDirectCarrierRates(rate) {
  const input = {
    origin: rate.origin,
    destination: rate.destination,
    items: rate.items,
  }
  const results = await Promise.all([
    fetchUSPSRates(input).catch((e) => {
      console.error('[shipping.rates] USPS failed:', e?.message || e)
      return []
    }),
    fetchUPSRates(input).catch((e) => {
      console.error('[shipping.rates] UPS failed:', e?.message || e)
      return []
    }),
  ])
  return results.flat()
}

// ── Route handlers ──────────────────────────────────────────────────────

export async function loader() {
  // Shopify occasionally GETs to verify the URL responds.
  return ratesResponse([])
}

export async function action({ request }) {
  if (request.method !== 'POST') return ratesResponse([])
  
  let rawBody
  try {
    rawBody = await request.text()
  } catch (err) {
    console.error('[shipping.rates] failed to read body:', err?.message || err)
    return ratesResponse([])
  }

  // HMAC verify — log in dev, harden later.
  const hmacHeader = request.headers.get('x-shopify-hmac-sha256') || ''
  if (!verifyHmac(rawBody, hmacHeader)) {
    console.warn('[shipping.rates] hmac mismatch or missing — accepting in dev')
    // PROD HARDENING: uncomment to reject unsigned requests.
    // return ratesResponse([])
  }

  let payload
  try {
    payload = JSON.parse(rawBody)
  } catch {
    console.error('[shipping.rates] invalid JSON body')
    return ratesResponse([])
  }
console.log('[shipping.rates---------------------------------------------] payload received:', JSON.stringify(payload , null , 2))
  const rate = payload?.rate
  if (!rate || !rate.destination || !Array.isArray(rate.items)) {
    console.warn('[shipping.rates] missing rate.destination or rate.items')
    return ratesResponse([])
  }

  // ── 1. Aggregate cart ────────────────────────────────────────────────
  //
  // Strip the Processing Fee cart line out of EVERY downstream calculation
  // (markup tier, vendor check, subtotal threshold, carrier weight). See
  // `isProcessingFeeItem` for detection rules. `realItems` is the items
  // array we treat as the customer's actual merchandise; `rate.items` is
  // the raw Shopify payload we keep around only for logging.
  const realItems = (rate.items || []).filter((it) => !isProcessingFeeItem(it))
  const feeLinesExcluded = rate.items.length - realItems.length

  const totalQty = sumQuantity(realItems)
  if (totalQty === 0) return ratesResponse([])

  console.log(
    `[shipping.rates] inbound: ${rate.items.length} line(s) (${feeLinesExcluded} processing-fee excluded), realQty=${totalQty}, dest=${rate.destination?.country}/${rate.destination?.province}/${rate.destination?.postal_code}`,
  )

  // ── 1a. Free-shipping rule (wholesale store) ─────────────────────────
  //
  // Both conditions must hold:
  //   (a) Every line item's vendor is exactly "Natural Solutions"
  //       (case-insensitive, trimmed — guards against trailing spaces in
  //       admin-typed vendor names)
  //   (b) Cart subtotal (sum of items[].price * quantity, pre-discount)
  //       is >= $500 USD.
  //
  // When both are met, real carrier rate + handling markup are both
  // zeroed and the service_name is decorated so the customer sees why.
  // The customer still picks Ground vs Priority vs Express — they're
  // all shown at $0 with their respective delivery windows so the
  // pick has meaning. Pre-discount subtotal is by design: Shopify's
  // carrier-service payload doesn't expose post-discount totals.
  const FREE_SHIPPING_VENDOR = 'Natural Solutions'
  const FREE_SHIPPING_THRESHOLD_USD = 500

  // Use `realItems` (Processing Fee already stripped) so the vendor +
  // subtotal checks reflect the customer's actual purchase, not the
  // fee line we tacked on.
  const allItemsNaturalSolutions = realItems.every(
    (it) =>
      (it?.vendor || '').trim().toLowerCase() ===
      FREE_SHIPPING_VENDOR.toLowerCase(),
  )
  const cartSubtotalUsd =
    realItems.reduce(
      (sum, it) => sum + (Number(it?.price) || 0) * (Number(it?.quantity) || 0),
      0,
    ) / 100
  const isFreeShipping =
    allItemsNaturalSolutions && cartSubtotalUsd >= FREE_SHIPPING_THRESHOLD_USD

  if (isFreeShipping) {
    console.log(
      `[shipping.rates] FREE shipping ELIGIBLE — vendor=NS × ${rate.items.length} line(s), subtotal=$${cartSubtotalUsd.toFixed(2)}`,
    )
  }

  // ── 2. Fetch live rates from all configured direct carriers ──────────
  // Handling markup is TIERED by total cart quantity (see `tieredMarkupCents`):
  //   1–2 items → +$2, 3 → +$3, 4+ → +$5.
  // Added on top of every real carrier quote. Skipped entirely when the
  // free-shipping rule above fires (rate total goes to $0).
  const baseCents = tieredMarkupCents(totalQty)

  // Carrier APIs (USPS/UPS) read items[] to compute package weight + box
  // dims. Pass `realItems` so the Processing Fee line — which should be
  // weight=0 but may be misconfigured in Shopify Admin — never inflates
  // the quote. We clone `rate` rather than mutate the original payload.
  const directRates = await fetchDirectCarrierRates({ ...rate, items: realItems })
  if (directRates && directRates.length) {
    // Dedup by (carrier, service) — pick cheapest variant per service.
    const dedup = new Map()
    for (const r of directRates) {
      const code = `${r.carrier}_${r.service}`
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
      if (!dedup.has(code) || dedup.get(code).rateCents > r.rateCents) {
        dedup.set(code, { ...r, code })
      }
    }

    const rates = Array.from(dedup.values()).map((r) => {
      // Free-shipping rule wins over carrier cost + handling markup.
      // Customer still sees per-service labels (Ground/Priority/Express)
      // for delivery-speed choice — only the prices flatten to $0.
      const finalCents = isFreeShipping ? 0 : r.rateCents + baseCents
      const baseName = `${r.carrier} ${r.service}`.trim()
      return {
        service_name: isFreeShipping
          ? `${baseName} (FREE — orders over $${FREE_SHIPPING_THRESHOLD_USD})`
          : baseName,
        service_code: r.code,
        total_price: String(finalCents), // STRING in cents
        currency: r.currency || 'USD',
        description: isFreeShipping
          ? `Complimentary on Natural Solutions orders over $${FREE_SHIPPING_THRESHOLD_USD}`
          : `${r.carrier} ${r.service} (incl. handling)`,
        ...(r.deliveryDateMin ? { min_delivery_date: r.deliveryDateMin } : {}),
        ...(r.deliveryDateMax ? { max_delivery_date: r.deliveryDateMax } : {}),
      }
    })

    // Cheapest first.
    rates.sort(
      (a, b) =>
        Number.parseInt(a.total_price, 10) - Number.parseInt(b.total_price, 10),
    )

    console.log(
      isFreeShipping
        ? `[shipping.rates] Direct carriers OK: ${rates.length} rate(s) FREE on $${cartSubtotalUsd.toFixed(2)} NS-only cart`
        : `[shipping.rates] Direct carriers OK: ${rates.length} real rate(s), tiered markup=$${baseCents / 100} on ${totalQty} item(s)`,
    )
    return ratesResponse(rates)
  }

  // No live carrier returned rates — credentials missing, API down, or
  // destination unsupported. Return an empty list so Shopify shows "no
  // shipping available" at checkout. We DO NOT quote placeholder prices
  // here; the merchant should fix the credentials or the address.
  console.warn(
    `[shipping.rates] No live carrier rates for ${totalQty} item(s) to ${rate.destination?.postal_code} — returning empty (check USPS/UPS env vars + API status)`,
  )
  return ratesResponse([])
}
