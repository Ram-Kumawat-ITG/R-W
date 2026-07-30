# NS-Retail Shipping Logic — Technical Documentation

**File:** [`ns-retail/app/api/shipping/rates.js`](app/api/shipping/rates.js)
**Endpoint:** `POST /api/shipping/rates` (Shopify Carrier Service callback)
**Purpose:** On every checkout re-render, Shopify POSTs the cart + destination to this endpoint. We classify each product by its `custom.pack_category` metafield, pick the smallest packing box that fits, compute the real package weight, call USPS + UPS with those dimensions, and return the live shipping options + the picked box to the customer.

> **Living doc.** Update this file **every time** we change anything in `rates.js` (algorithm, thresholds, category mapping, carrier config, etc.). If code and doc disagree, code wins — but that's a bug in this doc, fix it.

**Last updated:** 2026-07-30 (Bug C1 fix — `resolveLargestOverflowBox()` helper; client PDF verification of 34 real orders)

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
22. [Real-Order Verification Data (2026-07-30 PDF review)](#22-real-order-verification-data-2026-07-30-pdf-review)

---

## 1. Executive Summary

`rates.js` is a Shopify **Carrier Service** callback. Shopify invokes it via HTTPS POST during every checkout re-render, sending the customer's cart items + shipping address. The endpoint must respond within 10 seconds with an array of shipping options or an empty list.

**Current business rules** (retail store, as of 2026-07-16):

- **Product classification is pure tag-based** — each product must carry ONE `pack:XXX` tag (9 categories). Missing tag = empty rates.
- **Box selection** — 14 physical box/envelope tiers (12 mainline + 2 Enersync partitioned specialty), picked by a 7-step priority algorithm.
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
| 8x6x3 UPS mini | box | 8×6×3 | 2.7 | 6 | 0 | fragilePreferred; glassMax: 6 (units bumped 3→6 on 2026-07-20 to match client capacity: 6×G1 / 5×G2 / 4×G4) |
| 11x9x4 envelope | envelope | 11×9×4 | 0.7 | 9 | 0 | faMax: 60 |
| 8x6x6 box | box | 8×6×6 | 3.9 | 3 | 1 | liquid tier |
| 10x7x6 box | box | 10×7×6 | 5.0 | 4 | 2 | liquid tier |
| 11x4x12 box | box | 11×4×12 | 5.7 | 4 | 3 | liquid tier |
| 16x11x3 box | box | 16×11×3 | 7.5 | 4 | 4 | liquid tier |
| 12x12x5 box | box | 12×12×5 | 9.6 | 4 | 4 | liquid tier |
| 18x13x3 box | box | 18×13×3 | 9.3 | 1 | 6 | **tinyExtrasOnly** — rejects any M/L/S1/G* items |
| 15x12x10 box | box | 15×12×10 | 11.5 | 6 | 12 | liquid tier; **renamed from 15x12x9 on 2026-07-30** — client confirmed actual dimensions are 15×12×10; tare + capacity unchanged. |
| 13x13x10 box | box | 13×13×10 | 13.6 | 6 | 12 | liquid tier; added 2026-07-23 (Trace-measured tare). Capacity is best-guess mirror of 15x12x10 — tune when client confirms real fit. |
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
**Excluded**: 16×12×10 (client Q7).

### 5.2.1 Overflow-box resolution (`resolveLargestOverflowBox()`)

**⚠️ Do NOT use `PACKING.boxTiers[PACKING.boxTiers.length - 1]` to get "the largest box."** The `boxTiers` array orders mainline boxes smallest → largest **and then appends the two Enersync specialty tiers at the end**, so `length - 1` returns **Enersync 2oz** (a small 11×7×8 partitioned glass-only box with tare 13.2 oz and `liquids: 0`) — NOT the intended 18×14×8.

Bug C1 (found + fixed 2026-07-30) traced back to this exact mistake at three sites: Step 0 (OTHER cart → overflow), Step 3 (LL cart with no liquid tier that fits), and Step 5 (non-liquid overflow). Every OTHER cart, every oversized LL cart, and every non-liquid overflow was being quoted at Enersync 2oz's 11×7×8 dims + 13.2 oz tare + partitioned interior — merchant ate the DIM-weight difference on real 18×14×8 shipments.

Use the helper `resolveLargestOverflowBox()` instead — it explicitly looks up the box named `"18x14x8 box"` and falls back to "largest non-partitioned tier" only if that name is missing:

```js
function resolveLargestOverflowBox() {
  return (
    PACKING.boxTiers.find((b) => b.name === "18x14x8 box") ||
    PACKING.boxTiers.filter((b) => !b.partitioned).slice(-1)[0] ||
    PACKING.boxTiers[PACKING.boxTiers.length - 1]
  );
}
```

Any future overflow / fallback path MUST call this helper — never index `boxTiers` from the end directly.

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

## 6. Product Classification — Metafield-Based

### 6.1 Requirement

Every retail Shopify product must carry the `custom.pack_category` metafield naming its packing category. **12 allowed values** — aligned with client's 2026-07-23 classification sheet (Stephanie's 8-tier + XL + OTHER + REVIEW):

