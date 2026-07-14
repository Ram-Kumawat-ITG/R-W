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

---
---

# Part II — Recent History, Planned Changes & Client-Facing Ruleset

*Everything below this line was added on 2026-07-13/14 to capture the July client-alignment work. The Part I content above documents the CURRENT implementation. Part II documents the DECIDED CHANGES that are next to be built. Once implemented, Part I sections should be updated and the corresponding Part II section moved into the changelog.*

---

## 12. Recent History — July 2026 Timeline

### 2026-07-06 — Grow-plan migration (processing fee to carrier callback)
The 3% processing fee had been implemented as a Checkout UI Extension (`ns-retail/extensions/processing-fee/`). That extension only works on Shopify Plus. To keep the fee working on Grow, we migrated it into the carrier-service callback (`rates.js`) — the fee got bundled into every returned shipping rate. Documented in earlier sessions.

### 2026-07-07 — Order-level discount detection added
The fee was being over-charged when a customer applied a discount code at checkout (fee was computed on pre-discount subtotal). We added `detectCartDiscountCents()` which probes five payload fields in priority order, and empirically confirmed `rate.order_totals.discount_amount` is the reliable modern field. See §5.6 above.

### 2026-07-07/08 — Tax API architecture rewritten (async fire-and-forget)
The `draftOrderCalculate` mutation was empirically measured at ~12 s TTFB on the staging store — well beyond Shopify's 10 s carrier-callback budget. Inline await was impossible. Rewrote to a two-path architecture: fast synchronous cache-check + fire-and-forget background fetch that warms the cache for subsequent callbacks. See §5.8 above.

### 2026-07-09 — MAJOR ARCHITECTURE PIVOT (two client calls)

Two calls with the client (Call 1 with Stephanie the shipping manager) surfaced fundamental problems with the "algorithm picks a box, we ship in that box" model.

**Problem Stephanie surfaced**: NS does not always stock every box size. They reuse boxes from manufacturers (Neutrophil) and third-party sources (BioLite, etc.). If the algorithm picks a 15×12×9 and they don't have one on hand, they pack in whatever's available — and since our quoted rate is locked at checkout based on the picked box, there is a mismatch between quoted and actual label rate. Small envelopes (9×6×4, 11×9×4) and standard UPS boxes are always in stock; the problem is the larger and less-common tiers.

**Decisions made in the July 9 calls:**

**Decision A — Approval gate on every order (NEW):**
A middle-app approval step is added. For every order, the shipping team sees the proposed box dimensions + weight (what was sent to the carrier). They either APPROVE (one-click, label prints, order ships, invoice sends) or EDIT the dimensions/weight (rate recalculates on the new box, then approve, then ship). Nothing ships until approved. Trace confirmed: this applies to ALL orders, retail and wholesale. Estimated 1–2 hrs/day of team effort, acceptable. **Implication for us**: the algorithm no longer needs to be perfect — the approval gate is a human safety net. Reasonable is enough.

**Decision B — Wholesale "pay immediately" removed (REVERSAL of July-2 decision):**
Because you cannot hold a checkout payment mid-flow while waiting for approval, the pay-immediately-via-Shopify-Payments option is removed from wholesale entirely. All wholesale now flows through invoice-based methods only: card-on-file (NMI), ACH, check — billed on the 15th/EOM batch already built. Trace was explicit that the approval gate matters more than immediate payment. **Not our concern in rates.js** — wholesale checkout flow lives elsewhere.

**Decision C — Manual dimension + weight fields (NEW):**
The middle-app gives the team editable fields for box dimensions AND total package weight per order. Stephanie's team already weighs every package and will continue to; we capture the real weight rather than the algorithm's estimate. **Implication for us**: the weight we compute is a *proposal*, not the final source of truth.

