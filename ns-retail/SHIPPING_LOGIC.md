# NS-Retail Shipping Logic — Technical Documentation

**File:** [`ns-retail/app/api/shipping/rates.js`](app/api/shipping/rates.js)
**Endpoint:** `POST /api/shipping/rates` (Shopify Carrier Service callback)
**Purpose:** On every checkout re-render, Shopify POSTs the cart + destination to this endpoint. We classify each product by its `pack:XXX` tag, pick the smallest packing box that fits, compute the real package weight, call USPS + UPS with those dimensions, and return the live shipping options + the picked box to the customer.

> **Living doc.** Update this file **every time** we change anything in `rates.js` (algorithm, thresholds, tag mapping, carrier config, etc.). If code and doc disagree, code wins — but that's a bug in this doc, fix it.

**Last updated:** 2026-07-16 (pure tag-based classifier rollout)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [High-Level Architecture](#2-high-level-architecture)
3. [End-to-End Request Flow](#3-end-to-end-request-flow)
4. [CONFIG Block](#4-config-block)
5. [PACKING Config — Boxes & Unit Costs](#5-packing-config--boxes--unit-costs)
6. [Product Classification — Pure Tag-Based](#6-product-classification--pure-tag-based)
7. [Box Selection Algorithm — 6-Step Priority](#7-box-selection-algorithm--6-step-priority)
8. [Package Weight Computation](#8-package-weight-computation)
9. [Carrier Integrations — USPS + UPS](#9-carrier-integrations--usps--ups)
10. [Handling Markup — Tiered by Cart Quantity](#10-handling-markup--tiered-by-cart-quantity)
11. [Free Shipping Rule](#11-free-shipping-rule)
12. [Discount Detection (Logging Only)](#12-discount-detection-logging-only)
13. [Processing Fee Line Filter (Defensive)](#13-processing-fee-line-filter-defensive)
14. [HMAC Verification (Log-Only)](#14-hmac-verification-log-only)
15. [Response Assembly + What the Customer Sees](#15-response-assembly--what-the-customer-sees)
16. [Missing-Tag Behavior](#16-missing-tag-behavior)
17. [Environment Variables](#17-environment-variables)
18. [Observability — Log Grep Patterns](#18-observability--log-grep-patterns)
19. [Testing Checklist](#19-testing-checklist)
20. [Known Gaps / Pending Items](#20-known-gaps--pending-items)
21. [Changelog](#21-changelog)

---

## 1. Executive Summary

`rates.js` is a Shopify **Carrier Service** callback. Shopify invokes it via HTTPS POST during every checkout re-render, sending the customer's cart items + shipping address. The endpoint must respond within 10 seconds with an array of shipping options or an empty list.

**Current business rules** (retail store, as of 2026-07-16):

- **Product classification is pure tag-based** — each product must carry ONE `pack:XXX` tag (9 categories). Missing tag = empty rates.
- **Box selection** — 13 physical box/envelope tiers, picked by a 6-step priority algorithm.
- **Package weight** — computed from real item grams + measured box tare + packing-material buffer.
- **USPS + UPS** — called in parallel with the picked box's dimensions + real weight.
- **Handling markup** — tiered by cart quantity (+$2 / +$3 / +$5).
- **Free shipping** — Natural Solutions vendor items totaling ≥ $500 → all options priced at $0.
- **No processing fee / no tax fetch** — retail no longer charges the 3% card surcharge (2026-07-15 decision); tax is applied by Shopify's native settings on the checkout summary.

Shopify response contract: `{ rates: [{ service_name, service_code, total_price, currency, ... }] }` where `total_price` is a **string in cents**. Endpoint always returns HTTP 200 — even on errors — with `{ rates: [] }` so Shopify can gracefully show "no shipping available" instead of breaking checkout.

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          SHOPIFY CHECKOUT                                │
│      Customer enters address, cart re-renders, applies discount codes    │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │  POST /api/shipping/rates
                               │  Body: { rate: { items, destination, origin, order_totals } }
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   NS-RETAIL BACKEND (Render / Local dev)                 │
│                                                                          │
│   1. HMAC verify (log-only)                                              │
│   2. Parse payload → filter processing-fee lines defensively             │
│   3. Free-shipping rule check ($500+ NS-only cart)                       │
│   4. Compute handling markup tier + log discount for observability       │
│   5. Fetch `pack:XXX` tags in one bulk GraphQL call ──┐                  │
│      (unauthenticated.admin(RETAIL_SHOP_DOMAIN))       │                  │
│   6. Classify cart into 9 categories (S/S1/M/L/LL/     │                  │
│      G1/G2/G4/FA). Any missing tag → return empty     │                  │
│      rates (checkout: "no shipping available")        │                  │
│   7. selectBox() — 6-step priority algorithm →        │                  │
│      picks smallest physical box tier that fits       │                  │
│   8. computePackageWeight() = items + tare + buffer   │                  │
│   9. Fetch USPS + UPS in parallel with real dims +    │                  │
│      weight ──────────────────────────────┐            │                  │
│                                            ▼            │                  │
│              ┌─────────────────┬──────────────────┐    │                  │
│              │ USPS Web Tools  │ UPS Rating v2403 │    │                  │
│              │ v3 (4 mail-class│ (single call →   │    │                  │
│              │  calls parallel)│  all services)   │    │                  │
│              └─────────────────┴──────────────────┘    │                  │
│  10. Dedup by (carrier, service) — cheapest wins       │                  │
│  11. Apply handling markup (or zero if free-shipping)  │                  │
│  12. Attach box info to service_name + description     │                  │
│  13. Sort cheapest-first, return { rates: [...] }      │                  │
└─────────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
                     Customer sees shipping options
```

---

## 3. End-to-End Request Flow

Full step-by-step trace of a single carrier callback:

```
T=0.00s   Shopify POSTs /api/shipping/rates
T=0.01s   HMAC check → LOG-ONLY (always accepted — carrier callbacks
          aren't standard-signed; hard-reject broke prod on 2026-07-06)
T=0.02s   Parse JSON body → { rate: { items, destination, origin, order_totals } }
T=0.03s   Filter items → strip any "Processing Fee" cart lines
          (defensive; UI extension still deployed but currently disabled)
T=0.04s   Compute totalQty → determine handling markup tier
T=0.05s   Free-shipping check:
          - All items' vendor === "Natural Solutions" (case-insensitive)?
          - Cart pre-discount subtotal ≥ $500 USD?
          Both true → shipping cost + handling both zeroed later
T=0.06s   Discount detection — probe 5 payload fields; log only
          (net subtotal doesn't feed into rate math since fee is removed)
T=0.07s   Extract unique product_ids from realItems
T=0.08s   fetchProductTagsFromShopify(productIds) — one bulk GraphQL
          via unauthenticated.admin(shop). Returns Map<productId, tags[]>.
          Auth: uses stored OAuth session for RETAIL_SHOP_DOMAIN.
T=0.15s   classifyCart(items, tagsMap) → { counts, perLine, missing }
          If missing.length > 0 → return { rates: [] } and STOP
T=0.16s   selectBox(classification.counts) → { box, overflow }
T=0.17s   computePackageWeight(realItems, selectedBox)
          → { itemsOz, tareOz, bufferOz, totalOz, totalLbs }
T=0.18s   fetchDirectCarrierRates() — Promise.all([USPS, UPS])
          ├─ USPS: 4 parallel calls (Ground, Priority, First-Class, Express)
          └─ UPS: single call → all services returned in one shot
T=1.50s   Both carriers return; flatten into single array
T=1.51s   Dedup by (carrier, service) — keep cheapest variant per key
T=1.52s   For each unique rate:
          shipping   = isFreeShipping ? 0 : rateCents + handlingMarkup
          finalCents = shipping    (no fee, no tax — Shopify handles tax)
          service_name / description decorated with picked box dims
T=1.53s   Sort rates cheapest-first
T=1.54s   Log per-rate breakdown block for auditability
T=1.55s   Return HTTP 200 with { rates: [...] } in Shopify's mandated shape
```

Typical end-to-end time: 1.5–2.5 seconds (dominated by USPS/UPS API latency).

---

## 4. CONFIG Block

All operational tunables live in one place at the top of `rates.js`. Edit this block to change fees / thresholds / markup / caching — no code hunting elsewhere.

```js
const CONFIG = {
  // Handling markup added to every non-free shipping option, tiered
  // by total cart quantity (values in CENTS on the wire). Keep in
  // sync with the drop-ship reverse-calc in wholesale.
  handlingMarkupCents: {
    upTo2Items: 200, // +$2 for 1-2 items
    threeItems: 300, // +$3 for 3 items
    fourPlusItems: 500, // +$5 for 4+ items
  },

  // Free-shipping rule (both conditions must hold to trigger $0).
  // Vendor match is case-insensitive + trimmed.
  freeShipping: {
    vendor: "Natural Solutions",
    thresholdUsd: 500,
  },
};
```

**No processing fee. No tax config.** Retail decision 2026-07-09: no card surcharge (retail customers have no alternative payment method), Shopify handles tax display on its own settings.

---

## 5. PACKING Config — Boxes & Unit Costs

The box-selection engine sizes each order using two tables + one buffer map.

### 5.1 Unit-cost table

Each category consumes N units of a box's `units` capacity:

| Category | Unit cost | Example products |
|---|---|---|
| S | 0.75 | Chromium 20g, D3 20g, Lypozyme 37g |
| S1 | 1 | Adrenal TLP 77g, Cardio Support, Body RGN |
| M | 2 | Magnesium Complex, Pain Relief Plus |
| L | 3 | Amino Complex, Nerve Health, Stress Focus |
| G1 | 0.75 | 1 oz glass tincture |
| G2 | 1 | 2 oz glass tincture |
| G4 | 1.5 | 4 oz glass tincture |
| FA | 0.15 | Frequency Apps (flat card, ~0.1 oz) |
| LL | — | Uses separate `liquids` slot on liquid boxes |

Derived from the 9x6x4 envelope baseline: 3 × S = 3 units budget, 1 × L = 3 units budget, etc. G4 was corrected from 3 → 1.5 on 2026-07-13 per client.

### 5.2 Box tiers (ordered smallest → largest)

| Name | Type | L×W×H (in) | Tare (oz) | Units | Liquids | Special |
|---|---|---|---|---|---|---|
| 9x6x4 envelope | envelope | 9×6×4 | 0.7 | 3 | 0 | glassMax: 4 |
| 8x6x3 UPS mini | box | 8×6×3 | 2.7 | 3 | 0 | fragilePreferred, glassMax: 6 |
| 11x9x4 envelope | envelope | 11×9×4 | 0.7 | 9 | 0 | faMax: 60 |
| 8x6x6 box | box | 8×6×6 | 3.9 | 3 | 1 | liquid tier |
| 10x7x6 box | box | 10×7×6 | 5.0 | 4 | 2 | liquid tier |
| 11x4x12 box | box | 11×4×12 | 5.7 | 4 | 3 | liquid tier |
| 16x11x3 box | box | 16×11×3 | 7.5 | 4 | 4 | liquid tier |
| 12x12x5 box | box | 12×12×5 | 9.6 | 4 | 4 | liquid tier |
| 18x13x3 box | box | 18×13×3 | 9.3 | 1 | 6 | **tinyExtrasOnly** — rejects any M/L/S1/G* items |
| 15x12x9 box | box | 15×12×9 | 11.5 | 6 | 12 | liquid tier |
| 18x14x8 box | box | 18×14×8 | 17.0 | 8 | 16 | Trace-measured tare (was 14, corrected 2026-07-13) |
| Enersync 1oz | box | 10×7×6 | 7.0 | 4 | 0 | partitioned; glassMin: 12, glassSize: 1oz; 4-unit extras budget for non-glass items |
| Enersync 2oz | box | 11×7×8 | 13.2 | 4 | 0 | partitioned; glassMin: 12, glassSize: 2oz; 4-unit extras budget for non-glass items |

Field notes:
- `units` — non-liquid capacity in unit-cost terms.
- `liquids` — LL (large liquid) capacity.
- `glassMax` — cap on total glass count for that tier.
- `glassMin` — minimum glass count that TRIGGERS this tier (Enersync).
- `faMax` — cap on FA count.
- `partitioned` — Enersync boxes have glass partitions.
- `fragilePreferred` — UPS mini for small-glass safety.
- `tinyExtrasOnly` — 18×13×3 only accepts S + FA as extras alongside liquids, and even S is blocked when the box is at max liquid capacity (6). FA (flat cards) may sit alongside 6 liquids; S bottles cannot. See §7 Step 3.

**Excluded tiers** (per client Q7): 16x12x10 explicitly not used.
**Pending** (per Trace): 13x13x10 tare weight — not added to list until measured.

### 5.3 Packing-material buffer

Added to every package on top of items + tare weight:

```js
packingBufferOz: {
  envelope: 2,   // 2 oz bubble wrap / paper for envelopes
  box: 5,        // 5 oz bubble wrap / peanuts / tape for boxes
}
```

Trace explicitly asked for **over-weight** rather than under (cited a real $3.15 UPS bulge adjustment). Numbers are our estimates pending Stephanie's worst-case measurement.

---

## 6. Product Classification — Pure Tag-Based

### 6.1 Requirement

Every retail Shopify product must carry ONE `pack:XXX` tag naming its packing category. Nine allowed values:

| Tag | Category | Meaning |
|---|---|---|
| `pack:FA` | Frequency Apps | Flat card, ~0.1 oz |
| `pack:LL` | Large liquid | Liquid Life, Miracle II, Zavita, Floradix Iron, Biomega |
| `pack:G4` | 4 oz glass tincture | — |
| `pack:G2` | 2 oz glass tincture | EQ Thyroid Herbal 2 oz (**NOT** EQ B-Complex 2 oz — that's capsules → tag S/S1) |
| `pack:G1` | 1 oz glass tincture | — |
| `pack:L` | Large bottle (non-liquid) | Amino Complex, Nerve Health, Stress Focus |
| `pack:M` | Medium bottle | Magnesium Complex, Pain Relief Plus (definition under review — see §20) |
| `pack:S1` | Small bottle | Adrenal TLP, Cardio Support, Body RGN |
| `pack:S` | Extra-small bottle | Chromium, D3, Lypozyme, Aquamax |
| `pack:XL` | Oversized non-liquid | Body FX (per-product assignment pending Trace's worksheet) |
| `pack:OTHER` | Ships in its own retail box | Three Lac, Trimsulin (per-product assignment pending) |

**Notes on the two pending-taxonomy tags** (structural support added 2026-07-17):

- **`pack:XL`** — accepted by the classifier; routed to the largest tier (18×14×8) with an overflow flag so the merchant approval gate reviews. Once Trace confirms per-product assignments + dedicated dimensions, this can route to a proper XL box.
- **`pack:OTHER`** — same placeholder routing today. The eventual intent (per PM 2026-07-17) is that OTHER products ship in their own retail box using per-product weight + dimension metafields — no engine tier applies. Until those metafields exist, OTHER carts hit overflow and log `pack:OTHER — pending taxonomy` for ops.
- **Any cart with XL or OTHER products** currently logs a warning + returns the largest tier + overflow flag. Approval gate manually reviews before shipping.

**Products awaiting XL vs OTHER assignment** (pending Trace's classification worksheet):
- Body FX — proposed XL (extra-large, non-liquid; NOT liquid despite prior LL tag)
- Circulatory Health — proposed XL or new sub-category (Trace: "doesn't fit any category")
- Control — proposed XL or new sub-category
- Three Lac — proposed OTHER (ships in its own box)
- Trimsulin — proposed OTHER (ships in its own box)

Tag is set by the merchant via Shopify admin → Product edit page → Tags column. Case-tolerant on read (`pack:s1` treated same as `pack:S1`).

### 6.2 Runtime

On every carrier callback:

1. Extract unique `product_id` values from `realItems`.
2. One bulk GraphQL call: `nodes(ids: [Product/1, Product/2, ...]) { tags }` via `unauthenticated.admin(RETAIL_SHOP_DOMAIN)` — auth uses the app's stored OAuth session (same pattern as `customerTags.js` and `cdo.portal.service.js`).
3. Build `Map<productId, tags[]>`.
4. For each cart line, look for a tag starting with `pack:` and take the suffix as the category. Unknown values (typos like `pack:XX`) are treated as missing.
5. Return `{ counts, perLine, missing }` — `counts` is the input to `selectBox`; `missing` is the list of items lacking a valid tag.

### 6.3 Why not from the carrier payload

The Shopify carrier-service payload does **not** include product tags — verified against the 2026-07-07 production payload dump. So we must fetch. One bulk GraphQL per callback is cheaper than one call per product.

### 6.4 Why not weight/name/vendor cascade

The previous cascade (vendor → name regex → weight thresholds) was error-prone: SKUs with "1 oz" in the name (e.g. Enersync case) mis-classified as G1, unspecified products fell into weight buckets that didn't map cleanly, and merchants couldn't override without renaming products. Tag-based is 100% explicit and 100% merchant-controlled.

---

## 7. Box Selection Algorithm — 6-Step Priority

Given the cart's classification counts, `selectBox()` walks 6 rules in order. First match wins. Returns `{ box, overflow }`.

**Step 0 (pending taxonomy) — Any `pack:XL` or `pack:OTHER` → largest tier + overflow**
Cart contains any XL or OTHER category items → route to 18×14×8 with `overflow: true` and log the reason (`pack:XL(n) / pack:OTHER(m) — pending taxonomy`). Merchant approval gate reviews. This is a placeholder until Trace's classification worksheet arrives with per-product assignments + own-box dimensions for OTHER items.

**Step 1 — 12+ glass items, no LL → Enersync**
Enersync boxes are partitioned for glass safety but are **not** glass-only. Majority glass size decides which Enersync (`1oz` vs `2oz`). Ties → 2oz (bigger box, conservative for mixed carts). Non-glass extras (S/S1/M/L) are allowed as long as they fit within Enersync's `units: 4` budget. Confirmed by Trace 2026-07-14: a cart of 12× G1 + 3× Adrenal TLP (3× S1 = 3 units) fits comfortably in Enersync 1oz. If extras exceed the 4-unit budget, this step falls through to the box path.

**Step 2 — 3+ small glass (G1+G2), ≤5 total items, no L, no LL → 8x6x3 UPS mini**
Small-glass safety trigger (client Q6). `fragilePreferred: true`. Unit budget + glassMax:6 checked.

**Step 3 — Any LL → smallest liquid box that fits**
Iterate all boxes with `liquids > 0` in size order. First tier where `liquids ≥ llDemand` AND `units ≥ unitDemand` wins.

Additional rules for `tinyExtrasOnly` (18×13×3, confirmed by Trace via PM 2026-07-17):
- **Rejected outright** if cart has any M/L/S1/G* items.
- **Skipped** when box is at MAX liquid capacity (6) AND cart has any S bottles → falls through to next tier (15×12×9). Even a single small bottle over-stuffs it when full.
- **FA (flat cards) allowed** alongside 6 full liquids — they're thin enough to slide in without displacing anything.
- If box has leftover liquid room (llDemand < 6), both S + FA extras are permitted (guarded by the standard unit-budget check).

**Step 4 — Any FA (no LL) → 11x9x4 envelope**
Checks `faMax: 60` + unit budget.

**Step 5 — Bottles/glass only, no LL → smallest non-liquid box that fits**
Iterates `liquids === 0 && !fragilePreferred && !partitioned && !tinyExtrasOnly` tiers smallest to largest. `glassMax` on envelope (9×6×4 has 4) is checked.

**Step 6 — Overflow**
Nothing fit. Return largest tier (18×14×8) + `overflow: true`. Merchant approval gate handles it manually.

### 7.1 Worked examples (`pack:` tags → box)

| Cart | Category counts | Unit demand | Selected box |
|---|---|---|---|
| 1× `pack:S` | S=1 | 0.75 | 9x6x4 envelope |
| 3× `pack:S` | S=3 | 2.25 | 9x6x4 envelope |
| 1× `pack:L` | L=1 | 3 | 9x6x4 envelope |
| 3× `pack:L` | L=3 | 9 | 11x9x4 envelope |
| 4× `pack:L` | L=4 | 12 | 18x14x8 (overflow flag) |
| 12× `pack:G1` | G1=12 | 9 | Enersync 1oz |
| 12× `pack:G2` | G2=12 | 12 | Enersync 2oz |
| 1× `pack:LL` | LL=1 | 0 | 8x6x6 box |
| 3× `pack:LL` | LL=3 | 0 | 11x4x12 box |
| 6× `pack:LL` | LL=6 | 0 | 18x13x3 box (only if no non-tiny extras) |

---

## 8. Package Weight Computation

```
itemsGrams = Σ (item.grams × item.quantity)
itemsOz    = itemsGrams / 28.3495
tareOz     = selectedBox.tareOz         (measured empty box weight)
bufferOz   = PACKING.packingBufferOz[box.type]   (envelope=2, box=5)
totalOz    = itemsOz + tareOz + bufferOz
totalLbs   = max(0.1, round(totalOz / 16, 1))
```

`totalLbs` is sent verbatim to USPS + UPS. Minimum 0.1 lb enforced (both carriers reject 0 or sub-0.1 weights). Rounding to 1 decimal matches how carriers bill.

---

## 9. Carrier Integrations — USPS + UPS

Both carriers are called in parallel via `Promise.all` inside `fetchDirectCarrierRates`. Any carrier whose credentials aren't in the environment is silently skipped — no errors. If **neither** returns rates → empty response → customer sees "no shipping available."

### 9.1 USPS Web Tools v3

- **Endpoint base**: `USPS_API_BASE` env or default `https://apis.usps.com`
- **Auth**: OAuth 2.0 client_credentials (`USPS_CLIENT_ID` + `USPS_CLIENT_SECRET`). Token cached in-process for `ttl − 5min`.
- **Rate call**: `POST /prices/v3/base-rates/search` — one call per mail class, run in parallel (Ground, Priority, First-Class, Express).
- **Body**: `weight` (lb), `length`/`width`/`height` (in), origin/destination ZIP, mail-class-specific `rateIndicator` + `processingCategory`.
- **Fallback dims**: If `selectedBox` somehow missing → hardcoded 10×8×4 defensive fallback (never happens in normal flow).

### 9.2 UPS Rating v2403

- **Endpoint**: `https://onlinetools.ups.com/api/rating/v2403/Rate`
- **Auth**: OAuth 2.0 (`UPS_CLIENT_ID` + `UPS_CLIENT_SECRET`). Token cached.
- **Header**: `UPS_SHIPPER_NUMBER` in the account section of the rate request.
- **Body**: All numeric fields sent as **strings** (UPS requires this). Package dims + weight from `selectedBox` + `packageWeight`.
- **Response**: Single call returns Ground, 3 Day Select, 2nd Day Air, Next Day Air Saver, etc. — one service per RatedShipment entry.

### 9.3 Normalized output shape

Each carrier fetcher returns an array of:

```js
{
  carrier: "USPS" | "UPS",
  service: "Priority Mail" | "Ground" | ...,
  rateCents: 850,             // raw carrier quote in cents
  currency: "USD",
  code: "USPS_PRIORITY_MAIL", // uppercase + snake-case, used for dedup
  deliveryDateMin: "2026-07-18T00:00:00Z" | undefined,
  deliveryDateMax: "2026-07-20T00:00:00Z" | undefined,
}
```

Deduplication: after flatten, group by `code`, keep the entry with the lowest `rateCents`.

---

## 10. Handling Markup — Tiered by Cart Quantity

Applied on top of every non-free carrier quote:

| Total qty | Markup |
|---|---|
| 1-2 items | +$2.00 |
| 3 items | +$3.00 |
| 4+ items | +$5.00 |

Function: `tieredMarkupCents(qty)`. Values come from `CONFIG.handlingMarkupCents`. Keep in sync with the wholesale drop-ship reverse-calc.

When free-shipping fires: **both** the raw carrier rate AND the handling markup are zeroed.

---

## 11. Free Shipping Rule

**Both conditions must hold**:

1. Every line item's `vendor` field equals `"Natural Solutions"` (case-insensitive, trimmed).
2. Cart pre-discount subtotal (Σ items[].price × quantity) ≥ **$500 USD**.

**Effect**: All shipping options priced at $0. Customer still picks Ground vs Priority vs Express — they're all shown at $0 with their respective delivery windows so the pick has meaning.

**Why pre-discount subtotal**: Shopify's carrier-service payload doesn't reliably surface post-discount totals across all themes. Design accepted 2026-07-13.

**Vendor exceptions**: Currently only Natural Solutions. If more vendors get free-shipping, extend `CONFIG.freeShipping` to accept an array + update the `every()` check.

---

## 12. Discount Detection (Logging Only)

`detectCartDiscountCents(rate, realItems)` probes 5 fields in order:

1. `rate.order_totals.discount_amount` (2026 spec — most reliable)
2. `rate.order_totals.subtotal_price − total_price` (derived from same block)
3. `rate.total_discounts` (older spec)
4. Σ `items[].discount_allocations[].amount` (per-line — cents/dollars heuristic)
5. `rate.subtotal_price` vs Σ items — last-ditch derived

First non-zero wins. Returns `{ cents, source }`.

**Current usage**: logging only. The net (post-discount) subtotal is surfaced in the per-rate breakdown log for observability. No pricing math depends on the discount today (the fee that once used it is removed).

If we ever need discount-aware free-shipping, use the post-discount `cartSubtotalCents` in the free-shipping check.

---

## 13. Processing Fee Line Filter (Defensive)

The retail store's checkout UI extension (`ns-retail/extensions/processing-fee/`) can add a "Processing Fee" cart line item ($0.01 variant × quantity=cents-of-fee). Currently the fee is **disabled** for retail, but the extension is still deployed — so we defensively filter these lines out before every downstream calculation to prevent:

- The fee line's high quantity pushing every cart into the "4+ items → $5" markup tier.
- The fee variant's (possibly misconfigured) weight inflating carrier quotes.

**Detection** (`isProcessingFeeItem`):
1. Exact variant_id match against `PROCESSING_FEE_VARIANT_ID` (currently `null` — TODO: set to real retail fee variant id if we ever re-enable the fee).
2. Regex fallback on line title: `/processing\s*fee/i`.

`realItems = rate.items.filter(!isProcessingFeeItem)` — every downstream calc (qty, weight, classification, free-shipping) uses `realItems`.

---

## 14. HMAC Verification (Log-Only)

Per Shopify docs, Carrier Service callbacks are **not** HMAC-signed the same way regular webhooks are. Security relies on the callback URL being unguessable + only registerable via authenticated `carrierServiceCreate` mutation.

We DO compute + compare HMAC when the header is present, but the result is **logged only** — the request is always accepted.

**History**:
- 2026-07-06: Added hard-reject when secret mismatched → broke production checkout (customer saw "no shipping available"). Both no-header AND invalid-header cases rejected legit Shopify requests.
- 2026-07-07: Reverted to log-only.

**Do not re-add hard-reject** without confirming Shopify actually signs THIS endpoint with `SHOPIFY_API_SECRET`.

---

## 15. Response Assembly + What the Customer Sees

Each rate returned to Shopify:

```js
{
  service_name: "USPS Priority Mail (incl. handling · Box 9×6×4 in)",
  service_code: "USPS_PRIORITY_MAIL",
  total_price: "1050",              // STRING in CENTS. "1050" = $10.50
  currency: "USD",
  description: "USPS Priority Mail (includes handling markup) · Package: 9x6x4 envelope (9×6×4 in)",
  min_delivery_date: "2026-07-18T00:00:00Z",   // optional
  max_delivery_date: "2026-07-20T00:00:00Z",   // optional
}
```

**Checkout label** (`service_name`) — the primary text the customer sees. Includes carrier + service + short box dims.
**Checkout subtitle** (`description`) — shown beneath the label on most themes. Includes full box label (e.g. "9x6x4 envelope" or "Enersync 1oz") so ops can verify the picked box matches the customer's cart at a glance.

**Free-shipping variant**:
- Label: `USPS Priority Mail (Free shipping · Box 9×6×4 in)`
- Subtitle: `Complimentary shipping on Natural Solutions orders over $500 · Package: 9x6x4 envelope (9×6×4 in)`

---

## 16. Missing-Tag Behavior

**Policy** (locked with user 2026-07-16): if ANY cart item's product lacks a valid `pack:XXX` tag, the entire rate response is EMPTY. Customer sees "no shipping available" at checkout. No safe fallback (default-to-L) is applied.

**Rationale**: Intentional back-pressure. Forces the merchant to tag every product before it can ship. Silent fallbacks would let un-classified products ship in the wrong box, over/under-charging shipping.

**Detection & logging**:
- The `missing` array in `classifyCart()` returns `{ productId, variantId, sku, name, tagsFound }` for each un-tagged item.
- Log line: `[shipping.rates] ABORT — N cart item(s) missing pack: tag; returning empty rates. Missing: productId=… "…" tagsFound=[…]`
- Ops can grep for `ABORT — .* missing pack:` to see which products need tagging.

**Failure modes that also return empty rates** (same UX to the customer):
- `RETAIL_SHOP_DOMAIN` env var not set.
- OAuth session lookup fails.
- GraphQL call errors (network, 4xx, 5xx).
- All 5xx and abort cases are logged with `[shipping.rates] product-tags …` for debugging.

---

## 17. Environment Variables

| Var | Required | Purpose |
|---|---|---|
| `RETAIL_SHOP_DOMAIN` | **yes** | Retail Shopify shop this app is installed on. Used to look up the OAuth session for the tag-fetch GraphQL call. Falls back to `SHOPIFY_SHOP` if unset. |
| `SHOPIFY_SHOP` | fallback | Alternative to `RETAIL_SHOP_DOMAIN`. |
| `SHOPIFY_API_SECRET` | yes | Used for HMAC log-only verification. |
| `USPS_CLIENT_ID` | yes | USPS Web Tools v3 OAuth client id. |
| `USPS_CLIENT_SECRET` | yes | USPS OAuth client secret. |
| `USPS_API_BASE` | optional | Override default `https://apis.usps.com`. |
| `UPS_CLIENT_ID` | yes | UPS OAuth client id. |
| `UPS_CLIENT_SECRET` | yes | UPS OAuth client secret. |
| `UPS_SHIPPER_NUMBER` | yes | UPS account number for rating calls. |

If any carrier's credentials are missing, that carrier is silently skipped. If BOTH are missing → empty rates → customer sees "no shipping available."

---

## 18. Observability — Log Grep Patterns

All logs prefixed with `[shipping.rates` for easy filtering in Render logs.

| Pattern | What it tells you |
|---|---|
| `[shipping.rates] inbound:` | Payload arrived — line count, real qty, destination zip |
| `[shipping.rates] FREE shipping ELIGIBLE` | Free-shipping rule fired |
| `[shipping.rates] product-tags fetched` | Tag fetch success + count |
| `[shipping.rates] product-tags fetch failed` / `session lookup failed` / `GraphQL errors` | Tag fetch failed — empty rates returned |
| `[shipping.rates] cart classified →` | Category counts summary (e.g. `S:2 M:1`) |
| `[shipping.rates.classification]` | Per-line item categorisation with SKU + grams |
| `[shipping.rates] ABORT — missing pack: tag` | Missing-tag guard fired — customer got empty rates |
| `[shipping.rates] box selected:` | Picked box + tare + weight breakdown |
| `[shipping.rates.breakdown]` | Full per-rate breakdown (carrier rate, markup, discount, subtotal, final) |
| `[shipping.rates] applied cart discount detected` | Discount detection found something in payload |
| `[shipping.rates] Direct carriers OK` | Rates successfully returned |
| `[shipping.rates] No live carrier rates` | Both carriers failed — empty rates returned |

---

## 19. Testing Checklist

**Prereqs**: Deploy to staging with `RETAIL_SHOP_DOMAIN=ns-direct-order-stagging-1.myshopify.com` set + USPS/UPS creds present.

### 19.1 Happy path — single tagged product
1. In Shopify admin, add tag `pack:S` to any small product (e.g. Chromium).
2. Add 1× to cart in the storefront → checkout → address entry.
3. Expected: shipping options render; label shows `Box 9×6×4 in`, subtitle shows `9x6x4 envelope (9×6×4 in)`.
4. Render logs: `cart classified → S:1`, `box selected: 9x6x4 envelope`.

### 19.2 Multiple categories in one cart
1. Add 2× `pack:S` + 1× `pack:M` to cart.
2. Expected: `unit demand = 2×0.75 + 1×2 = 3.5` → 11x9x4 envelope (units=9 fits).
3. Verify subtitle: `11x9x4 envelope (11×9×4 in)`.

### 19.3 Free shipping trigger
1. Cart with Natural Solutions items only, subtotal ≥ $500.
2. Expected: all shipping options priced at $0 with `(Free shipping · Box …)` in the label.

### 19.4 Missing-tag guard
1. Remove `pack:` tag from a product; keep other cart items tagged.
2. Expected: checkout shows "There are no shipping methods available for your address."
3. Logs: `ABORT — 1 cart item(s) missing pack: tag; …`.

### 19.5 Typo tag
1. Tag a product `pack:XX` (unknown category).
2. Expected: treated as missing → same UX as case 19.4.
3. Logs show `tagsFound=[pack:XX]` — helps operator diagnose.

### 19.6 12+ glass → Enersync
1. Tag 12 products `pack:G1`, add all to cart.
2. Expected: `Enersync 1oz` selected. If mixed 6× G1 + 6× G2, `Enersync 2oz` (majority-size logic).

### 19.7 Large-liquid path
1. Tag product `pack:LL`, add 1× to cart.
2. Expected: 8x6x6 box (smallest liquid tier where `liquids: 1` fits `llDemand: 1`).

### 19.8 Overflow
1. Add 4× `pack:L` to cart (unit demand 12).
2. Expected: 18x14x8 box selected + `OVERFLOW` flag in logs. Rate is still returned but merchant should manually review.

### 19.9 Carrier failure fallback
1. Temporarily unset `USPS_CLIENT_ID` + `UPS_CLIENT_ID`.
2. Expected: empty rates + `No live carrier rates` log.

### 19.10 Two 4 oz glass fit 9×6×4 envelope
1. Tag two different 4 oz glass products `pack:G4`, add both to cart (1× each).
2. Expected box: `9x6x4 envelope` — math: 2 × G4 unit-cost 1.5 = 3.0 units = exactly fits the envelope's 3-unit budget. Trace confirmed she shipped this combination 2026-07-13.
3. Verify subtitle shows `9x6x4 envelope (9×6×4 in)`, not a larger tier.

### 19.11 18×13×3 at-full-capacity guard (S-blocked, FA-allowed)
1. Tag 6 products `pack:LL` (max liquid capacity of 18×13×3) AND tag 1 product `pack:S` (Chromium-style). Add all to cart.
2. Expected: **not** 18×13×3 — instead falls through to `15x12x9 box` (next tier with liquids:12 + units:6). S bottles do not fit alongside 6 full liquids.
3. Second scenario: 6× LL + 1× FA (flat card). Expected: `18×13×3` selected (FA is allowed at full liquid capacity — flat card slides alongside).
4. Third scenario: 5× LL + 1× S. Expected: `18×13×3` selected (1 liquid slot leftover, S fits within units budget).

### 19.12 Pending-taxonomy tags (pack:XL / pack:OTHER)
1. Tag any product `pack:XL`, add 1× to cart.
2. Expected: `18x14x8 box` selected with `OVERFLOW` flag + warn log `cart contains pack:XL(1) / pack:OTHER(0) — pending taxonomy`.
3. Same for `pack:OTHER` — verify log names OTHER count.
4. Once Trace's worksheet arrives, this test needs to be replaced with proper per-tag routing tests.

---

## 20. Known Gaps / Pending Items

| Item | Status |
|---|---|
| Merchant to tag all ~638 retail products with `pack:XXX` | Pending merchant action |
| `pack:XL` per-product assignments (Body FX etc.) | Trace worksheet pending; tag structure ready |
| `pack:OTHER` per-product assignments + own-box dimensions (Three Lac, Trimsulin) | Trace worksheet pending; engine routes overflow for now |
| "Medium" definition + M unit-cost (Trace: her medium ≠ old table) | Trace worksheet pending; DO NOT change unit-cost until back |
| Extras allowances per liquid box (Q3) — dev estimates unconfirmed except 18×13×3 at full = FA-only | Trace worksheet pending (tied to category lock-in) |
| Sweep of "oz"-named products that are actually capsules (Q6 part 2) | List generation pending; Trace to validate |
| S vs S1 boundary confirmation | Client to finalize taxonomy sheet |
| 13×13×10 box tare weight | Trace to weigh next time it's back in stock |
| 4+ pack:L items → dedicated non-liquid large box | Design gap; overflow path today, client review needed |
| Q9 packing-buffer worst-case measurement | Stephanie to provide, may adjust `packingBufferOz` |
| Whether a single S bottle can squeeze in 18×13×3 at 6 full liquids | Trace to confirm; conservative default is S-blocked |
| Discount-aware free-shipping | Nice-to-have; would swap pre-discount subtotal for post-discount |
| Deploy Phase 1–7 changes (fee removal, box engine, tag classifier) to production | Currently staging only |

---

## 21. Changelog

Every meaningful shipping change lands here **and** in `PROGRAM.md`. Newest first.

| Date | Change |
|---|---|
| 2026-07-17 | **PM answers integrated — Q4/Q5/Q6 resolved + Q1 structural rollout**: (1) Q4 confirmed: 2× G4 fits 9×6×4 (code math correct, no change). (2) Q5 refined: 18×13×3 at 6-liquid-full now allows FA (flat cards) but still blocks S — `selectBox` Step 3 guard updated accordingly. (3) Q6 part 1 doc: `pack:G2` example note clarifies EQ B-Complex 2 oz is capsules → tag S/S1, not glass. (4) Q1 structural: `pack:XL` + `pack:OTHER` added to `ALLOWED_CATEGORIES` + classifier counts; new "Step 0" in `selectBox` routes XL/OTHER carts to largest tier + overflow flag until Trace's worksheet provides per-product assignments. **Held for worksheet**: Q1 per-product mapping, Q2 M unit-cost, Q3 extras allowances (except confirmed 18×13×3 = FA-only), Q6 part 2 SKU sweep. |
| 2026-07-16 | **Trace review pass — 4 fixes applied**: (1) `tinyExtrasOnly` guard tightened — 18×13×3 now falls through to next tier when at full liquid capacity + cart has any S/FA extras (was accepting them regardless); (2) doc §7 Step 1 clarified that Enersync is NOT glass-only (4-unit extras budget confirmed by Trace's 12×G1 + 3×Adrenal example); (3) doc §6.1 tag examples corrected — Body FX removed from `pack:LL` (it's XL, not liquid); (4) test cases 19.10 (2× G4 → 9×6×4) and 19.11 (at-full-capacity guard) added. **Pending client input**: `pack:XL`/`pack:OTHER` category, M redefinition, Q1 extras counts. |
| 2026-07-16 | Classifier rewritten to **pure tag-based** (`pack:XXX` product tags). Weight/name/vendor cascade fully removed. Missing tag → empty rates ("no shipping available") — deliberate back-pressure. Tag fetch via `unauthenticated.admin(RETAIL_SHOP_DOMAIN)` in one bulk GraphQL call. Checkout `service_name` + `description` now surface the picked box dimensions. |
| 2026-07-16 | Documentation cleanup pass: stale references to 3% processing fee and tax-fetch removed from code comments (SHIPPING_LOGIC.md fully rewritten). No functional changes in this pass. |
| 2026-07-15 | **3% processing fee REMOVED** for retail per 2026-07-09 client call. Retail customers no longer surcharged. |
| 2026-07-15 | **Async Shopify tax fetch REMOVED** — Shopify handles retail tax display natively on checkout. |
| 2026-07-15 | Box-selection engine + package weight introduced. 13 box tiers, 6-step selectBox priority algorithm, real tare + packing-buffer weight math. USPS + UPS now called with dynamic dims + weight (was hardcoded 10×8×4). |
| 2026-07-13 | Client corrections applied: 9×6×4 envelope tare 2.7 → 0.7 oz (typo), G4 unit-cost 3 → 1.5, 18×14×8 tare ~14 → 17 oz (Trace measured). |
| 2026-07-13 | Scope narrowed to `rates.js` only — no metafields, payload-derived classification. |
| 2026-07-09 | Client calls: approval gate decision, wholesale immediate-pay reversed, 3% fee removed for retail. |
| 2026-07-08 | Box-selection directive received from Parker. |
| 2026-07-07 | HMAC verification reverted to log-only after 2026-07-06 hard-reject broke prod checkout. |
| 2026-07-07 | Order-level discount detection added (5-field probe). |
| 2026-07-06 | Initial fee migration from Checkout UI Extension to carrier callback. |

---

## Reference

- **Current code**: [`ns-retail/app/api/shipping/rates.js`](app/api/shipping/rates.js)
- **Wholesale parallel** (independent shipping logic): [`wholesale/app/api/shipping/rates.js`](../wholesale/app/api/shipping/rates.js)
- **Session changelog**: [`PROGRAM.md`](../PROGRAM.md) at repo root
- **Processing-fee UI extension** (currently disabled but deployed): [`ns-retail/extensions/processing-fee/`](extensions/processing-fee/)

---

**Doc maintenance rule**: when you touch `rates.js`, touch this file too. Add a row to §21 changelog. If a change affects a numbered section (e.g. new box tier → update §5.2, new classification category → update §6.1), update that section as well. Small edits are fine — the goal is that the doc doesn't drift from reality.