| Value | Category | Meaning / example products |
|---|---|---|
| `SS` | Extra small tablets / tiny bottles | AI-Chromium, AI-D3, AI-B12, AI-Biotin, AI-K2/D3, AI-IRON, NS-Aqua Max |
| `S` | Small capsules | AI-ARWY Pro, NS-Adrenal TLP, NS-Cardio Support, most NS capsules |
| `M` | Medium capsules | AI-Body DX, EQ-B-Complex, NS-Bone Health, FF-Cardio 1st |
| `L` | Large non-liquid | AI-Enervimin Flora/Joint/Stress Focus, NS-Amino Complex, FF-SPN Energy |
| `LL` | Large liquid | AI-V Max, FF-Biomega, FF-Zavita, NS-Liquid Life, M2-Miracle II, Floradix Iron |
| `XL` | Extra large | **Body FX Chocolate + Vanilla only** (2 products) |
| `G1` | 1 oz glass | 1oz droppers, sprays, essential oils (JW oils, EQ 1oz drops) |
| `G2` | 2 oz glass | 2oz droppers, sprays (BL sprays, EQ 2oz drops, EQ Thyroid Herbal 2oz — **NOT** EQ B-Complex 2 oz which is capsules → tag `M`) |
| `G4` | 4 oz glass | EQ-Organdrainex, NS-Filtering Organ Drainage 4oz, EQ-Recovatone |
| `FA` | Frequency Apps | All Frequency App patches (flat cards, ~0.1 oz) |
| `OTHER` | Ships in its own retail box | Bio Kits, Trimsulin Kit, EnerSync 24ct Cases, Services, Training, Red Laser |
| `REVIEW` | Merchant-unmatched (blocks checkout) | Products the merchant hasn't classified yet — triggers "no shipping available" |

### 6.2 Where the merchant sets it

**Shopify admin → Product edit page → Metafields section → "Pack category"** (single-line text field with the allowed values listed above). Metafield definition:

```
Namespace + key : custom.pack_category
Type            : single_line_text_field
Owner           : PRODUCT (not variant — pack category is per-product)
Pin             : Yes (visible without expanding "Show all")
Allowed values  : SS, S, M, L, LL, XL, G1, G2, G4, FA, OTHER, REVIEW
```

Client's classification sheet ships with the correct value per SKU — merchant CSV-imports it once to bulk-set every product.

### 6.3 Runtime

On every carrier callback:

1. Extract unique `product_id` values from `realItems`.
2. One bulk GraphQL call:
   ```graphql
   nodes(ids: [Product/1, Product/2, ...]) {
     ... on Product {
       id
       packCategory: metafield(namespace: "custom", key: "pack_category") { value }
     }
   }
   ```
   via `unauthenticated.admin(RETAIL_SHOP_DOMAIN)` (same session pattern as customerTags.js and cdo.portal.service.js).
3. Build `Map<productId, rawMetafieldValue>`.
4. For each cart line, `normalizePackCategory` uppercases + validates against the allow-list. Unknown values (typos like `pak:X`) are treated as missing.
5. Return `{ counts, perLine, missing }` — `counts` is the input to `selectBox`; `missing` is the list of items with no metafield OR metafield = REVIEW.

### 6.4 Missing / REVIEW policy

If ANY cart item lacks a valid `custom.pack_category` OR its value equals `REVIEW`:
- Full rate response = empty (customer sees "no shipping available").
- Log line: `[shipping.rates] ABORT — N cart item(s) missing/REVIEW pack_category` with per-item `reason=no_metafield|review_pending` and the raw value seen.
- Forces the merchant to classify (or fix `REVIEW`) before shipping quotes will render.

### 6.5 Migration note — tag-based system superseded

Prior to 2026-07-23 the classifier read a `pack:XXX` tag from Shopify Admin API. That system had 9 categories (S / S1 / M / L / LL / G1 / G2 / G4 / FA). The switch to metafield brought a **renaming** to align with client's sheet:

| Old tag | New metafield value |
|---|---|
| `pack:S` (extra small) | `SS` |
| `pack:S1` (small capsule) | `S` |
| `pack:M`, `pack:L`, `pack:LL`, `pack:G1`, `pack:G2`, `pack:G4`, `pack:FA` | Same names |
| — | `XL` (new — Body FX only) |
| — | `OTHER` (new — own-box shipping) |
| — | `REVIEW` (new — blocks checkout) |

The tag system is fully removed from code as of 2026-07-23 (clean cut). Products still carrying the old `pack:XXX` tags won't classify — merchant must set the metafield instead.

---

## 7. Box Selection Algorithm — 7-Step Priority

Given the cart's classification counts, `selectBox()` walks 7 rules in order. First match wins. Returns `{ box, overflow }`.