**Decision D — Retail no longer charges the 3% credit card surcharge (NEW):**
Retail customers are not charged the 3% card surcharge. Reason: retail has no alternative payment method (must pay by card), so NS considers it unfair to surcharge. A retail cart of $200 + $10 tax + shipping = exactly that, no card fee. Wholesale still handles its surcharges via NMI on the back end as built. **Implication for us**: the entire fee + tax-fetch machinery documented in §5.8 and §5.11 is being **removed from retail rates.js**.

**Retail shipping — other details from Call 1:**
- Retail customers still see live UPS/USPS rates with markup at checkout and pay on the spot.
- Customer can indicate a carrier preference (UPS vs USPS). We may respect that when returning rates.
- Checkout disclaimer wanted: "shipping is an estimate, final price may change, shown on invoice." **Feasibility flag**: they're on Grow, not Plus — checkout-page customization is heavily limited. Placement of the disclaimer needs to be verified against Grow-plan capabilities separately.
- Rate lock stands: even if the approval gate changes the box and the actual cost changes, the customer's checkout charge does not change. NS absorbs or benefits from the difference.

### 2026-07-13 — Scope narrowed to retail rates.js
Confirmed the scope of this workstream:
- Only `ns-retail/app/api/shipping/rates.js` — no wholesale, no middle-app.
- No checkout-page UI customization (Grow limitation) — everything server-side.
- No product metafields — product classification will be derived from data already in the carrier-callback payload (`items[].name`, `items[].vendor`, `items[].grams`).
- The approval gate, wholesale payment rerouting, and checkout disclaimer are separate workstreams handled elsewhere.

---

## 13. Planned Changes — Retail Shipping (rates.js)

The current implementation (Part I above) charges a 3% fee on top of shipping and asynchronously fetches tax to include in the fee base. Post-July-9 decisions require:

1. **Remove the 3% fee entirely from retail** (Decision D).
2. **Remove the tax-fetch machinery** (no longer needed — nothing to base the fee on).
3. **Add a dynamic box-selection engine** to replace the hardcoded `10×8×4` and `sum(grams)` currently sent to USPS and UPS.
4. **Add product classification derived from payload data** (no metafields).

The final rate returned to Shopify becomes simply:
```
finalCents = shippingCents = rawCarrierRate + handlingMarkupCents
```
(free-shipping and handling-markup logic remain unchanged.)

### 13.1 Product Categories (payload-derived, no metafields)

Every cart line item will be assigned one of eight categories at request time, using only fields present in the Shopify carrier-service payload:

| Code | Category | Detection Signal |
|------|----------|------------------|
| S | `small_bottle` | Weight ≤ ~2 oz (excluding FA) |
| M | `medium_bottle` | Weight 2–3 oz |
| L | `large_bottle` | Weight 3–6 oz, no liquid keyword in name |
| LL | `large_liquid` | Weight > ~18 oz, or name matches known-liquid list (Liquid Life, Miracle II, Zavita, Biomega, Floradix, Enersync case) |
| G1 | `glass_1oz` | Product name contains "1 oz" |
| G2 | `glass_2oz` | Product name contains "2 oz" |
| G4 | `glass_4oz` | Product name contains "4 oz" |
| FA | `frequency_app` | Vendor === "Frequency Apps" |

**Classification cascade priority** (first match wins):
1. Vendor === "Frequency Apps" → `frequency_app`
2. Name matches known-liquid list → `large_liquid`
3. Name contains "1 oz" → `glass_1oz`
4. Name contains "2 oz" → `glass_2oz`
5. Name contains "4 oz" → `glass_4oz`
6. Weight > 500 g (~18 oz) → `large_liquid` (heuristic)
7. Weight > 170 g (~6 oz) → `large_bottle`
8. Weight > 85 g (~3 oz) → `medium_bottle`
9. Weight > 0 → `small_bottle`
10. Missing / zero weight → **fallback**: `large_bottle` + log warning

**Regex for glass size detection**: `/\b(\d+(?:\.\d+)?)\s*oz\.?\b/i` — captures both "1 oz" and "1oz" and "1 oz."; case-insensitive.

