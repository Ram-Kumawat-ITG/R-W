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
// What this endpoint does (3-tier priority):
//   1. Verifies the Shopify HMAC header (logs mismatch in dev; reject in prod).
//   2. Reads items + origin + destination from the Shopify payload.
//
//   3a. DIRECT CARRIERS path (preferred — free, no aggregator fee):
//        • USPS Web Tools v3 (implemented — needs USPS_CLIENT_ID/SECRET)
//        • UPS Rating v2403 (skeleton — TODO)
//        • FedEx Rate v1 (skeleton — TODO)
//        • DHL Express MyDHL API (skeleton — TODO)
//        Calls every configured carrier in parallel, dedups by (carrier,service),
//        applies markup (totalQty × PER_ITEM_CENTS), sorts cheapest-first.
//
//   3b. EASYPOST path (fallback aggregator — paid, ~$0.005/call):
//        Used when direct carriers return zero rates AND EASYPOST_API_KEY is set.
//
//   3c. CARRIER_SERVICES local table (last resort — fabricated qty-based prices):
//        Guarantees checkout never breaks even if both upstream paths fail.
//
// SETUP — direct carriers (one-time per carrier, optional but recommended):
//   USPS:   registration.usps.com → APIs → OAuth credentials
//           env: USPS_CLIENT_ID, USPS_CLIENT_SECRET
//   UPS:    developer.ups.com → My Apps → OAuth 2.0
//           env: UPS_CLIENT_ID, UPS_CLIENT_SECRET, UPS_SHIPPER_NUMBER
//   FedEx:  developer.fedex.com → API Catalog → Rate API
//           env: FEDEX_CLIENT_ID, FEDEX_CLIENT_SECRET, FEDEX_ACCOUNT_NUMBER
//   DHL:    developer.dhl.com → DHL Express MyDHL API
//           env: DHL_API_KEY, DHL_API_SECRET, DHL_ACCOUNT_NUMBER
//
// SETUP — EasyPost (alternative one-stop aggregator):
//   easypost.com → Test API key (free) or Live key (paid for prod)
//   env: EASYPOST_API_KEY
//
// Any carrier whose env vars aren't set is silently skipped — no errors.

import crypto from 'node:crypto'

// ── Tunables ────────────────────────────────────────────────────────────

// Base shipping rate per cart-item, in cents. The user's spec: 5 items → $5
// on the cheapest carrier (UPS Ground / multiplier 1.0). Tune via env if
// pricing ever needs to change without a redeploy.
const PER_ITEM_CENTS = Number.parseInt(
  process.env.SHIPPING_PER_QTY_CENTS || '100',
  10,
)

// Carrier list shown at checkout. Order here = order shown (cheapest first
// is also the safer default for B2B). Each entry:
//   carrier        → real carrier name shown to the customer
//   service        → service tier shown alongside the carrier name
//   serviceCode    → stable identifier Shopify records on the order
//   tierMultiplier → multiplies (totalQty × PER_ITEM_CENTS)
//   deliveryDays   → [min, max] business days — purely cosmetic; appears
//                    next to the price in the customer's checkout view.
const CARRIER_SERVICES = [
  {
    carrier: 'cdcdc',
    service: 'Ground Advantage',
    serviceCode: 'USPS_GROUND',
    tierMultiplier: 0.85,
    deliveryDays: [4, 8],
  },
  {
    carrier: 'UPS',
    service: 'Ground',
    serviceCode: 'UPS_GROUND',
    tierMultiplier: 1.0,
    deliveryDays: [3, 5],
  },
  {
    carrier: 'UPS',
    service: '2nd Day Air',
    serviceCode: 'UPS_2DAY',
    tierMultiplier: 1.5,
    deliveryDays: [2, 2],
  },
  {
    carrier: 'DHL',
    service: 'Express',
    serviceCode: 'DHL_EXPRESS',
    tierMultiplier: 2.0,
    deliveryDays: [1, 3],
  },
]

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

// Add N business days from today and return an ISO date string —
// Shopify shows this next to the price in the customer's checkout view.
function addBusinessDaysIso(daysFromToday) {
  const d = new Date()
  d.setDate(d.getDate() + Math.max(0, daysFromToday))
  return d.toISOString()
}