**Step 0 — Any `OTHER` in cart → largest tier + overflow flag**
`OTHER` products (kits, cases, services, EnerSync 24-count boxes) ship in their own retail box. No engine tier applies — we route the whole cart to `18×14×8` (resolved via `resolveLargestOverflowBox()` — see §5.2.1) with `overflow: true` and log the reason. Merchant approval gate reviews and fixes the label at fulfillment time. (`REVIEW` never reaches this step — it's blocked earlier in the action handler with empty rates.)

**Step 1 — 12+ glass items, no LL → Enersync**
Enersync boxes are partitioned for glass safety but are **not** glass-only. Majority glass size decides which Enersync (`1oz` vs `2oz`). Ties → 2oz (bigger box, conservative for mixed carts). Non-glass extras (SS/S/M/L/XL) are allowed as long as they fit within Enersync's `units: 4` budget. Confirmed by Trace 2026-07-14: a cart of 12× G1 + 3× Adrenal TLP (3× S = 3 units) fits comfortably in Enersync 1oz. If extras exceed the 4-unit budget, this step falls through to the box path.

**Step 2 — 3+ small glass (G1+G2), ≤5 total items, no L, no M, no XL, no LL → 8x6x3 UPS mini**
Small-glass safety trigger (client Q6, broad-interpretation update 2026-07-20 — "no larger bottles" excludes M and XL too). `fragilePreferred: true`. Unit budget (6) + glassMax:6 checked. Fits 6×G1 (4.5u), 5×G2 (5u), or 4×G4 (6u) per Trace's specification.

**Step 3 — Any LL → smallest liquid box that fits**
Iterate all boxes with `liquids > 0` in size order. First tier where `liquids ≥ llDemand` AND `units ≥ unitDemand` wins.

Additional rules for `tinyExtrasOnly` (18×13×3, confirmed by Trace via PM 2026-07-17):
- **Rejected outright** if cart has any S/M/L/XL/G* items.
- **Skipped** when box is at MAX liquid capacity (6) AND cart has any SS bottles → falls through to next tier (15×12×10). Even a single extra-small bottle over-stuffs it when full.
- **FA (flat cards) allowed** alongside 6 full liquids — they're thin enough to slide in without displacing anything.
- If box has leftover liquid room (llDemand < 6), both SS + FA extras are permitted (guarded by the standard unit-budget check).

**Step 4 — Any FA (no LL) → 11x9x4 envelope**
Checks `faMax: 60` + unit budget.

**Step 5 — Bottles/glass only, no LL → smallest non-liquid box that fits**
Iterates `liquids === 0 && !fragilePreferred && !partitioned && !tinyExtrasOnly` tiers smallest to largest. `glassMax` on envelope (9×6×4 has 4) is checked.

**Step 6 — Overflow**
Nothing fit. Return largest tier (18×14×8) + `overflow: true`. Merchant approval gate handles it manually. Uses `resolveLargestOverflowBox()` (see §5.2.1) — **must not** index `boxTiers[length - 1]`.

**Fallback paths in Steps 3 and 5 that hit "no tier accommodates this cart" also route to `resolveLargestOverflowBox()` + `overflow: true`.** Step 3 (LL) escalates when no `liquids > 0` tier has enough `liquids` capacity AND unit budget (or when `tinyExtrasOnly` guards reject every candidate). Step 5 (non-liquid bottles/glass) escalates when no `liquids === 0 && !fragilePreferred && !partitioned && !tinyExtrasOnly` tier has enough unit budget.

### 7.1 Worked examples (`custom.pack_category` → box)

| Cart | Category counts | Unit demand | Selected box |
|---|---|---|---|
| 1× `SS` | SS=1 | 0.75 | 9x6x4 envelope |
| 3× `SS` | SS=3 | 2.25 | 9x6x4 envelope |
| 1× `S` | S=1 | 1 | 9x6x4 envelope |
| 1× `L` | L=1 | 3 | 9x6x4 envelope (fills exactly) |
| 3× `L` | L=3 | 9 | 11x9x4 envelope |
| 4× `L` | L=4 | 12 | 18x14x8 (overflow flag) |
| **1× `XL`** (Body FX) | XL=1 | 3 | 9x6x4 envelope (fills like 1×L; physical fit may need merchant review — see §20) |
| **1× `OTHER`** (Bio Kit) | OTHER=1 | — | **18×14×8 + overflow flag** (Step 0 — routes to overflow so merchant handles own-box labeling) |
| **1× `REVIEW`** (unclassified) | REVIEW=1 | — | **empty rates** (blocked in action handler before selectBox) |
| **5× `G1`** (small-order glass) | G1=5 | 3.75 | **8x6x3 UPS mini** (Step 2) |
| **5× `G2`** | G2=5 | 5 | 8x6x3 UPS mini (Step 2) |
| 3× `G1` + 1× `M` | G1=3, M=1 | 4.25 | 11x9x4 envelope (Step 2 rejects due to M presence) |
| 12× `G1` | G1=12 | 9 | Enersync 1oz |
| 12× `G2` | G2=12 | 12 | Enersync 2oz |
| 12× `G1` + 3× `S` | G1=12, S=3 | 12 | Enersync 1oz (3×S = 3 units ≤ 4 budget — Trace confirmed) |
| 1× `LL` | LL=1 | 0 | 8x6x6 box |
| 3× `LL` | LL=3 | 0 | 11x4x12 box |
| 6× `LL` | LL=6 | 0 | 18x13x3 box (only if no non-tiny extras) |
| 6× `LL` + 1× `SS` | LL=6, SS=1 | 0.75 | 15x12x10 box (18×13×3 at-full-capacity guard blocks SS extra) |
| 6× `LL` + 1× `FA` | LL=6, FA=1 | 0.15 | 18x13x3 box (FA allowed at full LL capacity) |

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
1. Set two different 4 oz glass products' `custom.pack_category = G4`, add both to cart (1× each).
2. Expected box: `9x6x4 envelope` — math: 2 × G4 unit-cost 1.5 = 3.0 units = exactly fits the envelope's 3-unit budget. Trace confirmed she shipped this combination 2026-07-13.
3. Verify subtitle shows `9x6x4 envelope (9×6×4 in)`, not a larger tier.

### 19.11 18×13×3 at-full-capacity guard (SS-blocked, FA-allowed)
1. Set 6 products' `custom.pack_category = LL` (max liquid capacity of 18×13×3) AND set 1 product's `custom.pack_category = SS` (Chromium-style). Add all to cart.
2. Expected: **not** 18×13×3 — instead falls through to `15x12x10 box`. SS bottles do not fit alongside 6 full liquids.
3. Second scenario: 6× LL + 1× FA (flat card). Expected: `18×13×3` selected (FA is allowed at full liquid capacity).
4. Third scenario: 5× LL + 1× SS. Expected: `18×13×3` selected (1 liquid slot leftover, SS fits within units budget).

### 19.12 UPS mini — concentrated small-glass carts route correctly
1. **5× G1**: totalItems=5, smallGlass=5, unitDemand=3.75. Expected: `8x6x3 UPS mini` (fits units:6, glassMax:6).
2. **5× G2**: totalItems=5, smallGlass=5, unitDemand=5. Expected: `8x6x3 UPS mini`.
3. **3× G1 + 2× G4**: totalItems=5, smallGlass=3, unitDemand=5.25. Expected: `8x6x3 UPS mini`.
4. **3× G1 + 1× M** (medium in cart): Expected: **NOT** UPS mini (Step 2 rejects due to M presence) → `11x9x4 envelope` via Step 5.
5. **6× G1 + 1× SS** (totalItems=7 > 5): Expected: **NOT** UPS mini (Step 2 rejects on totalItems) → `11x9x4 envelope`.

### 19.13 XL / OTHER / REVIEW routing (2026-07-23 rollout)
1. **1× XL (Body FX)**: Expected — Step 5 → `9x6x4 envelope` (unit-cost 3 fills exactly). Merchant reviews if physical fit fails (see §20 known gap).
2. **1× OTHER (Bio Kit) + 2× S**: Expected — **Step 0 triggers** → `18×14×8 box` + overflow flag + warn log `cart contains pack:OTHER(1)`. Merchant handles labeling.
3. **1× REVIEW + 3× S**: Expected — **empty rates** (checkout shows "no shipping available"). Log: `ABORT — 1 cart item(s) missing/REVIEW pack_category reason=review_pending`.
4. **Missing metafield** (product has no `custom.pack_category` set): Expected — empty rates, log `reason=no_metafield`.
5. **Invalid value** (e.g., metafield = "xyz"): Expected — treated as missing → empty rates, log `raw="xyz"`.

---

## 20. Known Gaps / Pending Items

| Item | Status |
|---|---|
| Merchant to set `custom.pack_category` metafield on every retail product via CSV import from client's classification sheet (2026-07-23) | Pending merchant action |
| Metafield definition creation in retail Shopify admin (`custom.pack_category` on PRODUCT owner) | One-time setup — merchant task |
| Client's REVIEW-flagged products (~5-10 unmatched — EnviroShield, Lipo K&B, Magnesium & Potassium, MasterZyme, Nerve Stim, Gift Card, etc.) | Pending Trace review; those products stay REVIEW until reclassified |
| Client's "CAN BE REMOVED" flagged products (~20 duplicates / no-longer-selling) | Merchant to delete from Shopify catalog — code will treat them as missing until removed |
| **XL physical routing** — code treats XL like L (unit-cost 3) per client 2026-07-23; 1× Body FX would fit in 9×6×4 envelope which is physically wrong | Client to confirm actual XL dimensions; may need dedicated tier or higher unit-cost |
| ~~"Medium" definition + M unit-cost~~ | **RESOLVED 2026-07-23** — client confirmed 4 M bottles fit in 11×9×4. Current code (M unit-cost 2, 4×2=8 ≤ envelope's 9) already matches. |
| Extras allowances per liquid box — dev estimates unconfirmed except 18×13×3 at full = FA-only | Trace to confirm per-box extras counts |
| ~~13×13×10 box tare weight~~ | **RESOLVED 2026-07-23** — Trace confirmed tare 13.6 oz. Box added to tier list with best-guess capacity (12 LL + 6 units, mirrors 15×12×10 — that sibling tier was named `15x12x9` at the time; renamed 2026-07-30). Real capacity to be tuned on merchant feedback. |
| 4+ L items in cart → dedicated non-liquid large box | Design gap; overflow path today, client review needed |
| Q9 packing-buffer worst-case measurement | Stephanie to provide, may adjust `packingBufferOz` |
| Whether a single SS bottle can squeeze in 18×13×3 at 6 full liquids | Trace to confirm; conservative default is SS-blocked |
| "Estimate" note in checkout shipping description (customer-visible disclaimer) | Deferred 2026-07-17; awaiting exact wording + Option A/B choice for box name in title |
| Merchant approval gate integration (currently `overflow: true` only logs, no downstream queue) | Separate workstream; scope confirmation pending |
| Discount-aware free-shipping | Nice-to-have; would swap pre-discount subtotal for post-discount |
| 13 Package Templates in retail Shopify admin (Settings → Shipping and delivery → Saved packages) | Merchant to create manually — cheat-sheet provided |
| Staging → Production deploy (fee removal, box engine, metafield classifier) | Blocked on: (a) merchant metafield-set complete for all active products, (b) 14 package templates created, (c) at minimum staging end-to-end test |
| **Missing box sizes seen in client's 34-order PDF sample** — `9×7×5`, `13×11×2`, `12×10×2`, `9×6×6`, `10×10×10` (each appeared in 1 order except `12×10×2` which was 5 boxes on the 100-bottle Grady order). Not urgent — 5/34 orders = 15%. If added, need tare weight + `units` / `liquids` capacity from Trace per box. | Client to confirm which (if any) to add + provide capacities/tare |
| **Product-level `pack_category` re-calibration** — client PDF verification found single-item orders where algorithm picked 9×6×4 envelope but client packed in 11×9×4 (e.g. Calvert Omega Complete ×1). Root cause: product classified as `S` but its actual bottle size fits better in an M-envelope. Data/calibration issue, not a code bug. | Client to review flagged products + update metafield values (list to be compiled from PDF) |
| **Extras allowance calibration per liquid box** — client PDF showed multi-item LL orders (Reitz, Spencer, Johnson, Lehn) where algorithm picked the minimum-fit liquid box but client used the next tier up. Suggests our `units` extras budget on liquid boxes is optimistic; still pending Trace's Q1 confirmation ("real extras count per box with full LL"). | Trace to confirm per-box extras counts (Q1 answer, promised after category lock) |
| **Multi-package split logic** — no support today: a cart that exceeds every single-box tier gets one `overflow: true` label at 18×14×8 regardless of true item count. Client PDF showed one 100-bottle order shipped in **5 separate boxes** (Grady, 100× G1). Algorithm returns 1 quote; client physically ships N. Systemic gap; needs decision on API contract (multi-package rate response), split rules, and per-package weight aggregation. | Design + client confirmation required before implementation |

---

## 21. Changelog

Every meaningful shipping change lands here **and** in `PROGRAM.md`. Newest first.

| Date | Change |
|---|---|
| 2026-07-30 | **Box tier rename — `15x12x9` → `15x12x10` (client dimension correction)**: client confirmed the actual physical box is 15×12×10, not 15×12×9 — our previously-recorded height was incorrect. This is a dimension correction, not a new tier: `tareOz: 11.5` and capacity (`units: 6, liquids: 12`) unchanged per client. Applied to `PACKING.boxTiers` in both `ns-retail/app/api/shipping/rates.js` and `wholesale/app/api/shipping/rates.js` (byte-identical mirror maintained). Volume grows 1620 → 1800 in³, so a bigger DIM weight will be sent to USPS/UPS on any cart routed here — customer's checkout quote now matches the box the merchant physically ships in, closing the same DIM-weight-mismatch class of bug as C1 (though for a different set of orders). Doc updated: §5.2 table row renamed with back-reference note, §7 Step 3 narrative + §7.1 worked example + §19.11 test case all renamed to `15x12x10`, §20 historical row note added, 13x13x10 comment/volume comparison updated to reference 15x12x10's new 1800 in³ volume. **Merchant task**: rename the corresponding Package Template in Shopify admin (Settings → Shipping and delivery → Saved packages) from "15x12x9" to "15x12x10" so the label on the printed shipping label matches. |
| 2026-07-30 | **Bug C1 fix — Enersync 2oz was being returned as "largest overflow box"**: three sites in `rates.js` (Step 0 OTHER-route, Step 3 LL-overflow, Step 5 non-liquid-overflow) used `PACKING.boxTiers[PACKING.boxTiers.length - 1]` to fetch "the largest box." Because `boxTiers` orders mainline boxes smallest → largest AND THEN appends the two Enersync specialty tiers at the end, `length - 1` returned **Enersync 2oz** (11×7×8, partitioned glass-only, tare 13.2 oz, `liquids: 0`) — not 18×14×8. Every OTHER cart + every oversized LL cart + every non-liquid overflow was quoted with wrong dims/tare. New helper `resolveLargestOverflowBox()` explicitly does `PACKING.boxTiers.find((b) => b.name === "18x14x8 box")` with two defensive fallbacks. Applied at all 3 sites in **both** `ns-retail/app/api/shipping/rates.js` and `wholesale/app/api/shipping/rates.js` (byte-identical mirror). Doc §5.2.1 added (why the array-index shortcut is wrong + helper spec); §7 Steps 0, 3, 5, 6 updated to reference the helper. |
| 2026-07-30 | **Client PDF real-order verification (34 orders)**: PM shared a PDF of 34 real client orders with their actual packed box sizes handwritten on each. Traced every order through the current algorithm (mental sim, no code run — end-to-end verification test still pending). Result breakdown: **50% match** (17 orders — algorithm picked the same box client actually used); **18% mismatch due to Bug C1** (6 orders quoted Enersync 2oz where client used 18×14×8 — now fixed above); **12% mismatch due to missing box sizes** (5 orders — client used 9×7×5 / 13×11×2 / 12×10×2 / 9×6×6 / 10×10×10, none of which are in our tier list; see new §20 row); **18% mismatch due to client "safe-side" packing** (6 orders — client picked a larger box than the algorithm's minimum-fit choice; split into two subcauses documented in §20: single-item cases suggest product mis-categorization, multi-item cases suggest liquid-box `units` extras budget is optimistic); **3% systemic gap** (1 order — 100-bottle Grady, no multi-package split logic in the algorithm today, shipped in 5 boxes). No code change from this verification — findings driving the 4 new §20 pending items (missing sizes / category re-calibration / extras tuning / multi-package split). Waiting on client responses before any of them are actionable. |
| 2026-07-23 | **Client Q4 + Q7 confirmations applied**: (1) Q4 — client confirmed **4 M bottles fit in 11×9×4**. Current M unit-cost 2 (4×2=8 ≤ envelope's 9) already matches — no code change; §20 "under review" note removed. (2) Q7 — client confirmed **13×13×10 box tare = 13.6 oz**. Added to `PACKING.boxTiers` between 15×12×9 and 18×14×8 with best-guess capacity (units:6, liquids:12 — mirrors 15×12×9 based on similar volume). §5.2 table + §20 known-gap updated. Real capacity to be tuned when merchant provides feedback from live orders. |
| 2026-07-23 | **Classifier migrated to metafield (major)**: Tag-based `pack:XXX` system fully replaced with `custom.pack_category` product metafield. Client's product classification sheet (500+ SKUs) now the source of truth. Naming aligned with client sheet: (1) OLD `S` (extra small) → NEW **`SS`**; (2) OLD `S1` (small capsule) → NEW **`S`**. (3) `XL` re-added (Body FX only — treated like L, unit-cost 3). (4) `OTHER` re-added (own-box shipping — Step 0 routes to overflow flag). (5) `REVIEW` added (unclassified products → empty rates, back-pressure). (6) Old tag-fetching GraphQL replaced with metafield-fetching GraphQL (`custom.pack_category`). (7) `selectBox` renamed all internal category refs (S1→S, S→SS everywhere; added XL to unit demand + non-tiny-extras check). (8) Doc §6 fully rewritten (metafield table, migration note); §7 renamed 6-step → 7-step (Step 0 added); §7.1 examples updated; §19.13 added for XL/OTHER/REVIEW test scenarios; §20 rewritten to reflect metafield-based blockers. Zero backward-compat with old tags (clean cut). |
| 2026-07-20 | **Digital-product bug fix** — `realItems` filter now excludes items with `requires_shipping: false` in addition to processing-fee lines. Previously a cart containing at least one digital product (no `pack:` tag by design) would fail the tag-classification guard and return empty rates for the whole cart, blocking checkout of the accompanying physical items. Fixed at [rates.js:~1295](app/api/shipping/rates.js). Log line updated: `N fee/digital excluded` replaces `N processing-fee excluded`. |
| 2026-07-20 | **Client shipping-doc cross-check — 2 bugs fixed**: (1) **UPS mini units 3→6** — client's stated capacity (6×G1, 5×G2, 4×G4) requires 4.5-6 units, but the code had `units: 3`, silently routing these glass-heavy carts to 11×9×4 envelope and losing the intended glass-safety protection. (2) **Step 2 broad "larger bottles" fix** — client Q6 said UPS mini triggers only when "no large liquids or larger bottles" — Step 2 now rejects M (medium) in addition to L. A medium+glass mixed cart now correctly falls to 11×9×4 envelope. Test cases §19.12 added covering both fixes. Non-liquid-large-cart routing unchanged. |
| 2026-07-20 | **Preliminary `pack:XL` + `pack:OTHER` support removed** — these two tags were structurally added on 2026-07-17 per PM's directive ("build now, I'll confirm with Trace"). Trace has NOT confirmed since. To keep `ALLOWED_CATEGORIES` limited to the 9 client-confirmed values, both tags are removed from the classifier + counts + `selectBox` Step 0 was dropped. The 5 un-mappable products (Body FX, Circulatory Health, Control, Three Lac, Trimsulin) now trigger the standard "no shipping available" back-pressure until Trace confirms a taxonomy. Doc §6.1, §7 (Step 0 gone), §19.12 (test removed), §20 updated. |
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

## 22. Real-Order Verification Data (2026-07-30 PDF review)

Ground-truth check of the current 7-step selection algorithm against real client fulfillment behaviour. This section is the **evidence base** for the four new pending items in §20; if any pending item is re-scoped or dismissed, cross-reference here to see what real orders motivated it.

### 22.1 Source + provenance

- **Source**: PDF sent by Parker (PM) on 2026-07-30, containing 34 recent client orders with the client's actual packed box size handwritten on each order.
- **Not committed to repo** — the PDF contains handwritten customer annotations and is client-confidential. It lives with the PM. Ask Parker for the file if you need to re-verify a specific order.
- **Verification method**: mental trace through the current algorithm (no automated end-to-end test run against staging yet — pending).
- **Confidence caveat**: order numbers / customer names in the tables below are **best-effort reconstruction** from the AI session context that produced the analysis. Any specific name/number should be **re-verified against the source PDF** before it's used to drive an operational decision (e.g. before flagging a specific product to Trace). The **bucket counts and category patterns** are the trustworthy output; individual row identifiers are supporting evidence, not gospel.

### 22.2 Summary — how well the algorithm matched reality

| Bucket | Count | % of 34 | Meaning |
|---|---|---|---|
| ✅ **Match** | 17 | 50% | Algorithm picked the same box the client actually packed. |
| 🐛 **Bug C1** | 6 | 18% | Algorithm returned Enersync 2oz (11×7×8) via the `boxTiers[length-1]` gotcha; client used 18×14×8. **Fixed 2026-07-30.** |
| 📦 **Missing tier** | 5 | 15% | Client used a box size not in our 14-tier `PACKING.boxTiers`. See §22.4. |
| ⚙️ **Calibration** | 6 | 18% | Algorithm picked the smallest-fit tier; client used the next size up. Two subcauses in §22.5. |
| 🔀 **Systemic gap** | 1 | 3% | Client physically split cart into multiple boxes (algorithm has no multi-package logic today). See §22.6. |

Total = 35 (Grady is counted once in Missing-tier and once in Systemic gap because it exhibits both issues — see §22.6).

### 22.3 Bucket A — Bug C1 (18%, now fixed)

6 orders where the algorithm hit Step 0 (OTHER-route), Step 3 (LL-overflow), or Step 5 (non-liquid-overflow) fallback path and returned `boxTiers[length-1]` = Enersync 2oz instead of 18×14×8.

Fix landed 2026-07-30 in both `ns-retail/app/api/shipping/rates.js` and `wholesale/app/api/shipping/rates.js` via new `resolveLargestOverflowBox()` helper (see §5.2.1). Re-verifying these 6 orders against the fixed code should now produce Match.

Specific order identifiers not reliably preserved in session context — re-derive from PDF if needed for a re-verification test. The pattern is: any large cart that pushed past every tier's `units`/`liquids` capacity.

### 22.4 Bucket B — Missing tier (15%)

Client used a physical box we don't have a tier definition for. Need Trace to confirm tare weight + capacity before adding.

| Client's box | Order (approx.) | Cart snapshot | Category likely to fit better than our current picks |
|---|---|---|---|
| **9×7×5** | Coleman (~13 items) | mixed non-liquid | between 9×6×4 and 11×9×4 |
| **13×11×2** | Babon (~12 items) | mixed non-liquid | flatter than 11×9×4, similar footprint |
| **12×10×2** | Goolsby (100× G1 EnerSync 1oz), used ×5 boxes | 100 small glass | overlaps with Systemic gap — see §22.6 |
| **9×6×6** | Christisen (~18 items) | mixed | between 8×6×6 and 10×7×6 |
| **10×10×10** | Wendy (~46 items) | large mixed | cube shape, no cube tier exists in our list |

Note: customer/count columns are approximate — re-verify against PDF before adding boxes.

### 22.5 Bucket C — Calibration mismatches (18%)

6 orders where algorithm picked minimum-fit; client packed in next tier up. Two distinct subcauses:

**C1) Single-item cases → product `pack_category` re-review candidates (2 orders)**

Product is classified in a category whose default box doesn't physically fit its bottle. Fix is a Shopify metafield update per product, no code change.

| Order (approx.) | Product | Current cat. | Algo box | Client box | Suggested review |
|---|---|---|---|---|---|
| #14126 | Sleep Formula ×3 | (from §22 context) | 9×6×4 | 11×9×4 | Product may need S → M reclassification |
| #40469 | Calvert Omega Complete ×1 | S | 9×6×4 | 11×9×4 | Product may need S → M reclassification |

**Action for client**: ask Trace to confirm which of these products should have their `custom.pack_category` metafield changed. Full list to be compiled from PDF cross-reference; two above are the ones surfaced in analysis.

**C2) Multi-item LL cases → liquid-box extras capacity may be too optimistic (4 orders)**

Algorithm picks the smallest liquid box where `liquids ≥ llDemand AND units ≥ unitDemand`; client picked next size up. Suggests the `units` values on liquid boxes overstate what physically fits alongside a full LL.

| Order (approx.) | Cart | Algo box | Client box |
|---|---|---|---|
| #40470 | Reitz (LL×2 + G2×2 = 4 items) | 10×7×6 | 11×4×12 |
| CDO Spencer | LL + G1 + S (3 items) | 8×6×6 | 11×4×12 |
| CDO Johnson | LL + G1 + S×2 (4 items) | 8×6×6 | 11×4×12 |
| #40487 | Lehn (LL + many = 10 items) | 18×14×8 | 11×4×12 (unusual — smaller than algo!) |

**Action for client**: waiting on Trace's answer to Q1 (per-liquid-box realistic extras count with a full LL load). Answer will drive a numerical adjustment to the `units` field on each liquid tier in `PACKING.boxTiers` — no code logic change, just number tuning.

### 22.6 Bucket D — Systemic gap: multi-package split (3%)

1 order in the sample: **Grady, 100 bottles, packed by client into 5 physical boxes of 12×10×2**. Overlaps with Bucket B (12×10×2 is a missing tier) — but even if we added that tier, our algorithm today would still quote **1** shipment, not 5.

Root cause: `selectBox()` returns one `{ box, overflow }` result. USPS/UPS receive one dims-and-weight payload. There's no data path for "cart splits into N packages, quote each separately, sum the rates."

**Action**: not implementable without a design decision from client on:
- Business rule for when to split (item count? total volume? weight threshold?)
- Whether every rate response should be a sum (customer sees one line) or itemized (customer sees N shipments)
- How to pick the box per split (same box for all, or optimize per split?)

Deferred until client explicitly asks for it. Occurrence rate is 1/34 = 3% — not urgent.

### 22.7 What tomorrow's client questions should ask

Based on the buckets above, the four specific questions to send Trace / PM:

1. **Missing sizes** (§22.4): "Aap ne 9×7×5, 13×11×2, 12×10×2, 9×6×6, 10×10×10 use kiye. Kya inko humari tier list mein add karna hai? Agar haan, har box ka **tare weight** aur **capacity** (kitne SS/S/M/L/LL/G items fit hote hain) chahiye."
2. **Product re-review** (§22.5 C1): "Ye 2 products (Sleep Formula, Calvert Omega Complete) aap bade envelope mein pack karti ho — kya inki category badalni chahiye (S → M)? Aur koi products bhi hain iss list mein?" — full PDF cross-reference needed to compile complete list before sending.
3. **Extras allowance** (§22.5 C2): "Har liquid box mein — 6 full LL bottles ke saath — realistic extras count kya hai (SS / S / M / G1 / G2 / G4 counts)?" — this is Trace's still-open Q1 from July.
4. **Multi-package rule** (§22.6): "100-bottle order aapne 5 boxes mein pack kiya. Kis point pe cart split karna chahiye (item count? weight?)? Aur checkout par customer ko ek quote dikhana hai ya per-box breakdown?"

### 22.8 How to use this section

- **Adding a new box tier** (from client answer to Q1): update §5.2 table + §PACKING.boxTiers + add a test case in §19.
- **Re-categorizing a product** (from client answer to Q2): no code change — merchant updates the Shopify metafield. Log the change here in §22.5 C1 table for audit.
- **Tuning extras allowances** (from client answer to Q3): update `units` field on the relevant liquid tier in `PACKING.boxTiers` + refresh §5.2 table.
- **Implementing multi-package** (from client answer to Q4): major work — new §23 will be needed; §7 selection algorithm gets a new post-step; §9 carrier integrations get a fan-out layer.

Cross-reference: each of the 4 §20 pending items points back to the relevant §22 subsection.

---

## Reference

- **Current code**: [`ns-retail/app/api/shipping/rates.js`](app/api/shipping/rates.js)
- **Wholesale parallel** (independent shipping logic): [`wholesale/app/api/shipping/rates.js`](../wholesale/app/api/shipping/rates.js)
- **Session changelog**: [`PROGRAM.md`](../PROGRAM.md) at repo root
- **Processing-fee UI extension** (currently disabled but deployed): [`ns-retail/extensions/processing-fee/`](extensions/processing-fee/)

---

**Doc maintenance rule**: when you touch `rates.js`, touch this file too. Add a row to §21 changelog. If a change affects a numbered section (e.g. new box tier → update §5.2, new classification category → update §6.1), update that section as well. Small edits are fine — the goal is that the doc doesn't drift from reality.