**Edge cases flagged** (need client confirmation, see §16):
- Products named "EnerSync 1 oz Case (24 ct.)" — this is a *case of 24*, not a single glass. Needs manual override or a name pattern exclusion.
- Products where the name has an ounce number but the item is not a glass bottle (e.g., "Floradix Iron 8.5 oz | 250 ml" — this is a liquid, not a glass tincture).

### 13.2 Unit-Cost System (derived from Stephanie's rules)

Each product category is assigned a "space score" (unit cost). Each box has a total unit capacity. A cart's total unit demand must be ≤ the box's capacity for that box to be considered a valid pick.

Derivation from Stephanie's stated rules, using the 9×6×4 envelope (which fits 3 small bottles) as the baseline of 3 units:

| Category | Unit Cost | Derivation |
|----------|-----------|------------|
| `small_bottle` (S) | 1 | 3 S fit in 9×6×4 (3 units) |
| `medium_bottle` (M) | 2 | 1 S + 1 M = 3 units → M = 2 |
| `large_bottle` (L) | 3 | 1 L alone fills 9×6×4 |
| `glass_1oz` (G1) | 0.75 | 4 G1 fit in 9×6×4 → 3 / 4 |
| `glass_2oz` (G2) | 1 | 3 G2 fit in 9×6×4 → 3 / 3 |
| `glass_4oz` (G4) | 3 | 1 G4 alone fills 9×6×4 |
| `frequency_app` (FA) | 0.15 | 60 FA fit in 11×9×4 (9 units) → 9 / 60 |
| `large_liquid` (LL) | N/A | Uses a separate `liquids` capacity dimension |

Cross-check with 11×9×4 envelope:
- 3 L = 9 units → capacity ≥ 9 (matches "3 large bottles fit")
- 4 M = 8 units, 5 M = 10 units → matches "4 to 5 medium" borderline
- 6 S = 6 units → matches "6 small bottles fit"

The math is self-consistent with Stephanie's stated rules.

---

## 14. Box Ruleset (Client-Facing, Approval-Ready)

This is the version to send to Trace + Stephanie for sign-off. Each box lists (a) Stephanie's original rule, (b) our derived exact rule, and (c) example combinations.

### 14.1 Envelopes

#### 9×6×4 Envelope (SMALL ENVELOPE) — tare 2.7 oz

**Stephanie**: "Up to 3 small bottles / 1 small + 1 medium / 1 large (non-liquid) / 4 × 1oz glass / 3 × 2oz glass / 1 × 4oz glass"

**Exact rule**: Fits any combination totaling ≤ **3 units**.
- 3 × S / 1 × S + 1 × M / 1 × L / 4 × G1 / 3 × G2 / 1 × G4
- Mixed: 2 × S + 1 × G2 = 3 units ✓; 1 × M + 1 × G1 = 2.75 units ✓; 1 × M + 1 × S + 1 × G1 = 3.75 units ✗

**Confirmation needed**: The "1 × 4oz glass could also include 1 small OR 1oz OR 2oz" exception is ignored in unit-math (over-sizes to next box) — acceptable?

#### 11×9×4 Envelope (LARGE ENVELOPE) — tare 0.7 oz

**Stephanie**: "6 small / 4-5 medium / 3 large / 60 Frequency Apps / FA + other products"

**Exact rule**: Fits any combination totaling ≤ **9 units** OR up to 60 FAs.
- 6 × S / 4 × M / 3 × L / 60 × FA
- Mixed: 40 × FA + 3 × S = 9 units ✓; 60 × FA + 1 × S = 10 units ✗

**Confirmation needed**: Should the engine cap medium at 4 (conservative) or allow 5 (matches "4 to 5" language, tighter fit)?

### 14.2 Special-Purpose Small Boxes

#### 8×6×3 UPS Mini Box — tare 2.7 oz — fragile-preferred