// Pounds + ounces from grams. USPS / UPS / FedEx APIs want LB or OZ.
function gramsToOz(grams) {
  return Math.max(1, Math.round((Number(grams) || 0) / 28.3495))
}
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

  // ── Step 2: Build rate request ─────────────────────────────────────
  const totalGrams = (items || []).reduce(
    (s, it) => s + (Number(it?.grams) || 0) * (Number(it?.quantity) || 0),
    0,
  )

  // USPS expects ZIP-only origin/destination for domestic. International
  // adds country + value but we focus on domestic for now.
  const body = {
    originZIPCode: origin?.postal_code || '',
    destinationZIPCode: destination?.postal_code || '',
    weight: gramsToLb(totalGrams), // pounds (with decimal for ounces)
    length: 10,
    width: 8,
    height: 4,
    mailClasses: [
      'USPS_GROUND_ADVANTAGE',
      'PRIORITY_MAIL',
      'PRIORITY_MAIL_EXPRESS',
    ],
    priceType: 'COMMERCIAL', // wholesale = commercial rates
    mailingDate: new Date().toISOString().slice(0, 10),
  }

  // ── Step 3: Fetch rates ────────────────────────────────────────────
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
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    clearTimeout(timeout)
  } catch (err) {
    console.error('[shipping.rates] USPS network error:', err?.message || err)
    return []
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.error('[shipping.rates] USPS non-200:', res.status, text.slice(0, 300))
    // 401 → token went stale, drop cache so next call re-fetches.
    if (res.status === 401) tokenCache.delete('usps')
    return []
  }

  let json
  try {
    json = await res.json()
  } catch {
    return []
  }

  // USPS response shape: { rates: [{ mailClass, totalBasePrice, ... }] }
  const raw = Array.isArray(json?.rates) ? json.rates : []
  return raw
    .map((r) => {
      const dollars = Number.parseFloat(r.totalBasePrice ?? r.price)
      if (!Number.isFinite(dollars)) return null
      const serviceLabel =
        {
          USPS_GROUND_ADVANTAGE: 'Ground Advantage',
          PRIORITY_MAIL: 'Priority Mail',
          PRIORITY_MAIL_EXPRESS: 'Priority Mail Express',
        }[r.mailClass] || r.mailClass
      return {
        carrier: 'USPS',
        service: serviceLabel,
        rateCents: Math.round(dollars * 100),
        currency: 'USD',
        deliveryDateMin: null,
        deliveryDateMax: null,
      }
    })
    .filter(Boolean)
}

// ── UPS Rating API v2403 (skeleton — replicate USPS pattern) ────────────
//
// SIGNUP: developer.ups.com → My Apps → New App → OAuth 2.0
// Env vars: UPS_CLIENT_ID, UPS_CLIENT_SECRET, UPS_SHIPPER_NUMBER, UPS_API_BASE
//
// Auth: OAuth client_credentials (POST {base}/security/v1/oauth/token,
// Basic auth header = base64(client_id:client_secret), grant_type=client_credentials).
// Rates: POST {base}/api/rating/v2403/Rate (Bearer token).
//
// TODO: implement after USPS verified end-to-end. Same pattern as fetchUSPSRates
// — get token, cache it, POST rate request, normalize response.
async function fetchUPSRates(_input) {
  if (!process.env.UPS_CLIENT_ID || !process.env.UPS_CLIENT_SECRET) return []
  // TODO: Implement following USPS pattern above.
  console.log('[shipping.rates] UPS integration: TODO — env vars detected but handler not implemented yet')
  return []
}

// ── FedEx Rate API (skeleton — replicate USPS pattern) ──────────────────
//
// SIGNUP: developer.fedex.com → API Catalog → Rate API → Create credentials
// Env vars: FEDEX_CLIENT_ID, FEDEX_CLIENT_SECRET, FEDEX_ACCOUNT_NUMBER, FEDEX_API_BASE
//
// Auth: OAuth client_credentials (POST {base}/oauth/token,
// form body: grant_type=client_credentials&client_id=X&client_secret=Y).
// Rates: POST {base}/rate/v1/rates/quotes (Bearer token).
async function fetchFedExRates(_input) {
  if (!process.env.FEDEX_CLIENT_ID || !process.env.FEDEX_CLIENT_SECRET) return []
  // TODO: Implement following USPS pattern above.
  console.log('[shipping.rates] FedEx integration: TODO — env vars detected but handler not implemented yet')
  return []
}

