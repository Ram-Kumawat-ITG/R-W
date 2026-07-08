# NS-Retail Shipping Logic — Technical Documentation

**File:** `ns-retail/app/api/shipping/rates.js`
**Purpose:** Shopify Carrier Service callback endpoint that returns real-time shipping rates (USPS + UPS) with a bundled 3% processing fee for every checkout on the retail Shopify store.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [High-Level Architecture](#2-high-level-architecture)
3. [End-to-End Request Flow](#3-end-to-end-request-flow)
4. [Configuration Block (Single Source of Truth)](#4-configuration-block-single-source-of-truth)
5. [Logic Modules](#5-logic-modules)
   - 5.1 [HMAC Verification (Log-Only)](#51-hmac-verification-log-only)
   - 5.2 [Inbound Payload Parsing](#52-inbound-payload-parsing)
   - 5.3 [Processing Fee Line Detection](#53-processing-fee-line-detection)
   - 5.4 [Free Shipping Rule](#54-free-shipping-rule)
   - 5.5 [Tiered Handling Markup](#55-tiered-handling-markup)
   - 5.6 [Discount Detection](#56-discount-detection-5-fallback-paths)
   - 5.7 [Net Subtotal Calculation](#57-net-subtotal-calculation)
   - 5.8 [Tax Calculation (Async Fire-and-Forget)](#58-tax-calculation-async-fire-and-forget)
   - 5.9 [Direct Carrier APIs (USPS + UPS)](#59-direct-carrier-apis-usps--ups)
   - 5.10 [Rate Deduplication](#510-rate-deduplication)
   - 5.11 [Processing Fee Formula](#511-processing-fee-formula-core-calculation)
   - 5.12 [Response Assembly](#512-response-assembly)
6. [Object Reference — All 5 API Contracts](#6-object-reference--all-5-api-contracts)
7. [Real Sample Trace (From Production Logs)](#7-real-sample-trace-from-production-logs)
8. [Error Handling & Fallback Behavior](#8-error-handling--fallback-behavior)
9. [Caching & Performance](#9-caching--performance)
10. [Environment Variables](#10-environment-variables)
11. [Testing & Verification](#11-testing--verification)

---

## 1. Executive Summary

The `rates.js` endpoint is a Shopify **Carrier Service** callback. Shopify invokes it via HTTPS POST during every checkout re-render, sending the customer's cart items and shipping address. The endpoint must respond within 10 seconds with an array of shipping options (USPS Ground, Priority, First-Class, Priority Express) or return an empty list.

Beyond returning raw carrier rates, this endpoint implements several business rules on top:

- **Handling markup** tiered by cart quantity (+$2 / +$3 / +$5).
- **Free shipping** for orders of Natural Solutions vendor items totaling ≥ $500.
- **Discount detection** from Shopify's cart discounts and order-level codes.
- **Live tax calculation** via Shopify's `draftOrderCalculate` GraphQL mutation, cached in memory for 5 minutes.
- **3% processing fee** bundled into every rate, calculated on `(net subtotal + shipping + tax)`.
- **Rate deduplication** across USPS and UPS to prevent duplicate service entries.

The endpoint returns rates in Shopify's mandated format: `{ rates: [{ service_name, service_code, total_price, currency, ... }] }` with `total_price` as a **string in cents** (Shopify's requirement — a number or dollar-formatted string is silently ignored).

---

## 2. High-Level Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                    SHOPIFY CHECKOUT                                   │
│   Customer enters address, selects shipping option, applies discount   │
└─────────────────────────────┬──────────────────────────────────────────┘
                              │  POST /api/shipping/rates
                              │  Body: { rate: { items, destination, ... } }
                              ▼
┌────────────────────────────────────────────────────────────────────────┐
│               NS-RETAIL BACKEND (Render / Local dev)                  │
│                                                                        │
│   1. HMAC verify (log-only)                                            │
│   2. Parse payload → extract items + destination                       │
│   3. Filter out old "Processing Fee" line item (legacy)                │
│   4. Check free-shipping rule (NS vendor + $500+)                      │
│   5. Compute tiered handling markup                                    │
│   6. Detect cart discount from payload                                 │
│   7. Compute net subtotal (raw − discount)                             │
│   8. Fetch tax from Shopify Admin (fire-and-forget + cache)            │
│   9. Fetch USPS + UPS rates in parallel ────┐                          │
│  10. Dedup rates by (carrier, service)      │                          │
│  11. For each rate:                          │                          │
│       feeBase = subtotal + shipping + tax    │                          │
│       fee     = 3% × feeBase                 │                          │
│       final   = shipping + fee               │                          │
│  12. Return { rates: [...] } to Shopify      │                          │
│                                              ▼                          │
│              ┌───────────────────┬─────────────────────┐               │
│              │ USPS Web Tools v3 │ UPS Rating v2403    │               │
│              │ + Shopify Admin   │                     │               │
│              │ GraphQL (tax)     │                     │               │
│              └───────────────────┴─────────────────────┘               │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. End-to-End Request Flow

Full step-by-step trace of a single carrier callback:

```
T=0.00s   Shopify POSTs /api/shipping/rates with payload
T=0.01s   HMAC check → LOG-ONLY (proceed even if mismatch — carrier callbacks
          aren't HMAC-signed like regular webhooks; blocking would break checkout)
T=0.02s   Parse JSON body → { rate: { items, destination, origin, order_totals } }
T=0.03s   Filter items → strip legacy Processing Fee line (title regex match)
T=0.04s   Compute totalQty → decide handling markup tier
T=0.05s   Check free-shipping rule:
          - All items vendor === "Natural Solutions" (case-insensitive)?
          - Cart pre-discount subtotal ≥ $500?
          If both true → shipping cost will be zeroed later
T=0.06s   Compute rawItemsSumCents = Σ items[].price × quantity
T=0.07s   detectCartDiscountCents(rate) — probe 5 payload fields, first non-zero wins:
          1. rate.order_totals.discount_amount        (2026 spec — most common)
          2. rate.order_totals.subtotal_price − total_price (derived fallback)
          3. rate.total_discounts                     (older spec)
          4. Σ items[].discount_allocations[].amount  (per-line)
          5. rate.subtotal_price vs items sum         (last-ditch derived)
T=0.08s   cartSubtotalCents = max(0, rawItems − discount)
T=0.09s   calculateShopifyTax() — cache-only check (synchronous)
          - HIT: return { taxCents, source: "shopify_cached" }
          - MISS: kick off fetchShopifyTaxInBackground(), return null
                  (background fetch takes ~2–12s; runs concurrently with steps below)
T=0.10s   fetchDirectCarrierRates() — Promise.all([USPS, UPS])
          ├─ USPS: 4 parallel calls (one per mail class) → merge results
          └─ UPS: single call, returns all services in one shot
T=1.50s   Both carriers return; combined array of rate objects
T=1.51s   Dedup by (carrier, service) — keep cheapest per key
T=1.52s   For each unique rate:
          shipping        = isFreeShipping ? 0 : rateCents + handlingMarkup
          shippingTaxCents= round(shipping × taxRate)   ← derived rate
          totalTaxCents   = baseTaxCents + shippingTaxCents
          feeBaseCents    = cartSubtotalCents + shipping + totalTaxCents
          feeCents        = round(feeBaseCents × 0.03)
          finalCents      = shipping + feeCents
T=1.53s   Sort rates cheapest-first
T=1.54s   Log per-rate breakdown block for auditability
T=1.55s   Return HTTP 200 with { rates: [...] } in Shopify's mandated shape

T=~12.0s  Background tax fetch completes → cache warmed for next callback
          (this callback returned without tax; next callback in the same
          checkout session gets tax from cache instantly)
```

---

## 4. Configuration Block (Single Source of Truth)

All tunable numbers live in one place at the top of the file. This is intentional — no magic numbers hunted through code.

```js
const CONFIG = {
  // Processing fee — fraction of (subtotal + shipping + tax)
  processingFeeRate: 0.03,   // 3%

  // Handling markup added to non-free shipping options
  handlingMarkupCents: {
    upTo2Items: 200,         // +$2 for 1–2 items
    threeItems: 300,         // +$3 for 3 items
    fourPlusItems: 500,      // +$5 for 4+ items
  },

  // Free shipping — both must hold to trigger
  freeShipping: {
    vendor: "Natural Solutions",
    thresholdUsd: 500,
  },

  // Shopify tax API tuning
  shopifyTax: {
    cacheTtlMs: 5 * 60 * 1000,  // 5 minutes
    timeoutMs: 5000,            // legacy — unused since bg-fetch pattern
    cacheMaxEntries: 1000,      // LRU cap for memory safety
  },
};
```

To change any value (e.g., fee percentage, free-shipping threshold), edit this block only.

---

## 5. Logic Modules

### 5.1 HMAC Verification (Log-Only)

**Why log-only:** Shopify's Carrier Service callback is NOT signed the same way regular webhooks are. Empirically, the `X-Shopify-Hmac-Sha256` header is sometimes present, sometimes absent, and when present the signature often doesn't validate against `SHOPIFY_API_SECRET`. Two prior attempts to hard-reject on mismatch broke production checkout because legitimate Shopify requests were rejected.

**Current behavior:**

```js
const hmacHeader = request.headers.get("x-shopify-hmac-sha256") || "";
if (hmacHeader && !verifyHmac(rawBody, hmacHeader)) {
  console.warn(
    "[shipping.rates] hmac header present but did not match SHOPIFY_API_SECRET — accepting anyway",
  );
}
```

**Security relies on:**
- The callback URL is unguessable (registered via authenticated `carrierServiceCreate` mutation).
- Only Shopify can point this URL at itself; an attacker cannot inject their own URL.

**Reference:** `rates.js:1089-1120`, helper `verifyHmac()` at `rates.js:233-249`.

---

### 5.2 Inbound Payload Parsing

Shopify POSTs a JSON body with a single top-level `rate` object. We consume it as-is.

**What we extract:**

| Field | Used For |
|-------|----------|
| `rate.destination.country/province/postal_code` | Tax jurisdiction, USPS/UPS routing |
| `rate.destination.city/address1` | UPS full address, tax input |
| `rate.origin.postal_code` | USPS/UPS shipping-from |
| `rate.items[].variant_id` | Tax API (converted to GID format) |
| `rate.items[].price` (cents) | Subtotal + fee calculation |
| `rate.items[].quantity` | Weight, tier markup, subtotal |
| `rate.items[].grams` | Package weight for USPS/UPS |
| `rate.items[].vendor` | Free-shipping rule check |
| `rate.items[].name` | Processing fee line detection |
| `rate.order_totals.discount_amount` | Discount detection (primary path) |
| `rate.currency` | Currency echoed in response |

**Failure mode:** If `rate` or `rate.destination` or `rate.items` is missing, we return HTTP 200 with `{ rates: [] }` — Shopify will show "no shipping available" but won't error the checkout page.

**Reference:** `rates.js:1122-1153`.

---

### 5.3 Processing Fee Line Detection

The old Checkout UI Extension (pre-Grow-plan migration) inserted a "Processing Fee" line item into the cart. That code path is disabled, but if it re-activates or a merchant inserts a similar item manually, we strip it here so it doesn't inflate:
- The handling-markup tier (quantity count)
- USPS/UPS weight calculation
- The subtotal used in fee base

**Detection rules** (helper `isProcessingFeeItem()`):
1. Product ID match (constant `PROCESSING_FEE_VARIANT_ID` — currently `null`, TODO)
2. Title regex: `/processing\s*fee/i`

If either matches, the line is excluded from `realItems`. The original `rate.items` array is retained only for logging.

```js
const realItems = (rate.items || []).filter((it) => !isProcessingFeeItem(it));
const feeLinesExcluded = rate.items.length - realItems.length;
```

**Reference:** `rates.js:276-291`, filter at `rates.js:1143-1146`.

---

### 5.4 Free Shipping Rule

Two conditions must both hold:

1. **Every line item's vendor** is exactly `"Natural Solutions"` (case-insensitive, trimmed).
2. **Cart pre-discount subtotal** is ≥ `$500 USD`.

```js
const allItemsNaturalSolutions =
  realItems.length > 0 &&
  realItems.every(
    (it) => (it?.vendor || "").trim().toLowerCase() === CONFIG.freeShipping.vendor.toLowerCase(),
  );

const cartSubtotalUsd = realItems.reduce(
  (sum, it) => sum + (Number(it?.price) || 0) * (Number(it?.quantity) || 0),
  0,
) / 100;

const isFreeShipping =
  allItemsNaturalSolutions &&
  cartSubtotalUsd >= CONFIG.freeShipping.thresholdUsd;
```

**Effect when triggered:**
- Real carrier rate → `$0`
- Handling markup → `$0`
- 3% processing fee → **still applies** (it's a payment surcharge, not a shipping charge)
- Service name is decorated: `"USPS Ground Advantage (Free shipping + 3% processing fee)"`
- Customer still sees per-service options (Ground / Priority / Express) with their delivery windows.

**Why pre-discount subtotal:**
- Shopify's carrier-service payload doesn't reliably expose post-discount totals.
- Merchant intent is "spent $500+ on merchandise" — the list-price threshold matches.

**Reference:** `rates.js:1156-1195`.

---

### 5.5 Tiered Handling Markup

A flat surcharge added to every non-free shipping option, based on total cart quantity.

```js
function tieredMarkupCents(qty) {
  if (qty <= 2) return CONFIG.handlingMarkupCents.upTo2Items;   // 200 = $2
  if (qty === 3) return CONFIG.handlingMarkupCents.threeItems;  // 300 = $3
  return CONFIG.handlingMarkupCents.fourPlusItems;              // 500 = $5
}
```

| Item Count | Markup |
|-----------|--------|
| 1–2 | +$2 |
| 3 | +$3 |
| 4+ | +$5 |

Applied per rate: `shipping = rawCarrierRate + baseCents`.

**Sync note:** The reverse-calc in `wholesale/app/services/dropship/*.js` must mirror these numbers.

**Reference:** `rates.js:109-113`, applied at `rates.js:1201`.

---

### 5.6 Discount Detection (5 Fallback Paths)

Shopify's carrier-service payload doesn't have a single canonical field for applied discounts — different Shopify versions and store configs populate different keys, and sometimes none. To be robust, we probe five fields in priority order; first non-zero wins:

**Detection cascade** (function `detectCartDiscountCents(rate, realItems)`):

| # | Field | Notes |
|---|-------|-------|
| 0a | `rate.order_totals.discount_amount` | Newest payload spec (2026-07-07 confirmed). Cents, most reliable. |
| 0b | `rate.order_totals.subtotal_price − total_price` | Belt-and-braces if 0a is 0 despite an active discount. |
| 1 | `rate.total_discounts` | Older payload shape. Cents. |
| 2 | `Σ items[].discount_allocations[].amount` | Per-line allocations. Some themes send dollars (values ≤ 100), others cents (> 100) — heuristic applied. |
| 3 | `rate.subtotal_price` (derived vs items sum) | Last resort. |

**Return shape:** `{ cents: number, source: string }` — the `source` field appears in logs so operators can diagnose payload drift.

**Fallback:** If all five paths yield 0, `cents=0` and fee falls back to computing on raw subtotal (preserving the pre-discount-aware behavior; zero regression risk).

**Impact example:** A $75 cart with a $15 discount applied:
- Before: fee = 3% × $75 (raw) = $2.48
- After: fee = 3% × $60 (net) = $1.80
- Correct behavior — customer isn't over-charged the fee on discounted money.

**Reference:** `rates.js:132-224`, applied at `rates.js:1212-1214`.

---

### 5.7 Net Subtotal Calculation

Once the discount is detected, subtotal is computed post-discount:

```js
const rawItemsSumCents = realItems.reduce(
  (sum, it) => sum + (Number(it?.price) || 0) * (Number(it?.quantity) || 0),
  0,
);
const cartDiscount = detectCartDiscountCents(rate, realItems);
const discountCents = cartDiscount.cents;
const cartSubtotalCents = Math.max(0, rawItemsSumCents - discountCents);
```

`cartSubtotalCents` is what flows into the fee base. `rawItemsSumCents` is retained for logging and for the free-shipping threshold check (which by design uses pre-discount value).

**Reference:** `rates.js:1203-1224`.

---

### 5.8 Tax Calculation (Async Fire-and-Forget)

**The problem:** Shopify's `draftOrderCalculate` mutation was empirically measured (Postman, 2026-07-08) to take **~12 seconds TTFB** on the staging store. Shopify's own carrier-callback budget is 10 seconds. Any inline `await` on the tax API guarantees the entire checkout gets "Shipping not available."

**The solution — split into two paths:**

**Fast path** (synchronous cache-only check):

```js
async function calculateShopifyTax({ shop, destination, realItems, subtotalCents }) {
  if (!shop || !realItems?.length) return null;

  const cacheKey = buildTaxCacheKey({ destination, realItems, subtotalCents });
  const cached = _shopifyTaxCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CONFIG.shopifyTax.cacheTtlMs) {
    return { taxCents: cached.taxCents, source: "shopify_cached" };
  }

  // Cache miss — kick off background fetch, return null immediately
  if (!_shopifyTaxInFlight.has(cacheKey)) {
    _shopifyTaxInFlight.add(cacheKey);
    fetchShopifyTaxInBackground({ shop, input, cacheKey })
      .finally(() => _shopifyTaxInFlight.delete(cacheKey));
  }
  return null;
}
```

**Slow path** (background fetch, runs concurrently on its own promise chain):

```js
async function fetchShopifyTaxInBackground({ shop, input, cacheKey }) {
  // Direct fetch to Shopify Admin GraphQL (bypasses framework session storage)
  const adminToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const apiVersion = process.env.SHOPIFY_ADMIN_API_VERSION || "2026-07";
  const graphqlUrl = `https://${shop}/admin/api/${apiVersion}/graphql.json`;

  // Timeout: 30 sec (no carrier-callback budget to protect here)
  const res = await fetch(graphqlUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": adminToken,
    },
    body: JSON.stringify({
      query: MUTATION_DRAFT_ORDER_CALCULATE,
      variables: { input },
    }),
    signal: controller.signal,
  });

  // Parse, then populate cache
  const body = await res.json();
  const taxAmountUsd = Number(
    body?.data?.draftOrderCalculate?.calculatedDraftOrder?.totalTaxSet?.shopMoney?.amount,
  );
  const taxCents = Math.round(taxAmountUsd * 100);

  _shopifyTaxCache.set(cacheKey, { taxCents, cachedAt: Date.now() });
}
```

**Concurrency dedup:** The `_shopifyTaxInFlight` Set prevents duplicate concurrent fetches for the same cache key. In a real checkout, Shopify fires 3–4 carrier callbacks back-to-back (address entry → shipping select → discount apply → payment). Without dedup, each callback would trigger its own tax fetch, wasting rate-limit quota.

**Cache key:**

```js
function buildTaxCacheKey({ destination, realItems, subtotalCents }) {
  const state = destination?.province_code || destination?.province || "";
  const zip = (destination?.postal_code || "").slice(0, 5);
  const country = destination?.country_code || "US";
  const variants = (realItems || [])
    .map((it) => `${it.variant_id}:${it.quantity}`)
    .sort().join(",");
  return `${country}|${state}|${zip}|${subtotalCents}|${variants}`;
}
```

Subtotal is included so a discount-applied cart naturally caches under a different key than the same items un-discounted.

**Trade-off:** The first 1–2 rate quotes a customer sees in a fresh checkout will not include tax in the fee (tax = 0 in the log as `taxSource: api_unavailable`). By the time the customer completes checkout (3rd–4th callback), the cache is warm and the final payment includes tax accurately. Fee under-charge on the first quote is:
- $10 order → ~$0.03
- $100 order → ~$0.29
- $1000 order → ~$2.93

**Fallback:** If the background fetch fails (timeout, HTTP error, GraphQL error), no cache entry is created and subsequent callbacks continue with `taxCents = 0`. Fee falls back to `3% × (subtotal + shipping)`. The failure is logged with the actual Shopify error message for debugging.

**References:**
- Fast path: `rates.js:446-508`
- Background path: `rates.js:510-648`
- Cache key: `rates.js:378-384`
- GraphQL mutation constant: `rates.js:393-408`

---

### 5.9 Direct Carrier APIs (USPS + UPS)

Both carriers are called in parallel via `Promise.all`. Total latency = `max(USPS, UPS)`, not `USPS + UPS`.

```js
async function fetchDirectCarrierRates(rate) {
  const input = { origin: rate.origin, destination: rate.destination, items: rate.items };
  const results = await Promise.all([
    fetchUSPSRates(input).catch(() => []),
    fetchUPSRates(input).catch(() => []),
  ]);
  return results.flat();
}
```

**Silent skip:** If a carrier's env vars are missing, that carrier returns `[]` and is silently omitted. No error, no rejection.

**No placeholder rates:** If both carriers return empty, the endpoint returns `{ rates: [] }` and Shopify shows "no shipping available." Static placeholder pricing was removed on 2026-06-22 once real USPS credentials were configured.

#### USPS Web Tools v3

- **Endpoint:** `POST https://apis.usps.com/prices/v3/base-rates/search`
- **Auth:** OAuth 2.0 client-credentials grant → Bearer token (TTL ~1 hour, cached in-process)
- **Constraint:** The API quotes **one mail class per call**. To show all four classes (Ground, Priority, Priority Express, First-Class), we fan out four parallel calls and merge results.

**Required request body fields** (missing any triggers HTTP 400 "OASValidation"):

```json
{
  "originZIPCode": "94707",
  "destinationZIPCode": "90001",
  "weight": 0.5,
  "length": 10, "width": 8, "height": 4,
  "mailClass": "USPS_GROUND_ADVANTAGE",
  "processingCategory": "MACHINABLE",
  "rateIndicator": "SP",
  "destinationEntryFacilityType": "NONE",
  "priceType": "COMMERCIAL",
  "mailingDate": "2026-07-08"
}
```

**Mail class → (rateIndicator, processingCategory) mapping** — mismatches trigger "Could not find working sku from SSF ingredients" errors:

| Mail Class Code | Label | rateIndicator | processingCategory |
|-----------------|-------|---------------|---------------------|
| `USPS_GROUND_ADVANTAGE` | Ground Advantage | SP | MACHINABLE |
| `PRIORITY_MAIL` | Priority Mail | SP | MACHINABLE |
| `PRIORITY_MAIL_EXPRESS` | Priority Mail Express | PA | MACHINABLE |
| `FIRST-CLASS_PACKAGE_SERVICE` | First-Class Package | SP | MACHINABLE |

Any class whose specific `weight × zone` combination isn't sold by USPS is silently dropped — the remaining classes still appear.

**Response parsing:**

```js
const dollars = Number.parseFloat(json?.totalBasePrice ?? json?.rates?.[0]?.price);
return {
  carrier: "USPS",
  service: label,
  rateCents: Math.round(dollars * 100),
  currency: "USD",
};
```

**Reference:** `rates.js:693-863`.

#### UPS Rating v2403

- **Endpoint:** `POST https://onlinetools.ups.com/api/rating/v2403/Shop`
- **Auth:** OAuth 2.0 client-credentials (Basic-auth token grant), Bearer token (TTL ~4 hours, cached)
- **Advantage:** `/Shop` returns rates for **all available services in one call** (unlike USPS which is per-class).

**Required request body** (deeply nested, TitleCase, all numeric values as strings):

```json
{
  "RateRequest": {
    "Request": {
      "RequestOption": "Shop",
      "TransactionReference": { "CustomerContext": "NS Retail checkout" }
    },
    "Shipment": {
      "Shipper": {
        "Name": "NS Retail",
        "ShipperNumber": "XXXXXX",
        "Address": { "AddressLine": ["..."], "City": "...", "StateProvinceCode": "CA",
                     "PostalCode": "94707", "CountryCode": "US" }
      },
      "ShipTo": { "Name": "Customer", "Address": { /* destination */ } },
      "ShipFrom": { "Name": "NS Retail", "Address": { /* origin */ } },
      "Package": {
        "PackagingType": { "Code": "02", "Description": "Customer Supplied" },
        "Dimensions": { "UnitOfMeasurement": { "Code": "IN" },
                        "Length": "10", "Width": "8", "Height": "4" },
        "PackageWeight": { "UnitOfMeasurement": { "Code": "LBS" }, "Weight": "0.5" }
      }
    }
  }
}
```

**UPS gotchas:**
- All numeric values are **strings** (`"10"` not `10`).
- Nested casing is TitleCase (`RateRequest`, `Shipper`, `Package`) — case-sensitive.
- `ShipperNumber` must match the account credentials.
- Request headers: `transId` (unique per call, for UPS deduplication) + `transactionSrc: "NS_Retail"`.

**Response parsing:**

```js
// Response: { RateResponse: { RatedShipment: [...] } } (or a single object if only one service)
const rsArr = Array.isArray(rsRaw) ? rsRaw : rsRaw ? [rsRaw] : [];
return rsArr.map((rs) => ({
  carrier: "UPS",
  service: UPS_SERVICE_NAMES[rs?.Service?.Code] || `Service ${rs?.Service?.Code}`,
  rateCents: Math.round(Number(rs?.TotalCharges?.MonetaryValue) * 100),
  currency: rs?.TotalCharges?.CurrencyCode || "USD",
  deliveryDateMin: /* addBusinessDaysIso(GuaranteedDelivery.BusinessDaysInTransit) */,
  deliveryDateMax: /* same */,
})).filter(Boolean);
```

**UPS service code → label** map:

| Code | Service |
|------|---------|
| 01 | Next Day Air |
| 02 | 2nd Day Air |
| 03 | Ground |
| 07 | Worldwide Express |
| 08 | Worldwide Expedited |
| 11 | Standard |
| 12 | 3 Day Select |
| 13 | Next Day Air Saver |
| 14 | Next Day Air Early |
| 54 | Worldwide Express Plus |
| 59 | 2nd Day Air A.M. |
| 65 | Saver |

**Reference:** `rates.js:879-1049`.

---

### 5.10 Rate Deduplication

Both USPS and UPS may return services under similar labels (e.g., "Ground"). Dedup keeps the **cheapest** variant per unique `(carrier, service)` key:

```js
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
```

The generated `code` also becomes the `service_code` returned to Shopify (used for shipping method identification during checkout completion).

**Reference:** `rates.js:1265-1275`.

---

### 5.11 Processing Fee Formula (Core Calculation)

For each unique rate, the fee bundle math is:

```
shippingCents      = isFreeShipping ? 0 : (rawCarrierRate + handlingMarkup)
shippingTaxCents   = round(shippingCents × taxRate)     // most US states tax shipping
totalTaxCents      = baseTaxCents + shippingTaxCents
feeBaseCents       = cartSubtotalCents + shippingCents + totalTaxCents
processingFeeCents = round(feeBaseCents × 0.03)
finalCents         = shippingCents + processingFeeCents   // what Shopify sees
```

Key observations:

- **`baseTaxCents`** comes from Shopify's tax API (or 0 on cache miss / failure).
- **`taxRate`** is derived from `baseTaxCents / cartSubtotalCents` — used to scale tax onto shipping cost. This assumes the destination's tax rules treat shipping the same as merchandise (true in most US states).
- **`feeBase`** intentionally includes tax so the fee compensates for merchant's tax remittance overhead too. This is a business decision, not a technical constraint.
- **Free shipping still charges the 3% fee** — `feeBase` = subtotal + $0 shipping + tax. The fee is a payment-processing surcharge independent of the shipping charge.

**Reference:** `rates.js:1283-1298`.

---

### 5.12 Response Assembly

Each rate is packaged into Shopify's mandated format:

```js
{
  service_name: isFreeShipping
    ? `${baseName} (Free shipping + 3% processing fee)`
    : `${baseName} (incl. handling + 3% processing fee)`,
  service_code: r.code,                    // e.g. "USPS_GROUND_ADVANTAGE"
  total_price: String(finalCents),         // STRING in CENTS — critical
  currency: r.currency || "USD",
  description: isFreeShipping
    ? `Complimentary shipping on ${vendor} orders over $${threshold} · 3% processing fee $${feeUsd}`
    : `${carrier} ${service} (includes handling + 3% processing fee $${feeUsd}, calculated on subtotal + shipping + tax $${taxUsd})`,
  min_delivery_date: /* optional ISO date */,
  max_delivery_date: /* optional ISO date */,
}
```

**Shopify's contract requirements:**
- `total_price` must be a **string in cents** — a number or dollar-formatted string is silently rejected.
- The entire response must be HTTP 200 — 4xx/5xx breaks checkout (customer sees "no shipping available").
- Empty rates (`{ rates: [] }`) is valid — Shopify shows the same "no shipping" message but doesn't error the page.

**Sort order:** Rates are sorted cheapest-first by `total_price` so the least expensive option appears at the top of the checkout UI.

**Reference:** `rates.js:1327-1353`, helper `ratesResponse()` at `rates.js:225-231`.

---

## 6. Object Reference — All 5 API Contracts

### 6.1 Inbound: Shopify → Our Endpoint

**Endpoint:** `POST /api/shipping/rates`
**Content-Type:** `application/json`
**Body:**

```json
{
  "rate": {
    "origin": {
      "country": "US",
      "postal_code": "94707",
      "province": "CA",
      "city": "Berkeley",
      "address1": "Los Angeles Ave",
      "latitude": 37.8900525,
      "longitude": -122.2716314,
      "phone": "+1...",
      "company_name": "NS Direct Order stagging-1"
    },
    "destination": {
      "country": "US",
      "postal_code": "90001",
      "province": "CA",
      "city": "Los Angeles",
      "address1": "1233"
    },
    "items": [
      {
        "name": "Natural Solutions Training",
        "sku": null,
        "quantity": 1,
        "grams": 0,
        "price": 180000,
        "vendor": "Product Training",
        "requires_shipping": true,
        "taxable": false,
        "fulfillment_service": "manual",
        "properties": {},
        "product_id": 9138436538610,
        "variant_id": 49664288030962
      }
    ],
    "currency": "USD",
    "locale": "en",
    "order_totals": {
      "subtotal_price": 180000,
      "total_price": 180000,
      "discount_amount": 0
    },
    "customer": null
  }
}
```

**Key notes:**
- `price` is in **cents** (Shopify's convention).
- `order_totals` may or may not be present depending on Shopify's payload version — our discount detection has fallbacks.
- `customer` is often `null` (staging store / guest checkout).

### 6.2 Outbound: Our Endpoint → USPS

**Endpoint:** `POST https://apis.usps.com/prices/v3/base-rates/search`
**Headers:**
```
Authorization: Bearer <oauth_token>
Content-Type: application/json
Accept: application/json
```

**Body** (one request per mail class):

```json
{
  "originZIPCode": "94707",
  "destinationZIPCode": "90001",
  "weight": 0.5,
  "length": 10,
  "width": 8,
  "height": 4,
  "mailClass": "USPS_GROUND_ADVANTAGE",
  "processingCategory": "MACHINABLE",
  "rateIndicator": "SP",
  "destinationEntryFacilityType": "NONE",
  "priceType": "COMMERCIAL",
  "mailingDate": "2026-07-08"
}
```

**Response:**

```json
{
  "totalBasePrice": 5.72,
  "rates": [
    { "price": 5.72, /* details */ }
  ]
}
```

**We extract:** `totalBasePrice` (dollars → cents).

### 6.3 Outbound: Our Endpoint → UPS

**Endpoint:** `POST https://onlinetools.ups.com/api/rating/v2403/Shop`
**Headers:**
```
Authorization: Bearer <oauth_token>
Content-Type: application/json
Accept: application/json
transId: ns-<timestamp>
transactionSrc: NS_Retail
```

**Body** — see Section 5.9 for the full nested structure.

**Response:**

```json
{
  "RateResponse": {
    "RatedShipment": [
      {
        "Service": { "Code": "03", "Description": "Ground" },
        "TotalCharges": { "MonetaryValue": "10.40", "CurrencyCode": "USD" },
        "GuaranteedDelivery": { "BusinessDaysInTransit": "3" }
      }
    ]
  }
}
```

**We extract:** `RatedShipment[].Service.Code` → label lookup, `TotalCharges.MonetaryValue` → cents.

### 6.4 Outbound: Our Endpoint → Shopify Admin (Tax)

**Endpoint:** `POST https://<shop>.myshopify.com/admin/api/2026-07/graphql.json`
**Headers:**
```
Content-Type: application/json
Accept: application/json
X-Shopify-Access-Token: shpat_xxxxxxxx
```

**Body:**

```json
{
  "query": "mutation CalcTax($input: DraftOrderInput!) { draftOrderCalculate(input: $input) { calculatedDraftOrder { totalTaxSet { shopMoney { amount currencyCode } } taxLines { title rate ratePercentage priceSet { shopMoney { amount } } } } userErrors { field message } } }",
  "variables": {
    "input": {
      "lineItems": [
        { "variantId": "gid://shopify/ProductVariant/49664288030962", "quantity": 1 }
      ],
      "shippingAddress": {
        "countryCode": "US",
        "provinceCode": "CA",
        "zip": "90001",
        "city": "Los Angeles",
        "address1": "1234 Apple St",
        "firstName": "Test",
        "lastName": "User"
      },
      "presentmentCurrencyCode": "USD"
    }
  }
}
```

**Requirements:**
- `variantId` **must be in GID format** (`gid://shopify/ProductVariant/XXX`), not a raw numeric ID.
- `shippingAddress.countryCode` and `provinceCode` are **critical for tax calculation** — omit them and Shopify silently returns tax = 0.
- The Admin API token requires `write_draft_orders` scope.

**Response:**

```json
{
  "data": {
    "draftOrderCalculate": {
      "calculatedDraftOrder": {
        "totalTaxSet": { "shopMoney": { "amount": "0.98", "currencyCode": "USD" } },
        "taxLines": [
          { "title": "California State Tax", "rate": 0.06, "ratePercentage": 6.0,
            "priceSet": { "shopMoney": { "amount": "0.60" } } },
          { "title": "Alameda Co Local Tax Sl", "rate": 0.01, "ratePercentage": 1.0,
            "priceSet": { "shopMoney": { "amount": "0.10" } } }
        ]
      },
      "userErrors": []
    }
  },
  "extensions": {
    "cost": { "requestedQueryCost": 11, "actualQueryCost": 11 }
  }
}
```

**Real observed latency:** ~2–12 seconds (highly variable). This is why the fetch runs in the background rather than blocking the carrier callback.

**We extract:** `calculatedDraftOrder.totalTaxSet.shopMoney.amount` (dollars → cents).

### 6.5 Outbound: Our Endpoint → Shopify Checkout

**HTTP Status:** Always `200` (4xx/5xx breaks the checkout page).
**Content-Type:** `application/json`
**Body:**

```json
{
  "rates": [
    {
      "service_name": "USPS Ground Advantage (incl. handling + 3% processing fee)",
      "service_code": "USPS_GROUND_ADVANTAGE",
      "total_price": "830",
      "currency": "USD",
      "description": "USPS Ground Advantage (includes handling + 3% processing fee $0.58, calculated on subtotal + shipping + tax $1.74)",
      "min_delivery_date": "2026-07-11",
      "max_delivery_date": "2026-07-15"
    },
    { /* additional rates ... */ }
  ]
}
```

**Contract must-haves:**
- `total_price` = string in cents (e.g. `"830"` for $8.30).
- `service_name` and `service_code` present and unique.
- `currency` valid ISO code.
- Empty array (`{ "rates": [] }`) is valid — Shopify shows "no shipping available."

---

## 7. Real Sample Trace (From Production Logs)

Below is an actual log capture from a $10 cart to CA (2026-07-08 local dev). It demonstrates the full flow, including the fire-and-forget tax pattern.

**Callback #1 — Cache miss, background fetch starts:**

```
[shipping.rates] inbound: 1 line(s) (0 processing-fee excluded), realQty=1, dest=US/CA/90001
[shipping.rates] no cart discount detected in payload (source=none); fee will use raw subtotal=$10.00
[shipping.rates] shopify tax MISS — background fetch started for cache key
[shipping.rates] processing-fee inputs: subtotal=$10.00 · taxRate=0.00% · state=CA · taxSource=api_unavailable
[shipping.rates.breakdown] USPS Ground Advantage
    ├─ Raw carrier rate:     $5.72
    ├─ Handling markup:      $2.00 (tier: 1-2 items)
    ├─ Free-shipping active: no
    ├─ Shipping (final):     $7.72 (raw + handling)
    ├─ Raw items sum:        $10.00
    ├─ Cart discount:        $0.00 (none)
    ├─ Cart subtotal (net):  $10.00
    ├─ Base tax on subtotal: $0.00 (source: api_unavailable)
    ├─ Shipping tax:         $0.00 (rate 0.000% × shipping)
    ├─ Total tax:            $0.00
    ├─ Fee base:             $17.72 (net subtotal + shipping + tax)
    ├─ Processing fee (3%):  $0.53
    └─ Final rate to Shopify: $8.25
[shipping.rates] Direct carriers OK: 4 real rate(s), tiered markup=$2 on 1 item(s) + 3% processing fee
POST /api/shipping/rates 200 - - 2100 ms                          ← Response fast
```

**Meanwhile in the background (~3s later):**

```
[shipping.rates] shopify tax [bg] OK — tax=$0.98 · elapsed=2965ms · cache now WARM
```

**Callback #2 (a few seconds later, e.g. user selects shipping) — Cache hit:**

```
[shipping.rates] inbound: 1 line(s) ..., realQty=1, dest=US/CA/90001
[shipping.rates] no cart discount detected in payload (source=none)
[shipping.rates] processing-fee inputs: subtotal=$10.00 · taxRate=9.80% · state=CA · taxSource=shopify_cached
[shipping.rates.breakdown] USPS Ground Advantage
    ├─ Base tax on subtotal: $0.98 (source: shopify_cached)   ← Tax now applied
    ├─ Shipping tax:         $0.76 (rate 9.800% × shipping)
    ├─ Total tax:            $1.74
    ├─ Fee base:             $19.46 (net subtotal + shipping + tax)
    ├─ Processing fee (3%):  $0.58                              ← was $0.53
    └─ Final rate to Shopify: $8.30                              ← was $8.25
```

**Customer sees at checkout:**

| Item | Amount |
|------|--------|
| Subtotal | $10.00 |
| Shipping (USPS Ground Advantage) | **$8.30** |
| Estimated taxes | $0.98 |
| **Total** | **$19.28** |

---

## 8. Error Handling & Fallback Behavior

The endpoint is designed to **never break the checkout page**. All error paths return HTTP 200 with either useful rates or an empty list.

| Failure Mode | Behavior |
|--------------|----------|
| Invalid JSON body | Log error, return `{ rates: [] }` → checkout shows "no shipping available" |
| Missing `rate.destination` or `rate.items` | Log warn, return `{ rates: [] }` |
| Total quantity is 0 (all items filtered) | Return `{ rates: [] }` |
| HMAC header mismatch | Log warn, **accept anyway** (see 5.1) |
| USPS credentials missing | Silent skip (USPS returns `[]`) |
| USPS OAuth failure | Log error, USPS returns `[]`; UPS still runs |
| USPS 401 (token expired) | Delete cached token, USPS returns `[]` for this call; next call re-auths |
| USPS individual class 400 error | Log error for that class only, other classes proceed |
| UPS credentials missing | Silent skip |
| UPS OAuth failure | Log error, UPS returns `[]`; USPS still runs |
| UPS 401 | Delete cached token, UPS returns `[]` |
| Both carriers return `[]` | Return `{ rates: [] }` — no placeholder pricing (2026-06-22 policy) |
| Tax API fetch error (background) | Log warn, no cache entry created; next callback continues with `taxCents = 0` |
| Tax API timeout (>30s in background) | Log warn, no cache entry; retried on next cache-miss |

---

## 9. Caching & Performance

### In-memory caches

**Tax result cache** (`_shopifyTaxCache`):
- Key: `country|state|zip|subtotalCents|variants`
- Value: `{ taxCents, cachedAt }`
- TTL: 5 minutes
- Max entries: 1000 (LRU eviction via Map insertion order)

**In-flight fetch tracker** (`_shopifyTaxInFlight`):
- `Set<cacheKey>`
- Prevents duplicate concurrent background fetches when Shopify fires multiple carrier callbacks in rapid succession.

**OAuth token cache** (`tokenCache`):
- Keys: `"usps"`, `"ups"`
- Value: `{ token, expiresAt }`
- TTL: from provider (USPS ~3600s, UPS ~14400s)
- On 401 response, cached token is deleted; next request re-authenticates.

### Response time targets

| Scenario | Typical Response Time |
|----------|----------------------|
| Cold start (no tokens cached, tax cache miss) | 1.5–2.5s |
| Warm (all tokens + tax cache hits) | 0.5–1.0s |
| Both carriers 401 (invalidated tokens) | 2.5–3.5s (double round-trip for re-auth) |
| One carrier fails (network timeout) | Same as the other carrier's time |

**Hard budget:** Must respond within 10s (Shopify's limit). We use a 5s per-carrier `AbortController` timeout to stay comfortably under it, even in the worst case where both carriers hit their timeout.

### Memory bounds

- Tax cache: 1000 entries × ~200 bytes = ~200KB
- Token cache: 2 entries, ~1KB total

Trivial memory footprint for a long-running Node instance.

---

## 10. Environment Variables

| Variable | Purpose | Required |
|----------|---------|----------|
| `USPS_CLIENT_ID` | USPS Web Tools v3 OAuth client ID | Yes (for USPS rates) |
| `USPS_CLIENT_SECRET` | USPS Web Tools v3 OAuth secret | Yes (for USPS rates) |
| `USPS_API_BASE` | Override for sandbox (default: `https://apis.usps.com`) | Optional |
| `UPS_CLIENT_ID` | UPS OAuth client ID | Yes (for UPS rates) |
| `UPS_CLIENT_SECRET` | UPS OAuth secret | Yes (for UPS rates) |
| `UPS_SHIPPER_NUMBER` | UPS account number (6 chars) | Yes (for UPS rates) |
| `UPS_API_BASE` | Sandbox override (default: `https://onlinetools.ups.com`) | Optional |
| `SHOPIFY_API_SECRET` | HMAC verification key (log-only comparison) | Optional |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Admin API token for tax `draftOrderCalculate` | Yes (for tax) |
| `SHOPIFY_ADMIN_API_VERSION` | GraphQL API version (default: `2026-07`) | Optional |
| `RETAIL_SHOP_DOMAIN` / `SHOPIFY_SHOP` | Fallback shop domain if header missing | Optional |

**Setup notes:**
- USPS: register at [registration.usps.com](https://registration.usps.com), enable APIs, generate OAuth credentials.
- UPS: [developer.ups.com](https://developer.ups.com) → My Apps → OAuth 2.0.
- Shopify Admin Token: Store admin → Settings → Apps and sales channels → Develop apps → your custom app → API credentials. Must have `write_draft_orders` scope. Regenerate after any scope change.

---

## 11. Testing & Verification

### Local development

```powershell
cd ns-retail
shopify app dev
```

This starts a local server behind a Cloudflare tunnel URL that Shopify uses for the carrier callback during dev testing.

### Direct carrier callback test (bypass Shopify)

Use Postman or curl to POST to `http://localhost:3000/api/shipping/rates` (or the tunnel URL) with a synthetic Shopify payload. See Section 6.1 for the payload shape.

### Tax API verification

Independently test the Shopify Admin API using curl/Postman:

```bash
curl -X POST "https://<shop>.myshopify.com/admin/api/2026-07/graphql.json" \
  -H "X-Shopify-Access-Token: shpat_xxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation { draftOrderCalculate(input: { lineItems: [{ variantId: \"gid://shopify/ProductVariant/XXX\", quantity: 1 }], shippingAddress: { countryCode: US, provinceCode: CA, zip: \"90001\" } }) { calculatedDraftOrder { totalTaxSet { shopMoney { amount } } } userErrors { field message } } }"}'
```

### Log-based verification

In Render / local terminal, filter by:
- `[shipping.rates] inbound:` — every callback
- `[shipping.rates.breakdown]` — per-rate calculation trace
- `[shipping.rates] shopify tax [bg]` — background tax fetch status
- `taxSource=shopify_cached` — confirms cache hit
- `taxSource=api_unavailable` — indicates cache miss / background not yet complete

### End-to-end verification

Complete a real checkout with:
1. A US shipping address.
2. A cart totaling under $500 (to skip free-shipping path).
3. Optionally an applied discount code (to verify discount detection).

Watch the Render logs for the sequence: cache miss → background fetch → subsequent callback with cache hit → fee amount slightly higher (tax now included).

---

## Appendix — File Structure

**Companion files:**

- `wholesale/app/api/shipping/rates.js` — parallel implementation for the wholesale store. Currently DOES NOT have the discount detection or async tax patterns; those are ns-retail-only until wholesale is migrated for parity.
- `PROGRAM.md` (repo root) — session changelog documenting the evolution of this file (2026-06-22 static fallback removal, 2026-07-06 processing fee migration, 2026-07-07 discount detection, 2026-07-08 async tax pattern).

**Key symbols in `rates.js`:**

| Symbol | Line | Purpose |
|--------|------|---------|
| `CONFIG` | 56 | Single source of truth for tunable values |
| `tieredMarkupCents()` | 109 | Handling markup by cart quantity |
| `detectCartDiscountCents()` | 132 | 5-path discount detection |
| `ratesResponse()` | 225 | Shopify response envelope |
| `verifyHmac()` | 233 | HMAC comparison (log-only usage) |
| `isProcessingFeeItem()` | 279 | Legacy fee-line filter |
| `resolveShopDomain()` | 355 | Header + env fallback for shop domain |
| `_shopifyTaxCache` | 369 | Tax result cache (Map) |
| `_shopifyTaxInFlight` | 376 | Concurrent-fetch dedup (Set) |
| `buildTaxCacheKey()` | 378 | Cache key composition |
| `MUTATION_DRAFT_ORDER_CALCULATE` | 393 | GraphQL mutation string |
| `calculateShopifyTax()` | 446 | Fast-path (cache-only) |
| `fetchShopifyTaxInBackground()` | 510 | Slow-path (background API fetch) |
| `getCachedToken() / setCachedToken()` | 651 | OAuth token cache |
| `fetchUSPSRates()` | 693 | USPS v3 API integration |
| `fetchUPSRates()` | 879 | UPS Rating v2403 integration |
| `fetchDirectCarrierRates()` | 1052 | Parallel dispatch to both carriers |
| `loader()` / `action()` | 1073 / 1078 | Route handlers (Remix) |

---

**Document maintained alongside `ns-retail/app/api/shipping/rates.js`. When you modify the file, update the relevant section here.**