**Stephanie**: "If small order with 3+ 1oz/2oz glass bottles, use UPS mini instead of envelope. Fits ~6 × 1oz, 5 × 2oz, or 4 × 4oz."

**Exact rule (trigger)**: Cart has ≥ 3 of (G1 + G2) glass, AND no large liquids, AND space demand ≤ 3 units → 8×6×3 UPS Mini.

**Confirmation needed**: What defines "small cart" for the trigger — space demand ≤ 3 units? Or ≤ 6 total items?

### 14.3 Liquid Boxes (ordered by liquid capacity)

| Box | Tare | Liquids Cap | Extras (units) | Stephanie's Language |
|-----|------|-------------|----------------|-----------------------|
| 8×6×6 | 3.9 oz | 1 | 3 | "1 large liquid + a few extras" |
| 10×7×6 | 5.0 oz | 2 | 4 | "2 large liquids + a few extras" |
| 11×4×12 | 5.7 oz | 3 | 4 | "3 large liquids + a few extras" |
| 16×11×3 | 7.5 oz | 4 | 4 | "4 large liquids + a few extras" |
| 12×12×5 | 9.6 oz | 4 | 4 | "4 large liquids + a few extras" |
| **18×13×3** | 9.3 oz | 6 | **0 (strict)** | "Up to 6 large liquids" *(no extras stated)* |
| 15×12×9 | 11.5 oz | 12 | 6 | "Up to 12 large liquids + a few extras" |
| 18×14×8 | ~14 oz *(estimated)* | 16 | 8 | "Up to 16 large liquids + a few extras" |

**Rule**: A box is a valid pick if `box.liquids ≥ largeLiquidCount AND box.units ≥ unitDemand-of-non-liquid-items`.

**Confirmations needed** (see §16):
- The "extras" numbers per box (currently our best-guess estimates).
- Whether 18×13×3 is truly liquids-only, or extras were accidentally omitted from the source rule.
- The estimated 14 oz tare for 18×14×8 pending Trace's actual measurement.

### 14.4 Enersync (Partitioned Boxes for 12+ Glass)

**Stephanie**: "If 12+ glass bottles, use an Enersync box (partitions protect glass)."

| Box | Dims | Tare | Trigger |
|-----|------|------|---------|
| Enersync 1oz | 10×7×6 | 7.0 oz | Total glass ≥ 12 AND majority = 1oz size |
| Enersync 2oz | 11×7×8 | 13.2 oz | Total glass ≥ 12 AND majority = 2oz size |

**Rule**: `totalGlass = G1 + G2 + G4`. If `totalGlass ≥ 12`, pick Enersync 1oz if `G1 ≥ G2 + G4`, else Enersync 2oz.

**Confirmation needed**: Enersync boxes are glass-only, no other product types mixed in — correct?

---

## 15. Selection Algorithm — Priority Order

When a cart arrives, the engine evaluates in this exact order (first matching case wins):

```
STEP 1: Total glass (G1 + G2 + G4) ≥ 12
        → Enersync (1oz or 2oz by majority)

STEP 2: (G1 + G2) ≥ 3 AND largeLiquids == 0 AND unitDemand ≤ 3
        → 8×6×3 UPS Mini (fragile-preferred)

STEP 3: largeLiquids > 0
        → Iterate liquid boxes smallest to largest;
          return first where box.liquids ≥ largeLiquids AND box.units ≥ unitDemand
        → Iteration order:
             8×6×6 → 10×7×6 → 11×4×12 → 16×11×3 → 12×12×5
                   → 18×13×3 → 15×12×9 → 18×14×8

STEP 4: frequencyApps > 0
        → If FA ≤ 60 AND unitDemand ≤ 6 → 11×9×4 envelope
        → Otherwise, next larger box that fits

STEP 5: Bottles/glass only, no liquids
        → unitDemand ≤ 3 → 9×6×4 envelope
        → unitDemand ≤ 9 → 11×9×4 envelope
        → Larger → next non-liquid box tier

STEP 6: Nothing fits (overflow)
        → Return largest tier + log warning
          (approval gate will handle it manually)
```