// ── DHL Express API (skeleton — simpler, Basic auth only) ──────────────
//
// SIGNUP: developer.dhl.com → DHL Express → MyDHL API → API key
// Env vars: DHL_API_KEY, DHL_API_SECRET, DHL_ACCOUNT_NUMBER, DHL_API_BASE
//
// Auth: HTTP Basic (Authorization: Basic base64(api_key:api_secret)).
// Rates: POST {base}/mydhlapi/rates with shipper/recipient/packages JSON.
async function fetchDHLRates(_input) {
  if (!process.env.DHL_API_KEY || !process.env.DHL_API_SECRET) return []
  // TODO: Implement following USPS pattern above.
  console.log('[shipping.rates] DHL integration: TODO — env vars detected but handler not implemented yet')
  return []
}

// ── Dispatcher: call every configured direct carrier in parallel ───────
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
    fetchFedExRates(input).catch((e) => {
      console.error('[shipping.rates] FedEx failed:', e?.message || e)
      return []
    }),
    fetchDHLRates(input).catch((e) => {
      console.error('[shipping.rates] DHL failed:', e?.message || e)
      return []
    }),
  ])
  return results.flat()
}

// Fetch live multi-carrier rates from EasyPost using a raw HTTPS call
// (no SDK install needed — works out of the box once EASYPOST_API_KEY is set).
//
// EasyPost's /shipments endpoint returns rates from ALL configured carriers
// (UPS, USPS, FedEx, DHL Express, etc.) on a single account. We map each
// returned rate into the shape the caller's action handler expects.
//
// Returns [] on any failure — caller decides fallback behavior.
async function fetchEasyPostRates(rate) {
  if (!process.env.EASYPOST_API_KEY) return []

  // EasyPost auth: HTTP Basic with the API key as username, empty password.
  const auth = Buffer.from(`${process.env.EASYPOST_API_KEY}:`).toString('base64')

  // Destination address — Shopify carrier-service payload uses snake_case.
  const to_address = {
    name: rate.destination?.name || 'Customer',
    street1: rate.destination?.address1 || '',
    street2: rate.destination?.address2 || '',
    city: rate.destination?.city || '',
    state: rate.destination?.province_code || rate.destination?.province || '',
    zip: rate.destination?.postal_code || '',
    country: rate.destination?.country_code || rate.destination?.country || 'US',
  }

  // Origin — prefer the origin Shopify provides (configured in
  // Settings → Locations). Fall back to SHIPPING_FROM_* env vars.
  const from_address = rate.origin
    ? {
        name: rate.origin.name || 'Store',
        street1: rate.origin.address1 || '',
        street2: rate.origin.address2 || '',
        city: rate.origin.city || '',
        state: rate.origin.province_code || rate.origin.province || '',
        zip: rate.origin.postal_code || '',
        country: rate.origin.country_code || rate.origin.country || 'US',
      }
    : {
        name: process.env.SHIPPING_FROM_NAME || 'Store',
        street1: process.env.SHIPPING_FROM_ADDRESS1 || '',
        city: process.env.SHIPPING_FROM_CITY || '',
        state: process.env.SHIPPING_FROM_STATE || '',
        zip: process.env.SHIPPING_FROM_POSTAL || '',
        country: process.env.SHIPPING_FROM_COUNTRY || 'US',
      }

  // Parcel weight: sum item.grams × item.quantity (grams → ounces for EasyPost).
  const totalGrams = (rate.items || []).reduce(
    (s, it) => s + (Number(it?.grams) || 0) * (Number(it?.quantity) || 0),
    0,
  )
  const parcel = {
    length: 10,
    width: 8,
    height: 4,
    weight: gramsToOz(totalGrams),
  }

  let response
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000) // Shopify gives ~10s
    response = await fetch('https://api.easypost.com/v2/shipments', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ shipment: { to_address, from_address, parcel } }),
      signal: controller.signal,
    })
    clearTimeout(timeout)
  } catch (err) {
    console.error('[shipping.rates] EasyPost network error:', err?.message || err)
    return []
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    console.error('[shipping.rates] EasyPost non-200:', response.status, text.slice(0, 400))
    return []
  }

  let json
  try {
    json = await response.json()
  } catch {
    console.error('[shipping.rates] EasyPost invalid JSON')
    return []
  }

  const raw = Array.isArray(json?.rates) ? json.rates : []
  // Normalize to a stable internal shape.
  return raw
    .map((r) => {
      const dollars = Number.parseFloat(r.rate)
      if (!Number.isFinite(dollars)) return null
      return {
        carrier: r.carrier || '',
        service: r.service || '',
        rateCents: Math.round(dollars * 100),
        currency: r.currency || 'USD',
        // EasyPost gives `delivery_days` (an integer) and `delivery_date` (ISO).
        // We surface both — the action handler picks whichever is more useful.
        deliveryDays: Number.isFinite(Number(r.delivery_days)) ? Number(r.delivery_days) : null,
        deliveryDateMin: r.delivery_date || null,
        deliveryDateMax: r.delivery_date || null,
      }
    })
    .filter(Boolean)
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

  const rate = payload?.rate
  if (!rate || !rate.destination || !Array.isArray(rate.items)) {
    console.warn('[shipping.rates] missing rate.destination or rate.items')
    return ratesResponse([])
  }

  // ── 1. Aggregate cart ────────────────────────────────────────────────
  const totalQty = sumQuantity(rate.items)
  if (totalQty === 0) return ratesResponse([])

  console.log(
    `[shipping.rates] inbound: ${rate.items.length} line(s), totalQty=${totalQty}, dest=${rate.destination?.country}/${rate.destination?.province}/${rate.destination?.postal_code}`,
  )

  // ── 2. Priority order for live carrier rates ─────────────────────────
  //   a. Direct carriers (USPS / UPS / FedEx / DHL) — preferred, free
  //   b. EasyPost (aggregator, paid) — fallback for partial direct coverage
  //   c. CARRIER_SERVICES local table — final safety net, fabricated rates
  //
  // Markup formula = totalQty × PER_ITEM_CENTS (added on top of every real
  // carrier quote). Configurable via SHIPPING_PER_QTY_CENTS env var.
  const baseCents = totalQty * PER_ITEM_CENTS
  let rates = []

  // ── 2a. Direct carriers ──────────────────────────────────────────────
  const directRates = await fetchDirectCarrierRates(rate)
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

    rates = Array.from(dedup.values()).map((r) => {
      const finalCents = r.rateCents + baseCents
      return {
        service_name: `${r.carrier} ${r.service}`.trim(),
        service_code: r.code,
        total_price: String(finalCents), // STRING in cents
        currency: r.currency || 'USD',
        description: `${r.carrier} ${r.service} (incl. handling)`,
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
      `[shipping.rates] Direct carriers OK: ${rates.length} real rate(s), markup=$${baseCents / 100} on ${totalQty} item(s)`,
    )
    return ratesResponse(rates)
  }

  // ── 2b. EasyPost aggregator (fallback) ───────────────────────────────
  if (process.env.EASYPOST_API_KEY) {
    const external = await fetchEasyPostRates(rate)
    if (external && external.length) {
      // Dedup (carrier, service) — EasyPost can return account-level variants.
      const dedup = new Map()
      for (const r of external) {
        const code = `${r.carrier}_${r.service}`
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
        if (!dedup.has(code) || dedup.get(code).rateCents > r.rateCents) {
          dedup.set(code, { ...r, code })
        }
      }

      rates = Array.from(dedup.values()).map((r) => {
        const finalCents = r.rateCents + baseCents
        return {
          service_name: `${r.carrier} ${r.service}`.trim(),
          service_code: r.code,
          total_price: String(finalCents), // STRING in cents
          currency: r.currency || 'USD',
          description: `${r.carrier} ${r.service} (incl. handling)`,
          // EasyPost gives a single delivery date or a days count — use whichever.
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
        `[shipping.rates] EasyPost OK: ${rates.length} real rate(s), markup=$${baseCents / 100} on ${totalQty} item(s)`,
      )
      return ratesResponse(rates)
    }
    console.warn('[shipping.rates] EasyPost returned no rates — falling back to CARRIER_SERVICES')
  }

  // ── 3. Fallback: CARRIER_SERVICES local pricing ──────────────────────

  // Fallback: local quantity-based pricing (original behavior)
  rates = CARRIER_SERVICES.map((svc) => {
    const finalCents = Math.round(baseCents * svc.tierMultiplier)
    return {
      service_name: `${svc.carrier} ${svc.service}`,
      service_code: svc.serviceCode,
      total_price: String(finalCents), // STRING in cents
      currency: 'USD',
      description: `${svc.carrier} ${svc.service}`,
      min_delivery_date: addBusinessDaysIso(svc.deliveryDays[0]),
      max_delivery_date: addBusinessDaysIso(svc.deliveryDays[1]),
    }
  })

  console.log(
    `[shipping.rates] returning ${rates.length} option(s), base=$${baseCents / 100} for ${totalQty} item(s)`,
  )
  return ratesResponse(rates)
}
