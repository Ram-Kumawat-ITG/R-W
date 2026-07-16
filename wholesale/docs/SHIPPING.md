# Shipping & Fulfillment Tracking

How the wholesale app captures shipment tracking, derives ship/delivery dates,
pushes shipping onto the customer's QuickBooks invoice, and mirrors fulfillment
status to the retail store for drop-ship orders.

> Scope note: "shipping" here means **fulfillment / shipment tracking** —
> carrier, tracking number, shipment status, ship date, delivery date — driven
> off Shopify fulfillments. It is **not** shipping-rate calculation at checkout
> (there is no carrier-rate service in the wholesale app; rates are Shopify's).

---

## 1. Overview

Shopify is the source of truth for fulfillment. When an order is fulfilled (or
its tracking/carrier status changes) in the wholesale Shopify admin, Shopify
fires a fulfillment webhook. The app captures the shipment onto the local order,
resolves a clickable carrier tracking link, recomputes the order's official ship
and delivery dates, writes the carrier + tracking + ship date onto the
customer-facing **QBO invoice**, re-sends the invoice email when shipping
changes, and — for **drop-ship** orders — mirrors the whole fulfillment state
onto the linked **retail** Shopify order.

Everything is **best-effort and idempotent**: a failure in any downstream step
(QBO, email, retail mirror) never blocks tracking capture, and repeated /
duplicate webhooks never double-write.

---

## 2. End-to-end flow

```
Shopify wholesale admin: order fulfilled / tracking updated / delivered
        │
        ├── fulfillments/create ──┐
        ├── fulfillments/update ──┼──▶ webhooks.fulfillments.{create,update}.jsx
        │                         │      (HMAC verify → 200 immediately →
        │                         │       fire-and-forget handler)
        │                         ▼
        │             order.service.handleFulfillmentUpdate({ shop, fulfillment, event })
        │                         │
        │                         ├─ dedup on ShopifyOrder.seenWebhookIds[]
        │                         ├─ applyFulfillmentToOrder()  ── upsert fulfillments[]
        │                         │      + resolve carrier deep-link
        │                         │      + append trackingHistory[] (on change)
        │                         │      + stamp fulfillments[].deliveredAt (first `delivered`)
        │                         ├─ recomputeShipDate()      → order.shippedAt  (earliest)
        │                         ├─ recomputeDeliveredAt()   → order.deliveredAt (when ALL delivered)
        │                         ├─ appendInvoiceRemark()    (audit)
        │                         ├─ pushShippingToInvoice()  → QBO ShipDate + TrackingNum + memo
        │                         │                             + re-send invoice email (on change)
        │                         └─ notifyRetailOfDropshipChange()  (drop-ship only)
        │
        └── (webhook missed / order predates subscription?)
                    │
                    ▼
        Order Details loader calls order.service.syncFulfillmentsFromShopify()
            → live-pulls fulfillments via Admin GraphQL, reuses the SAME
              applyFulfillmentToOrder() upsert → tracking always renders on view
```

Two independent capture paths, one shared writer (`applyFulfillmentToOrder`):

| Path | Trigger | Reliability role |
|---|---|---|
| **Webhook** | `fulfillments/create` + `fulfillments/update` | Real-time primary |
| **Live-pull** | Order Details page load (`syncFulfillmentsFromShopify`) | Backstop — heals missed webhooks + backfills pre-subscription orders |

---

## 3. Data model — `ShopifyOrder` shipping fields

Defined in [app/models/order.server.js](../app/models/order.server.js).

| Field | Meaning |
|---|---|
| `fulfillments[]` | Current state, **one entry per Shopify fulfillment id**, upserted in place. Each: `fulfillmentId`, `trackingNumber`, `trackingCompany` (raw), `carrierKey` (normalized `ups\|fedex\|usps\|dhl\|other`), `trackingUrl` (resolved deep-link), `shopifyTrackingUrl` (Shopify's own), `shipmentStatus` (carrier-driven), `status` (fulfillment-level), `fulfilledAt`, `estimatedDeliveryAt`, `deliveredAt`. |
| `trackingHistory[]` | **Append-only** audit trail — one row per detected change (number / carrier / status), `event: created\|updated`. Powers "what changed when" on Order Details. |
| `trackingUpdatedAt` | Timestamp of the last tracked change. |
| `shippedAt` | **Official Ship Date** = the *earliest* `fulfillments[].fulfilledAt` (when it first shipped). |
| `deliveredAt` | **Official Delivery Date** = the *latest* per-shipment `deliveredAt`, set **only once EVERY active (non-cancelled) shipment is delivered**; null while any is in flight. |
| `fulfillmentStatus` | Order-level rollup mirrored from Shopify (`fulfilled` / `partially_fulfilled` / `unfulfilled`). |

---

## 4. Carrier resolution & tracking links

Pure, **isomorphic**, dependency-free helpers in
[app/utils/shipping.constants.js](../app/utils/shipping.constants.js) (safe to
import from both server and admin render — no `process.env`, no I/O):

- **`normalizeCarrier(raw)`** — maps Shopify's free-text `tracking_company`
  ("United States Postal Service", "DHL Express", …) to a key
  (`ups`/`fedex`/`usps`/`dhl`/`other`).
- **`resolveCarrierTrackingUrl({ carrierKey, trackingNumber, shopifyUrl, extraTemplates })`** —
  builds the official carrier deep-link (tracking number pre-filled), falling
  back to Shopify's own `tracking_url`, then null.
- **`CARRIER_TRACKING_URL_TEMPLATES`** — base UPS / FedEx / USPS / DHL templates.
- **`deriveDeliveryStatus(fulfillments)`** — rolls per-shipment statuses into ONE
  order-level status: `failure` first, `delivered` only when all delivered, else
  the *least-progressed* shipment (uses `SHIPMENT_STATUS_RANK`).
- **`shipmentStatusLabel` / `carrierDisplayName`** — human labels.

**Extra/override carriers** without a code change:
[app/services/order/tracking.config.js](../app/services/order/tracking.config.js)
reads the `CARRIER_TRACKING_URLS` env (a JSON `{ carrierKey: "url…{trackingNumber}…" }`
map) and passes it as `extraTemplates`. The **service resolves and stores** the
final URL on the order doc, so the render side never touches env.

> **Important boundary:** the render (admin route) reads the already-stored
> `trackingUrl`; it never imports `tracking.config.js`. This is the project rule
> that keeps `process.env` chains out of the browser bundle.

---

## 5. Ship date & delivery date

- **Ship date** (`recomputeShipDate`): earliest `fulfilledAt` across shipments.
- **Delivery date** (`recomputeDeliveredAt`): latest per-shipment `deliveredAt`,
  but only when **every active shipment** has one — so a partially-delivered
  multi-shipment order has no order-level delivery date yet.
- **`deliveredAt` is first-detection-wins** per shipment: stamped the first time
  `shipment_status === 'delivered'` and never overwritten, so the recorded date
  is stable across re-syncs. The observation time is the webhook's `updated_at`
  (Shopify bumps it on the delivered scan), else `now`.

---

## 6. Pushing shipping onto the QBO invoice

`order.service.pushShippingToInvoice(localOrder)` → `qbo.service.setInvoiceShipping()`
writes shipping onto the customer's QuickBooks invoice in one sparse update
(SyncToken-guarded):

- **Native `ShipDate`** — from `order.shippedAt` (the fulfillment date), date-only.
- **Native `TrackingNum`** — `"Carrier Number | Carrier Number"` per shipment;
  renders in the invoice header below Ship Date.
- **`CustomerMemo` shipping block** — a managed `Shipping:` section listing
  `Carrier — Number (Status)` + a bare `Track: <url>` line (QBO memo is plain
  text; most PDF/email clients auto-linkify the URL). The block is **replaced,
  not duplicated**, on repeat writes; anything above the marker (e.g. "Shopify
  order #1140") is preserved.
- **No-op guard** — `setInvoiceShipping` skips the POST when memo/ShipDate/
  TrackingNum are all unchanged, so the live-pull can safely run on every Order
  Details view (it also **backfills** these fields onto invoices created before
  they existed) without redundant writes.
- **Email re-send** — after a successful push, `dispatchInvoiceLifecycleEmails({ event: 'fulfillment' })`
  re-sends the QBO invoice email **only when `ShipDate` or `TrackingNum` changed**
  since the last fulfillment email (deduped on `Invoice.invoiceEmailedShipDate` /
  `invoiceEmailedTrackingNum`), so multi-status updates don't spam the customer.

---

## 7. Admin UI (Order Details)

On [app/routes/app.orders.$id.jsx](../app/routes/app.orders.$id.jsx):

- **Shipment tracking** section — per shipment: carrier name, **tracking number
  as a clickable deep-link** (`<s-link target="_blank">`), ship date, shipment
  status badge (`ShipmentStatusBadge`), estimated delivery; plus a newest-first
  **tracking-history** table.
- The loader calls `syncFulfillmentsFromShopify` **best-effort** so tracking
  renders on view even if the webhook was missed (a Shopify outage never 500s
  the page).
- **QuickBooks invoice** panel shows a Shipping block (carrier + tracking).
- **Admin Orders (drop-ship) list** ([app.admin-orders._index.jsx](../app/routes/app.admin-orders._index.jsx))
  shows a **Delivery status** column via `deriveDeliveryStatus`, with the ship
  date and delivered date stacked on the fulfillment/delivery cells and carrier
  links merged into the fulfillment cell.

---

## 8. Cross-store mirror (drop-ship: Wholesale → Retail)

For **drop-ship** orders only, fulfillment status is mirrored onto the linked
**retail** Shopify order (reverse of the retail→wholesale intake sync).

- Wholesale side:
  [services/sync/fulfillmentSync.service.notifyRetailOfDropshipChange()](../app/services/sync/fulfillmentSync.service.js)
  is called from `handleFulfillmentUpdate`, `syncFulfillmentsFromShopify`, and
  `handleOrderCancelled` (right after `pushShippingToInvoice`).
  - **Gated** on a `DropshipMapping` existing (the cross-store link) — ordinary
    wholesale orders are skipped.
  - **Deduped** on a content **signature** of the fulfillment state stored on
    the mapping (`retailFulfillmentSync`), so repeated/identical syncs don't
    re-POST.
  - **Best-effort** with an `AbortSignal.timeout` — never throws into the
    fulfillment path; failures email the admin
    (`notifyFulfillmentSyncFailed`).
  - POSTs to `${NS_RETAIL_API_BASE}/api/sync/wholesale-fulfillment` with the
    `x-sync-secret` header. Enabled only when `NS_RETAIL_API_BASE` +
    `RETAIL_SYNC_SECRET` are set (`isFulfillmentSyncEnabled()`).
- Retail side (ns-retail): `POST /api/sync/wholesale-fulfillment` →
  `wholesaleFulfillment.applyWholesaleFulfillment` creates the retail Shopify
  fulfillment (`fulfillmentCreate`, notify customer) or updates tracking
  (`fulfillmentTrackingInfoUpdate`, customer notified **only when the tracking
  number changed**).
- **Delivered milestone** — a delivered/status-only change (tracking number
  unchanged) **skips the Shopify re-write** on the retail side (carrier status
  isn't API-settable) and records `delivered` + `deliveredAt` directly.
- **Cancellation** — tags the retail order `wholesale-cancelled`; it does **not**
  auto-refund the paid retail order (a manual money decision).

---

## 9. Idempotency & reliability (the guarantees)

- **Webhook dedup** — `ShopifyOrder.seenWebhookIds[]` catches Shopify's
  at-least-once redelivery of the same fulfillment webhook.
- **History only on real change** — `applyFulfillmentToOrder` appends a
  `trackingHistory[]` row (and bumps `trackingUpdatedAt`) **only** when a tracked
  field actually changed.
- **Shared writer** — webhook and live-pull both go through
  `applyFulfillmentToOrder`, so they can never drift.
- **QBO no-op guard** — `setInvoiceShipping` skips writes when nothing changed.
- **Email dedup** — fulfillment re-send gated on the emailed ship-date /
  tracking-number snapshots.
- **Retail mirror dedup** — content-signature short-circuit on the mapping.
- **Non-blocking** — QBO push, email, and retail mirror each have their own
  try/catch; none can fail tracking capture, and the webhook returns 200 before
  any of it runs.

---

## 10. Configuration

**Scopes** ([shopify.app.toml](../shopify.app.toml)): `read_orders`,
`read_fulfillments`, `write_orders` (retail-side needs
`write_*_fulfillment_orders`).

**Webhook subscriptions** — registered **both** declaratively in
`shopify.app.toml` **and** programmatically via `REQUIRED_SUBSCRIPTIONS`
(`FULFILLMENTS_CREATE` / `FULFILLMENTS_UPDATE`) in
[shopify.constants.js](../app/services/shopify/shopify.constants.js), because
fulfillment topics are protected-customer-data topics that can be pending
Partners approval.

**Env vars:**

| Var | Purpose |
|---|---|
| `CARRIER_TRACKING_URLS` | JSON map of extra/override carrier deep-link templates (optional) |
| `NS_RETAIL_API_BASE` | ns-retail base URL for the drop-ship fulfillment mirror |
| `RETAIL_SYNC_SECRET` | shared secret (`x-sync-secret`) for the mirror POST |
| `NS_RETAIL_SYNC_TIMEOUT_MS` | timeout bound on the mirror fetch |

---

## 11. Key files

| File | Role |
|---|---|
| [app/routes/webhooks.fulfillments.create.jsx](../app/routes/webhooks.fulfillments.create.jsx) / [.update.jsx](../app/routes/webhooks.fulfillments.update.jsx) | Thin webhook handlers (verify → 200 → fire-and-forget) |
| [app/services/order/order.service.js](../app/services/order/order.service.js) | `handleFulfillmentUpdate`, `syncFulfillmentsFromShopify`, `applyFulfillmentToOrder`, `recomputeShipDate`, `recomputeDeliveredAt`, `pushShippingToInvoice` |
| [app/utils/shipping.constants.js](../app/utils/shipping.constants.js) | Pure carrier map + normalize/resolve/derive helpers (isomorphic) |
| [app/services/order/tracking.config.js](../app/services/order/tracking.config.js) | Env-configured extra carrier templates (server-only) |
| [app/services/qbo/qbo.service.js](../app/services/qbo/qbo.service.js) | `setInvoiceShipping` (ShipDate + TrackingNum + memo block) |
| [app/services/sync/fulfillmentSync.service.js](../app/services/sync/fulfillmentSync.service.js) | Drop-ship Wholesale→Retail fulfillment mirror |
| [app/models/order.server.js](../app/models/order.server.js) | Shipping schema fields |
| [INTEGRATIONS.md](../INTEGRATIONS.md) §4.6 / §5.7 | Canonical deep spec |

---

## 12. Key things to remember

1. **Shopify is the source of truth** — the app only *captures* fulfillment; it
   never sets carrier status.
2. **Two capture paths, one writer** — webhooks (real-time) + Order Details
   live-pull (backstop) both funnel through `applyFulfillmentToOrder`.
3. **Ship date = earliest fulfillment; delivery date = latest, and only when
   ALL shipments delivered.** `deliveredAt` per shipment is first-write-wins.
4. **QBO shipping writes are idempotent** (no-op guard) and **backfill** onto
   older invoices on the next view.
5. **Invoice email re-sends only when ship date / tracking number changed** — no
   spam on status churn.
6. **Carrier deep-links are resolved server-side and stored**; the render only
   reads the URL back (never imports config/env).
7. **The retail mirror is drop-ship-only, gated on a `DropshipMapping`,
   signature-deduped, and best-effort** — it can never break wholesale
   fulfillment capture.
8. **Everything downstream is non-blocking** — the webhook 200s first; QBO,
   email, and retail mirror failures are logged, never fatal.