**Selection principle**: at each step, pick the smallest valid box (cheaper shipping). When two boxes tie on capacity, prefer the one with lighter tare weight.

---

## 16. Pending Client Confirmations

These decisions block the build. Answers requested from Trace + Stephanie:

### Q1. "A few extras" quantification per liquid box

| Box | Our Estimate | Stephanie's Number |
|-----|--------------|--------------------|
| 8×6×6 | 3 units | ? |
| 10×7×6 | 4 units | ? |
| 11×4×12 | 4 units | ? |
| 16×11×3 | 4 units | ? |
| 12×12×5 | 4 units | ? |
| 15×12×9 | 6 units | ? |
| 18×14×8 | 8 units | ? |

### Q2. 18×13×3 — strict liquids only?
Is this box reserved for large liquids only, or was "a few extras" accidentally omitted from the source rule?

### Q3. Frequency App unit cost
Our estimate: 1 FA = 0.15 units (because 60 FA = 9 units = capacity of 11×9×4). Reasonable?

### Q4. Medium bottle in 11×9×4 — 4 or 5?
Cap at 4 (conservative) or allow up to 5 (matches "4 to 5" language)?

### Q5. Enersync boxes — glass only?
No other product types (small bottles, FAs, etc.) can be mixed into Enersync boxes — correct?

### Q6. "Small cart" definition for UPS mini trigger
"3+ 1oz/2oz glass with SMALL cart" — is "small cart" defined as:
- Space demand ≤ 3 units?
- Total items ≤ 5?
- No large bottles present?

### Q7. Unmeasured box tare weights
- When will Trace weigh the 18×14×8 to replace our ~14 oz estimate?
- Should we also add 16×12×10 and 13×13×10 to the algorithm's tier list? Or stick with the current 13 tiers?

### Q8. Overlap / conflict resolution
When multiple boxes could fit the same cart: prefer smallest (cheaper) or larger with room (safer packing)?

Our current logic: smallest-that-fits (cheaper). Confirm?

### Q9. Packing-material weight buffer (Stephanie)
Our estimates:
- Envelope: +2 oz (bubble mailer + paper)
- Box: +5 oz (packing peanuts + tape + paper)

Stephanie's worst-case number for each?

---

## 17. Implementation Phases (Scope: rates.js Only)

| Phase | Purpose | Effort | Blocking |
|-------|---------|--------|----------|
| 1 | Cleanup: remove 3% fee + tax-fetch machinery | ~1 hour | None |
| 2 | Product classification logic (name/vendor/weight cascade) | ~2–3 hours | Q1 answers not needed; heuristic thresholds can iterate |
| 3 | PACKING config block (categories, boxes, buffers) | ~30 min | Q1, Q3, Q9 answers |
| 4 | `selectBox(cartItems)` algorithm implementation | ~4–5 hours | Q2, Q4, Q5, Q6, Q8 answers |
| 5 | `computePackageWeight()` helper | ~30 min | Q9 answer |
| 6 | Wire real dims + weight into `fetchUSPSRates()` and `fetchUPSRates()` | ~1 hour | Phases 3–5 complete |
| 7 | Logging updates + edge-case testing | ~1–2 hours | Above phases complete |

**Total coding time**: ~1–2 days of implementation, plus 1–2 days of iteration against client feedback.

**Phase 1 can start immediately** — no client input required. Phases 3+ block on Q1–Q9 answers.

### Post-implementation code impact

| Feature | Current | After |
|---------|---------|-------|
| USPS + UPS live carrier APIs | ✅ Working | ✅ Keep — same use |
| Handling markup ($2/$3/$5 tiered) | ✅ Working | ✅ Keep — Trace confirmed "markup logic preserved" |
| Free shipping rule (NS vendor + $500) | ✅ Working | ✅ Keep — no change |
| Discount detection (order_totals) | ✅ Working | ❌ Remove — was only feeding into the fee base |
| Async tax fetch (draftOrderCalculate) | ✅ Working | ❌ Remove — no fee to calculate on |
| 3% processing fee | ✅ Working | ❌ Remove — Decision D |
| Hardcoded 10×8×4 dims | ⚠️ Existing shortcut | 🔨 Replace with `selectBox()` |
| Hardcoded weight = Σ grams | ⚠️ Existing shortcut | 🔨 Replace with `computePackageWeight()` |
| Fee breakdown log | Detailed | 🔨 Simplify (no fee to break down) |
| `service_name` includes "3% processing fee" text | Yes | 🔨 Remove that phrase |

**Estimated deletions**: ~200 lines (tax cache, in-flight tracker, GraphQL mutation, cache-key builder, `calculateShopifyTax`, `fetchShopifyTaxInBackground`, discount detection code, fee-computation lines in the response assembly).

**Estimated additions**: ~350 lines (`classifyProduct`, `PACKING` config, `selectBox`, `computePackageWeight`, updated logs).

---

## 18. Open Questions Requiring Non-Client Answers

These do not need Trace or Stephanie — they need Parker (PM), a Grow-plan feasibility check, or a code investigation:

1. **Cleanup approach**: delete fee code outright, or leave behind a `CONFIG.processingFeeRate = 0` toggle? *(Recommendation: delete — git history preserves.)*
2. **Async tax fetch removal**: confirm no other code path depends on `_shopifyTaxCache` before deletion.
3. **Wholesale**: `wholesale/app/api/shipping/rates.js` will remain UNCHANGED in this workstream. Confirmed.
4. **Grow-plan feasibility for retail checkout**: what disclaimer text placement is actually possible on Grow? (Blocks the "shipping is an estimate" message from Call 1.)
5. **Carrier preference**: is it worth implementing "customer picks UPS vs USPS" via a cart-page block, or defer that as v1.5?
6. **Pirate Ship reference test**: Parker to share screenshot + cart composition so we can construct the exact reproduction test case.
7. **Real-order validation tolerance**: sample size + acceptable variance % for post-launch validation.
8. **New products classification**: when a merchant adds a new product later, does the automatic classifier suffice, or should we build a manual override mechanism?

---

## 19. Reference Files & Sources

- **Current code**: `ns-retail/app/api/shipping/rates.js`
- **Wholesale parallel (unchanged in this workstream)**: `wholesale/app/api/shipping/rates.js`
- **Session changelog**: `PROGRAM.md` (repository root)
- **Product weight sheet**: `Inventory_Weights__1___1_.xlsx` (provided by Trace, includes 638 products and 13 box/envelope tare weights)
- **Client-provided rules (Stephanie)**: verbatim in the July 8 directive email and re-quoted in §14 above
- **Approval-gate architecture**: separate workstream, not documented here
- **Wholesale payment reroute**: separate workstream, not documented here

---

## 20. Change Log for Part II

| Date | Change |
|------|--------|
| 2026-07-06 | Initial fee migration from Checkout UI Extension to carrier callback |
| 2026-07-07 | Order-level discount detection added |
| 2026-07-07/08 | Async fire-and-forget tax fetch implemented |
| 2026-07-08 | Box-selection directive received from Parker |
| 2026-07-09 | Client calls: approval gate decided, wholesale immediate-pay reversed, 3% fee removed for retail |
| 2026-07-13 | Scope narrowed to `rates.js` only; no metafields, payload-derived classification |
| 2026-07-14 | Client-facing ruleset drafted (§14), pending confirmations recorded (§16), implementation phases documented (§17) |

---

**Awaiting client confirmations (Q1–Q9 in §16) before Phase 3 onward can start. Phase 1 (fee + tax cleanup) can begin at any time as it depends on no external input.**
