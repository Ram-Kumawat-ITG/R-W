# Shopify → QBO → NMI Integration

Technical reference for the order-to-payment pipeline in this Shopify app.
Every claim in this document maps to a specific file in `app/` — paths are
included in section headings so future contributors can read the doc and
the code side-by-side.

---

## Table of contents

1. [System overview](#1-system-overview)
2. [Architecture & project structure](#2-architecture--project-structure)
3. [End-to-end flow](#3-end-to-end-flow)
4. [Shopify webhook flow](#4-shopify-webhook-flow)
5. [Order processing orchestrator](#5-order-processing-orchestrator)
6. [Customer management & `customer_maps`](#6-customer-management--customer_maps)
7. [QBO integration](#7-qbo-integration)
8. [NMI integration](#8-nmi-integration)
9. [Cheque / ACH payment handling](#9-cheque--ach-payment-handling)
10. [Scheduler & cron workflow](#10-scheduler--cron-workflow)
11. [Payment retry mechanism](#11-payment-retry-mechanism)
12. [Status synchronization across QBO, Shopify, and local DB](#12-status-synchronization-across-qbo-shopify-and-local-db)
13. [Duplicate invoice prevention](#13-duplicate-invoice-prevention)
14. [Error handling & retry strategy](#14-error-handling--retry-strategy)
15. [Logging & monitoring](#15-logging--monitoring)
16. [Environment variables](#16-environment-variables)
17. [Database collections](#17-database-collections)
18. [API request/response examples](#18-api-requestresponse-examples)
19. [Development vs production behavior](#19-development-vs-production-behavior)
20. [Testing flow & test credentials](#20-testing-flow--test-credentials)
21. [Public webhook URL handling (Cloudflare / ngrok)](#21-public-webhook-url-handling-cloudflare--ngrok)
22. [Edge cases & validations](#22-edge-cases--validations)
23. [Deployment / setup](#23-deployment--setup)
24. [Future enhancements](#24-future-enhancements)

---

## 1. System overview

The pipeline turns a new Shopify order into a paid QuickBooks invoice via the NMI payment gateway.

```
Shopify order  →  Webhook  →  QBO invoice (pending)
                          ↓
                  Scheduler (every 30s in dev, 15th + last in prod)
                          ↓
                  NMI charge against stored Customer Vault
                          ↓
                  On success:
                    - QBO invoice marked Paid (POST /payment)
                    - Shopify order marked Paid (orderMarkAsPaid)
                    - Local shopify_orders doc updated
                  On failure:
                    - Stays pending, retried next tick (capped attempts)
```

Three external systems, one orchestrator. Failures in any single system
are isolated — a Shopify outage does not stop QBO from being recorded,
and a transient QBO error does not invalidate a successful NMI charge.

---

## 2. Architecture & project structure

Stack: React Router 7 (Remix-style) + Node 20+ + Mongoose 9 + Agenda 5.

```
app/
├── api/                                  # INBOUND HTTP API handlers (thin: validate → call service → respond)
│   ├── registration-form.js              #   POST /api/registration-form  (proxy submit)
│   └── admin/                            # Admin-authenticated endpoints (feature-grouped)
│       ├── customers.js                  #   GET  /api/admin/customers
│       ├── customer.js                   #   GET  /api/admin/customers/:id
│       ├── decline.js                    #   POST /api/admin/customers/:id/decline
│       ├── review.js                     #   POST /api/admin/customers/:id/review
│       ├── unreview.js                   #   POST /api/admin/customers/:id/unreview
│       └── index.js                      #   Barrel re-export (namespaced) for programmatic consumers
│
│                                         # Note: webhook handlers live under routes/ (below),
│                                         # using React Router's file-based routing convention.
│
├── services/                             # Service-oriented, organized by domain
│   ├── APIService/                       # Shared foundation
│   │   ├── mongo.service.js              #   MongoDB connection (was db.server.js)
│   │   ├── api.service.js                #   sendResponse + common response helpers
│   │   └── http.service.js               #   fetch wrapper with retry + classification
│   │
│   ├── shopify/                          # Shopify Admin GraphQL
│   │   ├── shopify.service.js            #   Domain: markOrderPaid, ensure/listWebhooks, customer ops
│   │   ├── shopify.apis.js               #   Admin client wrappers (auth + unauthenticated)
│   │   ├── shopify.queries.js            #   GraphQL query strings
│   │   ├── shopify.mutations.js          #   GraphQL mutation strings
│   │   ├── shopify.config.js             #   appUrl, appProxy
│   │   ├── shopify.utils.js              #   toE164US, mapAddress, buildShopifyNote, toOrderGid
│   │   └── shopify.constants.js          #   REQUIRED_SUBSCRIPTIONS, note maps (CRED/REFERRAL)
│   │
│   ├── qbo/                              # QuickBooks Online
│   │   ├── qbo.service.js                #   Domain: findOrCreateCustomer, createInvoice, recordPayment
│   │   ├── qbo.apis.js                   #   OAuth2 + retry + 401-refresh + Fault classification
│   │   ├── qbo.config.js                 #   QBO_* env (clientId/secret/realmId/refreshToken/etc.)
│   │   ├── qbo.utils.js                  #   escapeQboQuery, truncate, toCustomerPayload, toInvoiceLine, toQboAddress
│   │   └── qbo.constants.js              #   QBO_BASE_URLS, OAUTH_TOKEN_URL, ACCESS_TOKEN_SAFETY_MS
│   │
│   ├── nmi/                              # NMI gateway
│   │   ├── nmi.service.js                #   Domain: findOrCreateCustomerVault, charge/refund/void
│   │   ├── nmi.apis.js                   #   form-encoded transact.php + query.php transport
│   │   ├── nmi.config.js                 #   NMI_* env + assertSafeTestCardConfig
│   │   ├── nmi.utils.js                  #   encodeForm, parseResponseBody, classifyNmiResponse
│   │   └── nmi.constants.js              #   NMI_BASE_URLS, RESPONSE_OUTCOME, NMI_SENSITIVE_PARAMS
│   │
│   ├── payment/                          # Payment orchestration (on top of nmi)
│   │   ├── payment.service.js            #   chargeInvoice (was chargeInvoice)
│   │   └── payment.config.js             #   maxRetryAttempts, chargeImmediately, httpRetry*
│   │
│   ├── customer/                         # Cross-system customer mapping
│   │   ├── customer.service.js           #   ensureCustomerForOrder (sources NMI vault from wholesale_applications)
│   │   └── customer.utils.js             #   normalizeAddress, buildProfileFromShopifyOrder
│   │
│   ├── invoice/                          # Local invoice lifecycle
│   │   ├── invoice.service.js            #   createInvoiceForOrder, propagateSuccessfulPayment
│   │   └── invoice.utils.js              #   shopifyLinesToQboLines, syncWithRetry
│   │
│   ├── order/                            # Order processing orchestrator
│   │   ├── order.service.js              #   processShopifyOrder (the top-level driver)
│   │   └── order.validator.js            #   validateShopifyOrder (pre-flight checks)
│   │
│   └── scheduler/                        # Agenda lifecycle + recurring jobs
│       ├── scheduler.service.js          #   getAgenda + scheduleNow + lifecycle
│       ├── scheduler.config.js           #   cron/interval/timezone
│       └── jobs/
│           ├── index.js                  #   Job registry
│           ├── processOrder.job.js
│           └── processPendingPayments.job.js
│
├── routes/                               # UI / admin pages + inbound webhook handlers (file-based routing)
│   ├── app.jsx, app._index.jsx           #   Embedded admin shell + dashboard
│   ├── app.customers._index.jsx
│   ├── app.customers.$id.jsx
│   ├── app.orders._index.jsx             #   Orders list (filter + paginate)
│   ├── app.orders.$id.jsx                #   Order detail + "Retry Now" payment action
│   ├── app.webhooks.jsx                  #   /app/webhooks diagnostic page
│   ├── webhooks.orders.create.jsx        #   POST /webhooks/orders/create (Shopify orders/create)
│   ├── webhooks.app.uninstalled.jsx      #   App lifecycle (pre-existing, template)
│   └── webhooks.app.scopes_update.jsx    #   App lifecycle (pre-existing, template)
│
├── models/                               # Mongoose schemas (no business logic)
│   ├── customerMap.server.js
│   ├── invoice.server.js
│   ├── order.server.js
│   ├── paymentAttempt.server.js
│   ├── qboToken.server.js
│   └── wholesaleApplication.server.js
│
├── utils/                                # Global utilities (cross-service)
│   ├── env.utils.js                      #   readEnv / readInt / readBool
│   ├── logger.utils.js                   #   structured logger
│   └── retry.utils.js                    #   retry() + PermanentError / TransientError
│
├── configs/
│   └── index.js                          #   Boot config aggregator + assertSafeBootConfig
│
├── entry.server.jsx                      #   SSR + boot banner + scheduler bootstrap
├── shopify.server.js                     #   Pre-existing Shopify app config
└── routes.js                             #   Route table (URL → file mapping)
```

Design rules:

- **Service-oriented file split per integration.** Each service folder
  follows the same convention: `<svc>.service.js` (domain methods),
  `<svc>.apis.js` (HTTP/I/O), `<svc>.queries.js` + `<svc>.mutations.js`
  for GraphQL (Shopify only), `<svc>.config.js`, `<svc>.utils.js`,
  `<svc>.constants.js`. Developers can navigate any service without
  hunting across folders.
- **Inbound HTTP handlers live in `app/api/`.** Each file is thin:
  request validation, HMAC/auth, response shaping, single service call.
  URL → file mapping is declared in [app/routes.js](app/routes.js) via
  `route(urlPath, fileRelativeToApp)`.
- **Outbound API calls live in `services/<svc>/<svc>.apis.js`.** No
  `fetch()` calls outside an `.apis.js` file. Domain methods in
  `<svc>.service.js` call into `.apis.js`, which calls into the shared
  `APIService/http.service.js` (or owns its own transport quirks like
  NMI's form encoding).
- **Service-specific configs live with the service.** `services/qbo/qbo.config.js`,
  `services/nmi/nmi.config.js`, etc. Only `process.env` access is via
  `app/utils/env.utils.js`. The `app/configs/index.js` aggregator
  exists for boot-time validation only.
- **Service-specific helpers live with the service.** `<svc>.utils.js`
  for pure transforms used only by that service. Cross-service helpers
  go in `app/utils/` (logger, retry, env).
- **Models hold schema + indexes only.** Business logic lives in services.
- **Idempotency baked into the data layer.** Unique indexes and atomic
  `findOneAndUpdate` calls — not just application-level checks.

---

## 3. End-to-end flow

```
┌───────────────────────────────────────────────────────────────────────┐
│ Merchant creates order in Shopify admin / storefront                  │
└───────────────────────────────────────────────────────────────────────┘
                              │
                              ▼  POST /webhooks/orders/create
                                  (X-Shopify-Hmac-Sha256 + payload)
┌───────────────────────────────────────────────────────────────────────┐
│ routes/webhooks.orders.create.jsx                                     │
│   - log all headers + webhook-id                                      │
│   - authenticate.webhook(request)        ← HMAC verify                │
│   - return 200 to Shopify FAST                                        │
│   - fire-and-forget: processShopifyOrder({ shop, order, webhookId })  │
└───────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────────────────┐
│ orders/processOrder.server.js                                         │
│   1. Webhook-id dedup pre-check (seenWebhookIds[])                    │
│   2. Terminal-status early return                                     │
│   3. Atomic CLAIM via findOneAndUpdate(status → 'processing')         │
│   4. Pre-flight validation (validateShopifyOrder)                     │
│   5. ensureCustomerForOrder        ──┐                                │
│   6. createInvoiceForOrder         ──┤                                │
│   7. (optional) chargeInvoice ┘  ← gated by chargeImmediately  │
│   8. Mark order 'scheduled' for retry pickup                          │
└───────────────────────────────────────────────────────────────────────┘
                              │
                              ▼  every 30s (dev) / 15th + last (prod)
┌───────────────────────────────────────────────────────────────────────┐
│ scheduler/jobs/processPendingPayments.job.server.js                   │
│                                                                       │
│ PASS 1 — pending invoices: NMI charge                                 │
│   for each Invoice where paymentStatus='pending' and                  │
│                          attemptCount < maxAttempts:                  │
│     chargeInvoice → chargeCustomerVault                        │
│     on approved: propagateSuccessfulPayment                           │
│     always: push Invoice.remarks[] entry (cron_card_attempt)          │
│                                                                       │
│ PASS 1.5 — failed-payment follow-up logs (payment audit)             │
│   for each Invoice where paymentStatus='failed':                      │
│     push Invoice.remarks[] entry (cron_failed_followup)               │
│     no charge / no customer notification                              │
│   (cheque reminders live in the process-check-reminders CRON, §10.5)  │
│                                                                       │
│ PASS 2 — paid invoices with broken downstream sync                    │
│   for each Invoice where paymentStatus='paid' and                     │
│         (qboPaymentRecorded=false OR shopifyMarkedPaid=false):        │
│     propagateSuccessfulPayment   ← no NMI re-charge                   │
└───────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────────────────┐
│ propagateSuccessfulPayment (invoiceService.server.js)                 │
│   - QBO    POST /payment (idempotent on qboPaymentRecorded flag)      │
│   - SHOP   orderMarkAsPaid (idempotent on shopifyMarkedPaid flag)     │
│   - DB     ShopifyOrder.paymentStatus/financialStatus/processingStatus│
│   Each side has its own retry; failures isolated; flags persisted.    │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 4. Shopify webhook flow

### 4.1 Subscription registration

`orders/create` is a **protected customer data topic** — it requires an
approval in the Partners dashboard (Partners → App → API access →
Protected customer data access) before Shopify will deliver it.

Two ways to register the subscription:

**A. Declarative — in `shopify.app.<config>.toml`** (preferred once approved)

```toml
[[webhooks.subscriptions]]
uri = "/webhooks/orders/create"
topics = [ "orders/create" ]
```

**B. Programmatic — `services/shopify/shopify.service.js`**

Called from `app/routes/app.jsx`'s loader (every authenticated admin
page load). Idempotent: checks for an existing subscription pointing at
the same callback URL before calling `webhookSubscriptionCreate`.
Failures are logged loudly but don't break the admin UI:

```
[FAILED]  ORDERS_CREATE: not approved for protected customer data
          → This usually means the app is not approved for
            protected customer data. Approve in Partners dashboard:
            Partners → your app → API access → Protected customer data
```

### 4.2 Inbound delivery — `app/routes/webhooks.orders.create.jsx`

URL mapping is via React Router's file-based routing: the dotted
filename `webhooks.orders.create.jsx` resolves to `/webhooks/orders/create`.
The other webhook routes (`webhooks.app.uninstalled.jsx`,
`webhooks.app.scopes_update.jsx`) follow the same convention.

The URL is what Shopify is configured to POST to — keep it stable across
refactors. If you rename the file, the URL changes.

```
1. Read headers BEFORE authenticate.webhook (so we can log even auth failures)
     - x-shopify-webhook-id    → idempotency key (forwarded to orchestrator)
     - x-shopify-topic         → "orders/create"
     - x-shopify-shop-domain
     - x-shopify-hmac-sha256
2. authenticate.webhook(request) — verifies HMAC; throws on tamper
3. console.dir(payload) — full pretty-printed payload dump for visibility
4. Return 200 immediately (Shopify times out at ~5s)
5. Fire-and-forget: processShopifyOrder({ shop, order, webhookId })
     - .catch is wired up so unhandled errors don't crash the process
```

### 4.3 Processing modes

`WEBHOOK_PROCESS_MODE` controls how the webhook handler runs the order:

- `inline` (default) — `processShopifyOrder` runs in the webhook process as a fire-and-forget promise. Most reliable on hosts where a long-running background worker may sleep.
- `agenda` — enqueues `process-shopify-order` job. Use after confirming Agenda's worker is alive.

In both modes the webhook returns 200 before downstream calls finish.

### 4.4 Diagnostics

- `/app/webhooks` — lists every subscription currently registered for the active shop.
- GET `/webhooks/orders/create` — returns 405 (instead of 404) with a JSON body, so you can verify the route exists in the deployed bundle:
  ```json
  { "route": "/webhooks/orders/create", "status": "alive — POST a Shopify orders/create webhook here", "method_expected": "POST" }
  ```

### 4.5 `orders/cancelled` webhook — `app/routes/webhooks.orders.cancelled.jsx`

Mirror of the create handler: verify HMAC, log, fire-and-forget into
`services/order/order.service.handleOrderCancelled`, ACK 200 fast.
Idempotent — uses `seenWebhookIds[]` for dedup just like the create
path. Subscription registered both ways:

- Declaratively in `shopify.app.dev-rk.toml`.
- Programmatically via `REQUIRED_SUBSCRIPTIONS` for the default profile
  (orders/cancelled is a protected customer data topic and needs
  Partners-dashboard approval before it can be declared).

`handleOrderCancelled({ shop, order, webhookId })` flow:

```
1. Webhook-id dedup     → ShopifyOrder.seenWebhookIds.includes(webhookId)? exit
2. Upsert ShopifyOrder  → $set: { processingStatus: 'cancelled',
                                    cancelledAt: order.cancelled_at,
                                    cancelReason: order.cancel_reason }
                          (upsert covers the case where cancelled
                          arrives BEFORE create — the late create
                          delivery then early-returns on TERMINAL_STATUSES)
3. If invoiceRef set:
    3a. Invoice.paymentStatus → 'cancelled'  (CRON skip is automatic
                                              via PASS 1's
                                              paymentStatus: 'pending'
                                              filter)
    3b. If invoice.amountPaid === 0 AND qboInvoiceId set:
          qbo.service.voidInvoice(qboInvoiceId)
        Else (paid / partially-paid):
          log warning, leave QBO alone — money is real, admin decides
          the refund manually
4. appendInvoiceRemark   { kind: 'system_note',
                           message: "Shopify order cancelled (<reason>) — ..." }
```

Race protection — `processShopifyOrder` re-fetches `cancelledAt`
immediately after invoice creation. If set, it aborts the rest of
processing, cancels the just-created invoice, and voids it in QBO.
This closes the narrow window where the cancel webhook flips the
order to `'cancelled'` while the create handler is mid-flight and a
subsequent `local.save()` would otherwise overwrite the cancellation
back to `'invoiced'`.

Refund of already-collected money is **out of scope** of this handler.
It marks the invoice cancelled and leaves the audit trail; an admin
who needs to give a partial-paid customer their money back uses the
gateway's refund tooling directly (NMI portal / cheque void).

### 4.6 `fulfillments/create` + `fulfillments/update` webhooks — shipment tracking

`app/routes/webhooks.fulfillments.create.jsx` + `.update.jsx`. Same
handler shape as the other webhooks (verify HMAC, log, fire-and-forget,
ACK 200), both calling `order.service.handleFulfillmentUpdate({ shop,
fulfillment, webhookId, event })` with `event: 'created' | 'updated'`.
Subscriptions registered both declaratively (both `shopify.app*.toml`)
and programmatically (`REQUIRED_SUBSCRIPTIONS` — `FULFILLMENTS_CREATE` /
`FULFILLMENTS_UPDATE`; fulfillment data is protected-customer-data, same
approval gate as `orders/create`). The `read_orders` scope covers it.

Purpose: capture Shopify's shipment tracking onto the local order so the
admin Order Details page can show carrier + number + status with a
click-through to the carrier's official tracking page.

`handleFulfillmentUpdate` flow:

```
1. Webhook-id dedup     → ShopifyOrder.seenWebhookIds.includes(webhookId)? exit
2. Find local order by (shop, shopifyOrderId=fulfillment.order_id)
                          → absent? log + ack (not our order)
3. Extract tracking     → tracking_number || tracking_numbers[0],
                          tracking_company, tracking_url || tracking_urls[0],
                          shipment_status, status
4. carrierKey = normalizeCarrier(tracking_company)          (ups|fedex|usps|dhl|other)
   trackingUrl = resolveCarrierTrackingUrl({carrierKey, trackingNumber,
                   shopifyUrl, extraTemplates})             (deep-link or Shopify URL)
5. Upsert fulfillments[] by fulfillmentId (in place)
6. If a tracked field changed (number/company/shipment_status/status):
     push trackingHistory[] row (event created|updated), bump trackingUpdatedAt,
     best-effort appendInvoiceRemark { kind:'system_note', "Tracking …" }
7. seenWebhookIds += webhookId; save
```

**Carrier-link resolution** is split to respect the render-import rule:
the pure, env-free `app/utils/shipping.constants.js` owns
`CARRIER_TRACKING_URL_TEMPLATES` (UPS/FedEx/USPS/DHL, `{trackingNumber}`
placeholder), `normalizeCarrier`, `resolveCarrierTrackingUrl`,
`carrierDisplayName`, `shipmentStatusLabel`. The **service** resolves and
STORES the final `trackingUrl`, so the Order Details render imports only
this pure module + the stored value — never a `*.config.js`. Ops can add
"other configured carriers" via `CARRIER_TRACKING_URLS` (JSON) read in
the server-only `services/order/tracking.config.js` and merged on top of
the base templates. Unknown carrier → falls back to Shopify's own
`tracking_url`.

**Storage** (`ShopifyOrder`): `fulfillments[]` (current state, one per
Shopify fulfillment id), `trackingHistory[]` (append-only change log),
`trackingUpdatedAt`. **Display**: a "Shipment tracking" section on
`app.orders.$id.jsx` — Fulfillment status, carrier, the **tracking number
itself as a clickable `<s-link target="_blank">`** to the carrier's tracking
page (plus a "Track shipment" link), `ShipmentStatusBadge`
(`components/admin-ui.jsx`), per-fulfillment Ship date + est. delivery +
updated-at, and a newest-first history table. The in-app **QuickBooks
invoice** panel also shows a Shipping block (Ship date + carrier +
tracking-number deep-link, one row per shipment). On the **QBO-rendered**
invoice PDF/email the tracking link can't be a true hyperlink (CustomerMemo
is plain text), so the memo includes the bare tracking URL (`Track: <url>`)
which most PDF/email clients auto-linkify.

**On the customer-facing invoice.** Carrier + tracking is also written to
the QBO invoice via `qbo.service.setInvoiceShipping({ qboInvoiceId, lines,
shipDate, trackingNum })` — one sparse update that sets the managed
"Shipping:" block in the `CustomerMemo` (SyncToken guard, replaces rather
than duplicates, preserves the base memo, 1000-char clamp), the native
`ShipDate` field, AND the native **`TrackingNum`** field (carrier + number
per shipment, joined for multi-shipment). `TrackingNum` renders in the
invoice **header next to Ship Date / Ship Via** (when shipping is enabled on
the company's sales form) — that's how tracking shows "below the Ship Date"
on the rendered invoice, separate from the top-of-invoice memo. A **no-op
guard** skips the POST when memo/ShipDate/TrackingNum already match, so
`pushShippingToInvoice` can be called on every order-view live-pull (not just
on change) to **backfill** these onto invoices synced before the fields
existed, then converge.
`order.service.pushShippingToInvoice` composes the lines + ship date from
the order's fulfillments and is called best-effort from both fulfillment
paths on any tracking change (never breaks tracking capture). The customer
sees it on the next invoice view / PDF; the invoice email is **not**
auto-resent on tracking changes (avoids spam across the
label→in-transit→delivered status sequence — admins use the "Send invoice"
button to push an updated copy).

**Ship Date (Shopify-sourced).** The official Ship Date is the Shopify
fulfillment date, not the order-creation date. `ShopifyOrder.shippedAt` is
denormalized as the **earliest** `fulfillments[].fulfilledAt`
(`order.service.recomputeShipDate`, run in both fulfillment paths) and fed
to the QBO invoice `ShipDate` (above), overwriting the order-date `ShipDate`
set at invoice creation (§7.3 / §18.3). Shown as "Ship date" on Order
Details (Overview), the invoice Shipping block, and per-shipment in the
tracking section (so partially-fulfilled orders show each shipment's own
date).

**Live-pull fallback (reliability).** Webhooks alone are not enough —
fulfillment topics are approval-gated and may not be subscribed, and they
do **not** backfill orders fulfilled before the subscription existed. So
the Order Details loader also **pulls** the order's fulfillments live via
Admin GraphQL (`QUERY_ORDER_FULFILLMENTS` →
`shopify.service.getOrderFulfillments`) and persists them through
`order.service.syncFulfillmentsFromShopify`, which reuses the same
`applyFulfillmentToOrder` upsert as the webhook path (push + pull stay in
lockstep). Best-effort: a Shopify outage never 500s the page (mirrors the
live-QBO-invoice fetch). This is why tracking shows on the order page even
with no webhook delivery; the webhooks remain for real-time push + the
invoice audit remark. `fulfilledAt` (the "Fulfillment Date") +
`estimatedDeliveryAt` come from the GraphQL pull; order-level
`fulfillmentStatus` mirrors `displayFulfillmentStatus`.

Out of scope: a customer-facing storefront order portal (none exists —
the embedded-admin Order Details page is the order view). Customers
still receive Shopify's native shipping-confirmation email with tracking.

---

## 5. Order processing orchestrator

`services/order/order.service.js` is the only place that drives an order from "received" to "scheduled." It is **idempotent and concurrency-safe**.

### 5.1 Lifecycle states (`ShopifyOrder.processingStatus`)

```
received  → processing ──┬─→ admin_order   (retail drop-ship customer — already paid; see §5.6)
                         │
                         ├─→ pending_approval ──(admin approves)──┐
                         │                                         │
                         └─→ customer_ready → invoiced → scheduled → completed
                                  │
                                  ├── rejected  (validation failed or no customer)
                                  ├── failed    (downstream error)
                                  └── cancelled (orders/cancelled webhook — see §4.5)
```

`pending_approval` is the hold state for orders from Shopify customers that
do **not** carry the `Approved` tag. The orchestrator skips QBO and NMI
work entirely for these orders. They are re-entered into the pipeline by
`replayPendingOrdersForCustomer` (triggered from `admin/review.js` when an
admin approves the customer) — see §5.4 below.

`admin_order` is the terminal hold state for orders placed by the retail
drop-ship customer (`DROPSHIP_RETAIL_CUSTOMER_EMAIL`). These are already
paid and must never touch QBO / NMI or the payment / commission CRON, so the
orchestrator diverts them **immediately after the atomic claim** — before the
approval gate, customer setup, invoice creation, and any charge. See §5.6.

### 5.2 The three idempotency layers (in this function)

| Layer | Mechanism | Catches |
|---|---|---|
| Webhook-id dedup | `seenWebhookIds[]` on ShopifyOrder | Shopify retries — same `x-shopify-webhook-id` |
| Terminal-status return | `if status ∈ {completed, invoiced, scheduled, rejected, cancelled, admin_order} → return` | Order already processed (or cancelled before / during creation, or diverted as an Admin Order) |
| Atomic claim | `findOneAndUpdate(filter, $set: { status: 'processing' })` | Two concurrent workers |

The claim filter:
```js
{
  shop, shopifyOrderId,
  $or: [
    { processingStatus: { $in: ['received', 'failed', 'customer_ready', 'pending_approval'] } },
    { processingStatus: 'processing', processingClaimedAt: { $lt: staleCutoff } }, // 5 min stale lock recovery
    { processingStatus: { $exists: false } },
  ]
}
```

`pending_approval` is reclaimable so that the admin-approval replay can
re-enter the pipeline cleanly through the same orchestrator path.

If `findOneAndUpdate` returns `null`, this worker lost the race and exits.
The winning worker continues. The `STALE_CLAIM_MS` (5 min) constant
allows a stale lock to be reclaimed if a process crashed mid-flight.

### 5.3 Pre-flight validation

`services/order/order.validator.js` blocks bad payloads before any
external call. Rejections are persisted with a `rejectionCode` instead
of thrown:

| Code | Triggered when |
|---|---|
| `PAYLOAD_INVALID` | order is null or not an object |
| `NO_ORDER_ID` | order.id missing |
| `CANCELLED` | order.cancelled_at set |
| `FINANCIAL_TERMINAL` | financial_status ∈ {voided, refunded} |
| `NO_EMAIL` | no email on order or customer |
| `NO_BILLING` | no billing_address or shipping_address |
| `NO_NAME` | no name on customer or billing address |
| `AMOUNT_INVALID` | total_price not numeric |
| `ZERO_TOTAL` | total_price ≤ 0 |
| `NO_LINE_ITEMS` | line_items empty |

The orchestrator also rejects with `NO_CUSTOMER_ID` when an order arrives
without `order.customer.id`. Guest checkouts and staff-created orders
that omit the customer are rejected definitively — there is no one to
approve later. See §5.4 for the approval gate that follows.

### 5.4 Approval gate (Shopify `Approved` tag)

After validation succeeds, the orchestrator checks the Shopify customer's
tags **live** (not from the webhook payload) before touching QBO or NMI.
Lookup is `shopify.service.customerHasApprovedTag({ shop, customerId })`,
which uses an offline session against the Admin GraphQL `customer(id) { tags }`
query. Live lookup means a customer approved between order creation and
webhook processing is picked up correctly.

| Order state at gate | Resulting `processingStatus` | Next action |
|---|---|---|
| `customer.id` present **and** tags contain `Approved` (case-insensitive) | proceeds to step 1/4 | normal flow: customer_ready → invoiced → scheduled |
| `customer.id` present, no `Approved` tag | `pending_approval` | held; auto-replayed when admin approves (see §5.5) |
| no `customer.id` on order | `rejected` with `rejectionCode='NO_CUSTOMER_ID'` | terminal — guest checkouts and staff-created orders without a customer cannot be wholesale-approved |
| tag lookup throws (Shopify down) | `failed` | reclaimable on next attempt |

The gate sits between validation and `ensureCustomerForOrder`, so unapproved
orders never write to `customer_maps`, never call QBO `findOrCreateCustomer`,
and never create an NMI vault — those side effects only happen for
approved customers.

### 5.5 Pending-order replay (`replayPendingOrdersForCustomer`)

When an admin approves a wholesale application via
`POST /api/admin/customers/:id/review`, the handler:

1. Swaps the customer's Shopify tag from `Pending` to `Approved`.
2. Sends the activation/approval email.
3. Marks the `wholesale_applications` doc as `status='approved'`.
4. **Fire-and-forget** calls `replayPendingOrdersForCustomer({ shop, email })`.

The admin response returns immediately (step 4 is non-blocking). Replay:

- Finds every `ShopifyOrder` doc with `processingStatus='pending_approval'`
  and matching `(shop, customerEmail)`.
- For each, calls `processShopifyOrder({ shop, order: row.rawPayload })`
  **sequentially**. Serial processing keeps NMI vault creation race-free
  — the first order creates the vault; subsequent orders reuse it via
  `customer_maps.nmiCustomerVaultId`.
- Per-order failures are caught and recorded on the order doc's
  `processingError`. The replay never throws.

Returns `{ total, processed, failed, skipped }` logged to console + structured logger.

`pending_approval` orders are stored with the full `rawPayload`, so replay
does not need to re-fetch from Shopify. If an order's `rawPayload` is
missing (legacy data, schema migration), it's recorded as skipped and the
admin must re-trigger via another mechanism.

### 5.6 Admin Orders (retail drop-ship customer)

Orders placed by the retail drop-ship customer — the synthetic
"Natural Solutions Retail" customer that the drop-ship orchestrator (§ drop-ship)
attaches every retail-triggered wholesale order to — are **Admin Orders**, not
wholesale orders. They are already paid and must run on a completely separate
flow: no QBO invoice, no NMI charge, and the payment / commission CRON must
never see them.

**Detection.** The single source of truth is the customer email. The anchor is
`DROPSHIP_RETAIL_CUSTOMER_EMAIL` (read once at boot into
`services/dropship/dropship.config.js` as the pre-normalized `RETAIL_CUSTOMER_EMAIL`).
`isRetailCustomerEmail(email)` does the case-insensitive comparison.

**Diversion (orchestrator).** `processShopifyOrder` checks the order's email
(`order.email || order.customer?.email`) **immediately after the atomic claim**
— before validation, the approval gate, `ensureCustomerForOrder`, invoice
creation, and any charge. On a match it sets `processingStatus = 'admin_order'`
(a terminal state) and returns. Because this runs on the **replay path** too
(`replayPendingOrdersForCustomer` → `processShopifyOrder`), a drop-ship order
can never be pulled back into the wholesale pipeline even if the synthetic
customer were ever tagged `Approved`.

**Why the CRON is automatically safe.** The payment / commission scheduler
(`processPendingPayments.job.js`, §11) iterates the **`Invoice`** collection,
never `ShopifyOrder`. Admin Orders are diverted before invoice creation, so
they produce no `Invoice` doc — there is literally nothing for the scheduler to
pick up. No CRON-side filter is required (the order-level diversion is the
guard); the order doc still lives in `shopify_orders` for audit.

**Separation in the UI.**

- The wholesale **Orders** list (`app.orders._index.jsx`) excludes them with
  `customerEmail: { $ne: RETAIL_CUSTOMER_EMAIL }` on both the row query and the
  chip-count aggregation (`$ne` still matches null/absent emails, so ordinary
  wholesale orders are unaffected).
- A dedicated **Admin Orders** nav item exposes two read-only routes:
  - `app.admin-orders._index.jsx` — list, anchored on
    `{ customerEmail: RETAIL_CUSTOMER_EMAIL }` (captures every such order
    regardless of `processingStatus`, including any ingested before this
    diversion existed), with fulfillment-status chips + search + pagination.
  - `app.admin-orders.$id.jsx` — full detail (order info, customer info, tags,
    line items + quantities/pricing, shipping + billing addresses, shipping
    method, fulfillment + tracking numbers/URLs, order note + note attributes,
    and additional Shopify metadata). It reuses the same best-effort
    `syncFulfillmentsFromShopify` live-pull as the wholesale Order Details page;
    that helper's QBO-memo push is gated on `invoiceRef`, which Admin Orders
    never have, so it only reads Shopify + writes tracking locally. The loader
    hard-guards with `isRetailCustomerEmail` so a wholesale order id cannot
    resolve here (and vice versa).

There are **no payment actions** on the Admin Order Details page — these orders
are already settled and carry no invoice.

---

## 6. Customer management & `customer_maps`

### 6.1 The mapping

`customer_maps` is the join table between Shopify (email), QBO (customer Id), and NMI (Customer Vault Id).

```js
{
  shop,
  email,                       // unique key with shop
  shopifyCustomerId,
  qboCustomerId,
  nmiCustomerVaultId,
  profile: { firstName, lastName, companyName, phone, billingAddress, shippingAddress },
  lastSyncedAt,
}
```

Unique index on `(shop, email)`. Atomic upsert via `findOneAndUpdate` in
`services/customer/customer.service.js`.

### 6.2 Address resolution

NMI rejects vault creation without a billing address. Resolution order:

```
billing  =  order.billing_address  →  order.shipping_address  →  customer.default_address
shipping =  order.shipping_address →  order.billing_address   →  customer.default_address
```

Pre-flight check (before NMI is called) verifies all required NMI fields are present:
`address1`, `city`, `state`, `zip`, `country`. Missing fields → clear error with the missing field list, persisted as a processing failure.

State / country preference: `province_code` over `province`, `country_code` over `country` (NMI requires ISO-2).

### 6.3 The customer flow

```
ensureCustomerForOrder({ shop, order })
  │
  ├── buildProfileFromShopifyOrder(order)   ← normalize address shape
  │
  ├── CustomerMap.findOneAndUpdate({ shop, email }, ..., { upsert: true })
  │                                          ← atomic; mapping doc exists after this
  │
  ├── if !mapping.qboCustomerId:
  │     findOrCreateQboCustomer(profile)    ← query QBO by email, then create
  │     mapping.qboCustomerId = result.Id
  │
  ├── WholesaleApplication.findOne({ shop, email }).select('payment.method nmiCustomerVaultId')
  │     mapping.paymentMethod   = normalize(app.payment.method)
  │     // NMI vault — read-through, no creation. Source of truth is the
  │     // wholesale_applications doc, which captured the vault id at
  │     // registration submit (see §6.4).
  │     if app.nmiCustomerVaultId:
  │       validateCustomerVault(app.nmiCustomerVaultId)   ← query.php by id
  │       mapping.nmiCustomerVaultId = app.nmiCustomerVaultId (if valid)
  │     else:
  │       mapping.nmiCustomerVaultId = undefined          (no vault on file)
  │
  └── mapping.save()
```

QBO customer creation is **skipped** if the mapping already has
`qboCustomerId`. The NMI side has no "create" branch at all — vaults
are captured exactly once during registration (§6.4) and the customer
service only mirrors + validates the id. Re-running the orchestrator
for a known customer still hits QBO zero times and NMI once (the
`validateCustomerVault` pre-flight via `query.php`).

### 6.4 NMI Customer Vault sourcing (registration-time only)

The NMI Customer Vault is created **exactly once per customer**, at
wholesale-registration submit. The resulting `customer_vault_id` always
lands at the top-level `wholesale_applications.nmiCustomerVaultId`
regardless of whether the customer's preferred method is card or ACH —
NMI's vault stores the payment method internally (`payment=cc` for
card, `payment=ck` for ACH), so a single vault id is enough for the
default-billing charge path. Cheque-preferred customers create no
vault.

```
POST /api/registration-form      (app/api/registration-form.js)
  │
  ├── WholesaleApplication.create(payload)
  ├── customerCreate() in Shopify (+ Pending tag)
  └── if payload.payment.paymentToken AND method ∈ {card, ach}:
        ← Collect.js token from form (tokenizes BOTH cards and ACH;
          NMI's resulting vault stores payment='cc' or 'ck' so the
          downstream sale knows what to do)
        const vaultId = await createCustomerVault({ profile,
            paymentDetails: { paymentToken } })
        payload.nmiCustomerVaultId = vaultId
        WholesaleApplication.updateOne({ _id }, { $set: { ... } })
```

**ACH billing id** — `wholesale_applications.payment.ach.nmi_billing_id`
is the id of a SPECIFIC billing profile INSIDE the customer vault. NMI
allows multiple billing entries on a single vault (one card + one ACH
is the common shape); the `billing_id` selects which one a sale
targets. For ACH-method invoices, the CRON pass passes BOTH
`customer_vault_id` AND `billing_id` to NMI's transact.php so the
charge runs against the ACH billing — not the vault's default. Card
charges omit the billing id and NMI uses the vault's default billing.

The billing id is NOT created by the registration handler — it's
populated separately (admin tool, NMI dashboard, or a future
add_billing call once the ACH billing profile is captured). Until then,
ACH charges are skipped with `"no NMI ACH billing id on file"`.

Downstream callers source the ids independently:

| Caller | Card path | ACH path |
|---|---|---|
| `customer.service.ensureCustomerForOrder` | Reads `wholesale_applications.nmiCustomerVaultId`, validates via `validateCustomerVault`, mirrors onto `CustomerMap.nmiCustomerVaultId`. | Same vault validation as card. Additionally reads `wholesale_applications.payment.ach.nmi_billing_id` and mirrors it onto `CustomerMap.nmiAchBillingId`. The billing id is **not** validated via `validateCustomerVault` — that endpoint queries vaults, not billing entries; the billing id is trusted and any mismatch surfaces as a precise NMI decline on the next sale. |
| `payment.service.chargeInvoice` | When `invoice.paymentMethod === 'card'`, reads `customerMap.nmiCustomerVaultId`; re-validates the vault before every NMI sale; passes `customer_vault_id` only. | When `invoice.paymentMethod === 'ach'`, reads BOTH `customerMap.nmiCustomerVaultId` (required) AND `customerMap.nmiAchBillingId` (required); validates the vault only; passes both `customer_vault_id` AND `billing_id` to NMI. The internal `resolveInvoiceVault(invoice, customerMap)` helper returns `{ vaultId, billingId, methodLabel, missingReason }` and centralises the per-method dispatch. |
| `api/admin/retry-payment.js` | Reads vault via `resolveCustomerVaultId`. | Reads vault via `resolveCustomerVaultId` AND ACH billing id via `resolveCustomerAchBillingId`; rejects with a precise 409 if either is missing. Cheque-method invoices are rejected entirely (use mark-cheque-paid). |
| `api/admin/charge-card.js` | Always routes through `resolveCustomerVaultId` and ignores the ACH billing id — this is the cross-method override path; the goal is "settle this invoice via the customer's card on file" regardless of the invoice's current paymentMethod. |

The order pipeline no longer creates vaults. Customers who registered
without a payment method (or whose vault create failed in
[registration-form.js](app/api/registration-form.js)) land in the
order flow with `nmiCustomerVaultId = null`; all NMI charges are
skipped with `"no NMI customer vault on file"`. ACH-method invoices
additionally skip with `"no NMI ACH billing id on file"` when the
vault is on file but the billing id isn't yet captured. Cheque
workflows are unaffected since they don't need a vault.

---

## 7. QBO integration

### 7.1 OAuth2 token management — `services/qbo/qbo.apis.js`

Intuit issues access tokens (1 hr) + refresh tokens (100 days, **rotated on every refresh**). Token state lives in the `qbo_tokens` collection (`models/qboToken.server.js`), keyed by `realmId`:

```js
{ realmId, accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt }
```

Refresh logic:

1. `getAccessToken()` reads the token doc.
2. If the access token expires within `ACCESS_TOKEN_SAFETY_MS` (60 s), call `refreshAccessToken(currentRefreshToken)`.
3. Concurrent refreshes are coalesced via a module-level `inFlightRefresh` promise — protects against rate-limit burn during the scheduler's tick.
4. The refresh response includes a NEW refresh token; both tokens are persisted atomically in one `findOneAndUpdate`.

If a request gets a `401` from QBO mid-call, the client force-refreshes and retries the request once with `retryOn401 = false`.

### 7.2 Bootstrapping

First run: `qbo_tokens` is empty. We seed from `QBO_REFRESH_TOKEN` env
var (obtained once from the Intuit OAuth Playground), refresh
immediately, and persist the resulting access + new refresh token. The
env var can then be cleared — Mongo is the source of truth.

If the seeded refresh token has expired, `refreshAccessToken` throws a
`PermanentError`:
```
QBO token refresh failed: invalid_grant
```
Resolution: re-fetch a fresh refresh token from the OAuth Playground and update the env var.

### 7.3 Invoice creation — `services/qbo/qbo.service.js`

```
POST /v3/company/{realmId}/invoice?minorversion=73
{
  "CustomerRef": { "value": "<qboCustomerId>" },
  "Line": [
    {
      "DetailType": "SalesItemLineDetail",
      "Amount": 23.16,
      "Description": "Wholesale pack",
      "SalesItemLineDetail": {
        "ItemRef": { "value": "<QBO_DEFAULT_ITEM_ID>" },
        "Qty": 4, "UnitPrice": 5.79
      }
    },
    ...
  ],
  "CurrencyRef": { "value": "USD" },
  "CustomerMemo": { "value": "Shopify order #1021" },
  "DocNumber": "1021",
  "DueDate": "2026-06-05",
  "ShipDate": "2026-05-21",
  "ShipAddr": {
    "Line1": "123 Main St",
    "City": "Austin",
    "CountrySubDivisionCode": "TX",
    "PostalCode": "78701",
    "Country": "US"
  }
}
```

Line items mirror Shopify's: per-product line + Shipping line + Tax
line. Every line needs an `Item` reference — `QBO_DEFAULT_ITEM_ID`
(default `"1"`) is used unless `line.qboItemId` is set.

`DueDate` is computed in this app as **order date + per-method terms**,
then sent explicitly to QBO. This makes us the source of truth for terms
and overrides any customer-level `SalesTerm` configured in QBO. The term
length is selected by the invoice's locked `paymentMethod` via
`invoiceConfig.dueDaysForMethod`:

| Payment method | Env var | Default |
|---|---|---|
| Cheque | `CHEQUE_DUE_DATE` | `INVOICE_TERMS_DAYS` (15) |
| ACH | `ACH_DUE_DATE` | `INVOICE_TERMS_DAYS` (15) |
| Card | `CARD_DUE_DATE` | `INVOICE_TERMS_DAYS` (15) |

Each falls back to the generic `INVOICE_TERMS_DAYS` when its var is unset,
so single-terms setups keep working. Example: order June 1 +
`CHEQUE_DUE_DATE=15` → due June 16. The same per-method term feeds the
local full-datetime `Invoice.dueAt` (plus `INVOICE_TERMS_MINUTES`). The
date-only result is sent to QBO by `invoice.utils.computeInvoiceDueDate`;
the returned `DueDate` is captured on the local invoice as `qboDueDate`
("YYYY-MM-DD" string) for display in the Order List + Order Details.

If both `order.created_at` and `localOrder.receivedAt` are unparseable,
we omit `DueDate` from the request and QBO falls back to its own
SalesTerm logic — last-resort safety so a missing date can't break
invoice creation.

`ShipAddr` is derived from the Shopify order using the same
shipping → billing → customer-default fallback chain that the
customer sync uses (`customer.utils.buildProfileFromShopifyOrder`),
so the invoice still ships somewhere on pickup / digital orders that
arrive without a `shipping_address`. The normalized address is
projected to QBO's `PhysicalAddress` shape by `qbo.utils.toQboAddress`,
which `BillAddr` on the customer payload also uses. If no address is
on file at all, `ShipAddr` is omitted from the payload (QBO rejects
empty address objects).

`ShipDate` uses `order.created_at` (falling back to
`localOrder.receivedAt`) formatted to `YYYY-MM-DD` via
`invoice.utils.toYmd`. Shopify's `orders/create` webhook fires before
fulfillment, so there's no real ship timestamp on the order yet — the
order date is the closest meaningful "ship on or after" marker.
Unparseable → omitted (QBO leaves the field blank on the rendered
invoice).

**Per-product Items (SKU column).** QBO sources an invoice's SKU column
from the referenced **`Item.Sku`** — there is no per-line SKU field. So
`createInvoice` resolves each **product** line's SKU to a per-product QBO
**Item** carrying that SKU and sets `line.qboItemId` (which
`qbo.utils.toInvoiceLine` already honors, falling back to
`QBO_DEFAULT_ITEM_ID`). `qbo.service.findOrCreateItemBySku({ sku, name })`
mirrors `findOrCreateCustomer`: cache (`qbo_item_maps`, `sku` unique) →
`findItemBySku` (QL `WHERE Sku=…`) → `createItem` (`POST /item`,
`Type:'Service'`, `Sku`, `IncomeAccountRef` derived once from the default
item via `resolveIncomeAccountRef`, optional `QBO_INCOME_ACCOUNT_ID`
fallback). **Best-effort + graceful** — a null/failed resolution or a line
with no SKU leaves the line on the default item, so invoicing never breaks.
`shopifyLinesToQboLines` carries `sku`+`name` on product lines; shipping /
discount / processing-fee lines have no SKU and stay on the default item.
The SKU is **not** put in the line Description (`formatLineDescription`
returns name + vendor only) — it shows solely in QBO's dedicated SKU column
via the item's `Sku`.

> **Unique Item names (correctness).** QBO Item `Name` must be unique, and
> products that share a display name but differ by SKU would otherwise
> collide — making the second create fail and (wrongly) reuse the first
> item, showing every line the first SKU. So `sanitizeItemName` appends the
> SKU (`"Product (SKU)"`, ≤100 chars) → a distinct item per SKU; the
> duplicate-Name fallback adopts an existing item **only when its `Sku`
> matches**; and the cache stores `qboSku` so a hit is trusted only when
> `qboSku === sku` — rows missing/mismatching it are re-resolved and
> overwritten (self-heals any rows poisoned before this guard).

Forward-only (existing invoices aren't backfilled); the SKU must exist on
the Shopify variant.

**Discount line.** When a Shopify order carries an aggregate
`total_discounts > 0` (coupon / referral), `shopifyLinesToQboLines`
emits a single QBO `DiscountLineDetail` line (`{ kind: 'discount' }` →
`qbo.utils.toInvoiceLine`) so the QBO invoice total reconciles with
Shopify's post-discount `total_price`. Without it the invoice would
over-state by the discount amount. Ordering on the invoice line array:
product lines → discount → shipping → processing fee.

**Tax — summary row, not a line; sourced from Shopify.** Tax is **not**
emitted as a product line. The order's `total_tax` (configured in
**Shopify**, not QBO) is passed to `qbo.service.createInvoice` as
`TxnTaxDetail.TotalTax`, which QBO renders in the invoice's summary
"Tax" row (alongside Subtotal / Discount / Total) instead of in the
Products section. It is **always sent** (even at `$0`) so the customer
sees a tax figure on every invoice. By design **no QBO tax code
(`TxnTaxCodeRef`) is applied** — tax authority lives in Shopify.

> **Rendering caveat.** Whether QBO actually shows the row in its
> template can depend on a tax code being present on the transaction,
> not on `TotalTax` alone: a **non-zero** Shopify tax renders fine, but a
> **$0.00** row may be omitted by QBO. Forcing a $0 row would require a
> company-specific tax code (AST `"NON"`, or a 0%/exempt `TaxCode` id),
> which we deliberately do not wire in. US automated-sales-tax companies
> may also recompute and ignore the override. The app's own Order Details
> totals panels always show the tax line regardless of QBO's rendering.

> **Why only tax (and discount) reach the summary.** QBO renders the
> customer invoice (emailed via `/invoice/{id}/send`, PDF via
> `/invoice/{id}/pdf`); the app only feeds it a `Line[]` array plus a few
> native fields. QBO's summary block has native slots **only** for
> Subtotal, Discount (`DiscountLineDetail`), Tax (`TxnTaxDetail`), and
> Total — there is **no API field for a shipping amount or a custom
> processing-fee surcharge** (confirmed against the QBO Invoice entity:
> `ShipMethodRef` / `ShipDate` / `ShipAddr` are metadata only, with no
> freight/shipping-cost field). So **shipping and the processing fee
> necessarily remain line items** in the Products section; only tax could
> be moved into the summary without switching to an app-rendered invoice.

**Processing-fee line — applied at creation for card / ACH; at
settlement as the fallback.** A `<Method> Processing Fee – <X>%` line is
added to the QBO invoice so the customer sees the full amount up front
on the invoice they're emailed. Per-method rates are configurable:

| Method  | Default rate | Env var |
|---|---|---|
| Credit card | `3%` | `INVOICE_FEE_RATE_CARD` |
| ACH | `1%` | `INVOICE_FEE_RATE_ACH` |
| Cheque | `0%` | `INVOICE_FEE_RATE_CHECK` |

**At creation** (`invoice.service.createInvoiceForOrder`): for a card or
ACH invoice (any non-zero rate), the fee is computed on the order's
post-discount grand total (`order.total_price`) and pushed onto the QBO
`Line` array before the create call, so `TotalAmt` (→ `amountDue`) is
fee-inclusive from the start. The staging fields
(`processingFeeAmount` / `processingFeeRate` / `processingFeeMethod`)
and `processingFeeAppliedAt` are stamped at the same time. A cheque
invoice (0%) gets **no** fee line and leaves `processingFeeAppliedAt`
unset.

**At settlement** (fallback): the table below shows which paths add the
fee for invoices that did **not** get it at creation — the cheque → card
admin override (a cheque invoice with no fee, settled by card, picks up
the 3% card rate) and any legacy invoice created before fee-at-creation.
Because every settlement path guards on `!processingFeeAppliedAt`, a
card / ACH invoice that already carries the fee is never double-charged.

| Settlement path | Fee applied at settlement? |
|---|---|
| CRON auto-charge / **Retry payment** (card or ACH, fee already at creation) | ✗ already on invoice |
| Admin **Charge card on file** (cheque → card fallback) | ✓ card rate |
| Admin **Mark ACH paid** (`kind='ach'`, legacy / no fee yet) | ✓ ACH rate |
| Admin **Mark cheque paid** (`kind='cheque'`) | ✗ (0% by default) |
| Declined / errored card attempt | ✗ (only successful payments write the line) |

**Mechanics.** Both `payment.service.chargeInvoice` (NMI) and
`invoice.service.recordManualPayment` (admin receipts) follow the same
pattern: compute `baseAmount = amountDue - amountPaid`, compute the fee
via `invoice.utils.computeProcessingFee` against the active method, and
stage the result locally (`invoice.processingFeeAmount`,
`processingFeeRate`, `processingFeeMethod`). On approval / receipt the
local `amountDue` is bumped to match `(base + fee)`.
`propagateSuccessfulPayment` then runs **step 0** before
`recordPayment`: GET the current QBO invoice, append the fee line via
`qbo.service.appendInvoiceLines` (sparse update with the fresh
SyncToken), and set `processingFeeAppliedAt`. Only after the line is
on QBO does `recordPayment` fire — otherwise the recorded payment
would exceed the invoice's `TotalAmt` and QBO would carry a customer
credit. If the append fails, scheduler PASS 2 retries both steps
(sweeps `paymentStatus: 'paid'` with `qboPaymentRecorded: false`).

**ACH receipts.** Manual `kind='ach'` receipts inflate the expected
amount by 1%. The admin is responsible for collecting the inflated
total from the customer (they're charged a 1% ACH processing fee on
the invoice, the same as the customer would see for a card payment).
`recordManualPayment` validates the entered amount against the
fee-inflated outstanding balance, then propagation appends the ACH
fee line to QBO before recording the payment.

**Preview / confirmation.** Before settling, admins can call
`POST /api/admin/orders/:id/preview-payment` with `{ method }` to get
the new total breakdown (`{ baseAmount, feeAmount, newTotal, ... }`)
without modifying QBO or the local DB. The admin UI uses this to
show "Original: $100. Card fee: $3. New total: $103." in the
confirmation modal before the actual settle endpoint fires.

**Idempotency.** Repeat runs are safe: a defensive
`findExistingProcessingFeeLine` check on the QBO `Line` array detects
when a prior run already wrote the line (matches any method's
"Processing Fee" description), adopts the SyncToken, and proceeds to
`recordPayment` without double-adding.

### 7.3.1 Payment-preference realignment (open-invoice sync)

When a customer's payment preference changes (card / ACH / check), every
**unpaid/open** invoice is realigned to the new method so its processing
fee and payment terms match. Owned by
`services/invoice/paymentPreference.service.applyPaymentPreferenceToOpenInvoices({ shop, email, newMethod, performedBy, source })`.

**Eligibility.** `paymentStatus ∈ {pending, failed}` AND `amountPaid == 0`
AND `qboCreationStatus:'created'` with a `qboInvoiceId`. Explicitly
**excluded**: `partially_paid` / `paid` (money settled), `in_progress` /
`awaiting_settlement` (a charge is mid-flight), `cancelled`. Re-validated
per-invoice against the freshest state right before mutating.

**Per-invoice steps** (try/catch isolated, mirrors
`replayPendingOrdersForCustomer`):
1. Skip if already on the new method, `amountPaid > 0`, status no longer
   eligible, or `achSyncInProgress`.
2. `base = amountDue − (processingFeeAmount || 0)` (the pre-fee total;
   `amountPaid` is 0 so this is the full base).
3. `newFee = computeProcessingFee({ baseAmount: base, method: newMethod })`
   (null for check / 0%).
4. Recompute due date from `dueDaysForMethod(newMethod)` against
   `qboTxnDate || createdAt` → `qboDueDate` + local `dueAt`.
5. **Rewrite the QBO invoice** via `qbo.service.setInvoiceProcessingFee({
   qboInvoiceId, feeLine, dueDate })` — GET current, strip every
   `/Processing Fee/i` line, append the new fee line (or none → fee
   removed), sparse-POST the full `Line` array + `DueDate` with the
   current `SyncToken`. QBO recomputes `TotalAmt`. The SyncToken is the
   concurrency guard: a racing CRON charge invalidates it and the invoice
   fails this run (isolated, retried on the next change).
6. Persist locally: `paymentMethod`, fee fields (`processingFeeAmount/
   Rate/Method`, `processingFeeAppliedAt` set when fee else null),
   `amountDue = TotalAmt`, `qboSyncToken`, `qboDueDate`, `dueAt`. A
   `failed` invoice resets to `pending` (`attemptCount=0`) so the new
   method's auto-charge resumes.
7. Append an `admin_action` remark recording `from → to` + fee delta + due
   date + who.

**After the loop**, `CustomerMap.paymentMethod` is mirrored to the new
method (so the next order's invoice uses it immediately, not just after the
order-intake re-sync), and one entry is appended to
`WholesaleApplication.paymentMethodHistory[]` —
`{ previousMethod, newMethod, invoiceCount, affectedInvoiceIds, changedAt,
performedBy, source }` — the change-event audit log.

**Triggers.**
- **Customer self-service** — `/api/update-profile` detects a
  `payment.method` change and calls the service **best-effort** (a QBO
  failure never fails the profile save the customer just made); the summary
  rides back in the response. `source:'customer'`, performedBy = email.
- **Admin** — `POST /api/admin/customers/:id/payment-method` `{ method }`
  saves the preference then realigns. `source:'admin'`, performedBy = admin
  session email. Surfaced on the Customer detail page
  (`app.customers.$id.jsx`) as a method selector + "Apply to open invoices"
  button + a payment-method-history table.

**Future orders** already pick up the latest preference — no scheduler
change: `customer.service.ensureCustomerForOrder` re-reads
`wholesale_applications.payment.method` at intake and PASS 1's
`paymentMethod:{ $in:['card','ach'] }` filter adjusts automatically.

**Limitations.** Switching an invoice to ACH sets the method but does not
provision an NMI ACH billing profile; if `CustomerMap.nmiAchBillingId` is
absent the scheduler's ACH charge skips with a reason (existing
`resolveInvoiceVault` behavior). The immutable order-time snapshot
`customerPaymentPreference` is intentionally **not** rewritten — only the
operational `paymentMethod`.

### 7.4 Payment recording

After a successful NMI charge:

```
POST /v3/company/{realmId}/payment?minorversion=73
{
  "CustomerRef": { "value": "<qboCustomerId>" },
  "TotalAmt": 23.16,
  "PaymentRefNum": "<nmi transactionid (truncated to 21 chars)>",
  "Line": [
    {
      "Amount": 23.16,
      "LinkedTxn": [ { "TxnId": "<qboInvoiceId>", "TxnType": "Invoice" } ]
    }
  ]
}
```

This is the call that flips a QBO invoice from "Open" to "Paid".

### 7.5 Sandbox vs production

`QBO_ENVIRONMENT=sandbox|production` auto-selects the base URL from
`QBO_BASE_URLS` in config. Explicit `QBO_API_BASE_URL` override wins if set.

### 7.6 Read-only list helpers — admin QBO section

The QBO admin tabs (Dashboard / Customers / Transactions / Invoices —
see `app/routes/app.qbo.*.jsx`) pull live data via QBO QL `/query`.
These helpers live in `services/qbo/qbo.service.js` and follow the
project rule "no QBO calls outside `services/qbo/`".

**Shared internals:**

```js
runListQuery({ entity, where?, orderBy?, pageSize?, startPosition? })
  // SELECT * FROM <entity> [WHERE ...] [ORDERBY ...]
  //   STARTPOSITION <sp> MAXRESULTS <ps>
  // Returns { entities, startPosition, pageSize, returned, totalCount? }

runCountQuery({ entity, where? })
  // SELECT COUNT(*) FROM <entity> [WHERE ...]
  // Returns the integer total
```

Page size is clamped to `[1, MAX_PAGE_SIZE=200]` (QBO's hard ceiling is
1,000 but smaller pages keep the UI snappy). Default is 50.

**Public helpers (one pair per entity):**

| Function | QBO entity | Default `orderBy` |
|---|---|---|
| `listCustomers({ pageSize?, startPosition?, where?, orderBy? })` | Customer | `DisplayName` |
| `countCustomers({ where? })` | Customer | — |
| `listInvoices({ ... })` | Invoice | `TxnDate DESC` |
| `countInvoices({ where? })` | Invoice | — |
| `listPayments({ ... })` | Payment | `TxnDate DESC` |
| `countPayments({ where? })` | Payment | — |

`where` is a raw QBO QL predicate (no leading WHERE). Callers must
escape embedded values via `escapeQboQuery` — these helpers don't
auto-escape because some callers compose `IN (…)` or `LIKE '%…%'`
clauses.

QBO QL doesn't return a grand total on paginated list responses (only
on `SELECT COUNT(*)` queries), so the admin loaders run the page +
count in parallel via `Promise.all`.

**Composite: `getDashboardSnapshot()`**

Fans out 9 parallel QBO queries (total/active customers, total/paid/
pending/overdue invoice counts, recent payments, recent invoices,
current-month invoices for revenue summary). Each is wrapped in a
local `safe(label, fn)` helper that catches errors and pushes them
onto a returned `errors[]` array — so one failed metric (e.g.
permission error on Payment) degrades to `null` for that field
rather than failing the whole call. The Dashboard route surfaces the
errors array as a warning banner above the metrics grid.

Revenue is computed in-app by summing `TotalAmt` and `(TotalAmt –
Balance)` over the current-month invoice list (QBO QL has no `SUM()`).
Capped at `MAX_PAGE_SIZE` invoices; the response carries a `truncated:
true` flag when the cap is hit so the UI can show "sample capped".

**Voided-invoice gotcha** — QBO's `Balance = '0'` matches BOTH paid AND
voided invoices (voids zero out both `TotalAmt` and `Balance`). The
"Paid invoices" predicate adds `TotalAmt > '0'` to exclude voids; the
Invoices tab's Voided filter chip inverts to `TotalAmt = '0'`.

**No DB caching** — every page render hits QBO live. Pros: always
fresh, no stale-cache invalidation logic. Cons: dashboard renders take
2–5s in practice (Promise.all caps at the slowest single query). The
per-tab "Refresh" button is wired to `useRevalidator().revalidate()`
so admins can re-pull on demand without a navigation.

### 7.7 Customer-facing emails — `services/qbo/qbo.service.js` + `services/invoice/invoice.service.dispatchInvoiceLifecycleEmails`

Customer emails are sent by QBO's own mail infrastructure, not the app.
We hit a single QBO endpoint — the invoice send — and trust QBO to
deliver, render, and stamp `Invoice.EmailStatus = 'EmailSent'` /
`DeliveryInfo` on its side. There is no separate payment-receipt
email channel; the invoice itself is the source of truth and is
re-sent on every payment so the customer's latest copy always
reflects the current balance + payments list.

**QBO endpoint used:**

| Endpoint | Purpose | Notes |
|---|---|---|
| `POST /v3/company/{realmId}/invoice/{id}/send?sendTo={email}` | Initial + re-send of the invoice document | Customer sees the CURRENT invoice — QBO has already recorded any prior payments by the time we re-send, so the balance + payment list update automatically. `sendTo` is always passed explicitly so we don't depend on QBO's stored `Invoice.BillEmail.Address`. |

The endpoint wants `Content-Type: application/octet-stream` on an
empty POST body. Wired through a dedicated `qbo.send(path, query)` in
`qbo.apis.js`; `rawRequest` gained a `contentType` plumb-through so
the special header doesn't leak into normal POSTs.

**Dispatcher: `dispatchInvoiceLifecycleEmails({ invoice, customerMap, event })`**

Single decision point for every customer email. Best-effort — failures
mutate `invoice.lastEmailError` and log, but never throw upward. Email
delivery is decoupled from payment bookkeeping.

| Event | Trigger | Action |
|---|---|---|
| `created` | `createInvoiceForOrder` Phase 4 (after the QBO invoice id is stamped, before the first `.save()`) | Sends initial invoice email if `invoiceEmailSentAt` is null. Stamps the timestamp + records the baseline (`invoiceEmailedStatus`, `invoiceEmailedAmountPaid`). |
| `payment` | `propagateSuccessfulPayment` (just before final `.save()`) | Re-sends the invoice email if **either** `amountPaid > invoiceEmailedAmountPaid` (a new payment was recorded since the last email) **or** `paymentStatus !== invoiceEmailedStatus` (status transitioned). Each partial payment naturally triggers a re-send via the amount check, so the customer sees the new balance after every payment. The status check catches the `pending → partially_paid` and `partially_paid → paid` transitions, plus the case where the creation-time email failed and we never stamped a baseline. |

**Idempotency guards (Invoice doc fields):**

| Field | Role |
|---|---|
| `invoiceEmailSentAt` | First successful invoice-email send. Guards `event='created'`. |
| `invoiceEmailLastSentAt` | Most recent invoice-email send (initial + re-sends). Diagnostic. |
| `invoiceEmailedStatus` | `paymentStatus` snapshot at last (re)send. One of the two trigger inputs for `event='payment'` re-send. |
| `invoiceEmailedAmountPaid` | `amountPaid` snapshot at last (re)send. The amount-grew check (current > emailed) is what catches partial payments that don't change status (e.g. a second partial that still leaves a balance). |
| `lastEmailError` | Most recent QBO `/send` error message (cleared on next success). |

QBO does **not** dedup `/send` calls — calling twice delivers two
emails. Local guards above are the only protection against double-
sends, which is why every email path lives inside this single
dispatcher.

**Audit ledger — `Invoice.emailEvents[]`:**

Distinct from the dedup guards above, `emailEvents[]` is the append-only
history of every `/invoice/<id>/send` attempt — successes AND failures.
One row per attempt. Powers the "Email history" section on the Order
Details page and is the operator-facing audit trail for "did the
customer get the latest invoice?"

| Field | Notes |
|---|---|
| `createdAt` | When the attempt fired. |
| `triggerType` | `'auto'` — fired from the lifecycle dispatcher (create / payment / status / CRON sweep paths). `'manual'` — fired from the admin "Send invoice" button (`api/admin/send-invoice.js`). |
| `triggeredBy` | `'system'` for auto sends; the admin's session email (or shop domain fallback) for manual sends. |
| `source` | `invoice_created` / `payment_recorded` / `status_changed` / `manual_resend` — derived from the same conditions as the human-readable `reasonLabel` in the dispatcher. |
| `recipient` | The `sendTo` we passed to QBO. |
| `status` | `'sent'` (QBO accepted the call) or `'failed'` (any error from `sendInvoiceEmail`). |
| `errorMessage` | Failure detail (undefined on success). |
| `paymentStatusSnapshot` / `amountPaidSnapshot` | Invoice state at send time — so the history reads sensibly even after later payments change the live values. |

Single shared helper `recordEmailEvent(invoice, eventData)` (exported
from `invoice.service.js`) is the only writer. Both the dispatcher
(auto paths) and the admin endpoint (manual path) call it before their
own `.save()` so the ledger and the dedup baseline always persist
atomically in the same Mongo write.

**Flow per payment lifecycle:**

```
Invoice creation
  → createInvoiceForOrder
      → QBO createInvoice (Phase 2)
      → save QBO ids on local row (Phase 3)
      → dispatchInvoiceLifecycleEmails({ event: 'created' })
          → QBO POST /invoice/{id}/send         ✉ invoice (status: pending, balance $100)
      → save() (persists email-tracking fields)

First partial payment ($30 on $100 invoice)
  → chargeInvoice / recordManualPayment
  → propagateSuccessfulPayment
      → QBO recordPayment                       (qboRecordedTotal=$30)
      → status: pending → partially_paid
      → dispatchInvoiceLifecycleEmails({ event: 'payment' })
          → trigger: amountPaid 0→30 + status pending→partially_paid
          → QBO POST /invoice/{id}/send         ✉ invoice (status: partially_paid, balance $70)
      → save()

Second partial payment ($20)
  → propagateSuccessfulPayment
      → QBO recordPayment                       (qboRecordedTotal=$50)
      → status: still partially_paid
      → dispatchInvoiceLifecycleEmails({ event: 'payment' })
          → trigger: amountPaid 30→50 (status unchanged)
          → QBO POST /invoice/{id}/send         ✉ invoice (status: partially_paid, balance $50)
      → save()

Final payment ($50)
  → propagateSuccessfulPayment
      → QBO recordPayment                       (qboRecordedTotal=$100)
      → status: partially_paid → paid
      → dispatchInvoiceLifecycleEmails({ event: 'payment' })
          → trigger: amountPaid 50→100 + status partially_paid→paid
          → QBO POST /invoice/{id}/send         ✉ invoice (status: paid, balance $0)
      → save()
```

CRON PASS 2 sync retries naturally pick up unsent emails — if a prior
`propagate` call failed at the email step, the next sweep sees
`amountPaid > invoiceEmailedAmountPaid` (or a status mismatch) and
re-sends. No separate email-retry queue needed.

---

## 8. NMI integration

### 8.1 API characteristics

NMI's gateway speaks `application/x-www-form-urlencoded` and replies
with `key=value&key=value` strings — **not JSON**. Two endpoints:

- `transact.php` — sale, auth, capture, refund, void, add_customer, update_customer, etc.
- `query.php` — reporting / customer-vault lookup, returns XML

Crucially, NMI splits the API surface by parameter name:

- `type=sale|auth|refund|...` — transactions
- `customer_vault=add_customer|update_customer|...` — vault operations

Sending `type=add_customer` returns `"Invalid Transaction Type"`.

### 8.2 Sandbox vs production hosts

Sandbox accounts are rejected on production hosts and vice versa.
`NMI_ENVIRONMENT` selects the host:

| Environment | API URL | Query URL |
|---|---|---|
| `sandbox` | `https://sandbox.nmi.com/api/transact.php` | `https://sandbox.nmi.com/api/query.php` |
| `production` | `https://secure.nmi.com/api/transact.php` | `https://secure.nmi.com/api/query.php` |

Explicit `NMI_API_URL` / `NMI_QUERY_URL` overrides win if set.

### 8.3 Customer Vault — `services/nmi/nmi.service.js`

Three vault-facing helpers, each owned by a different lifecycle stage:

| Function | Caller | When it runs |
|---|---|---|
| `createCustomerVault({ profile, paymentDetails })` | `app/api/registration-form.js` ONLY | Once per customer, at registration submit, against the Collect.js paymentToken captured by the form. |
| `findCustomerVaultByEmail(email)` | Recovery / diagnostics only — not on the hot path | Substring email match via `query.php?report_type=customer_vault&email=…`. Legacy reconciliation helper. |
| `validateCustomerVault(customerVaultId)` | `customer.service.ensureCustomerForOrder` (on every order intake) and `payment.service.chargeInvoice` (before every NMI sale) | Confirms a stored vault id still resolves in NMI — protects against "vault deleted out-of-band". Returns `{ valid, reason? }`. |

The order-processing pipeline **does not** call `createCustomerVault`.
Vaults are captured exactly once during registration (§6.4) and the
order flow only reads + validates the stored id. This eliminates the
duplicate-vault risk the legacy `findOrCreateCustomerVault` path could
hit when two near-simultaneous orders both saw a missing
`CustomerMap.nmiCustomerVaultId`.

`createCustomerVault` payload (registration only):

```
customer_vault=add_customer
first_name, last_name, company, email, phone
address1, city, state, zip, country
shipping_address1, shipping_city, ...
(one of:)
  ccnumber, ccexp[, cvv]
  payment_token              ← Collect.js / hosted tokenizer (preferred)
  payment=check, checkaba, checkaccount, account_type
```

NMI rejects `add_customer` without a billing address. The
registration form pre-validates the required billing fields client-side
before submit; the order orchestrator additionally pre-validates the
five NMI-required fields (see §6.2) so a missing field produces a
clear local error rather than a generic NMI rejection.

`validateCustomerVault` payload:

```
query.php?report_type=customer_vault&customer_vault_id=<vaultId>
```

A `200` containing `<customer_vault_id>` confirms the vault exists; an
`<error_response>` block, an HTTP error, or a mismatched id resolves to
`{ valid: false, reason }`. Callers MUST NOT proceed to charge on
`valid: false` — `payment.service.chargeInvoice` writes a `skipped`
PaymentAttempt row and bumps `attemptCount` so the operator sees the
follow-up in the Order List remarks.

### 8.4 Sale transaction — `services/nmi/nmi.service.js`

```
type=sale
customer_vault_id=<vaultId>
amount=23.16
currency=USD
orderid=<shopifyOrderId>
order_description=Invoice 1021
```

Response codes:

| `response` | Meaning |
|---|---|
| `1` | approved |
| `2` | declined |
| `3` | error (validation / auth) |

The parsed result includes `transactionId`, `responseCode`, `responseText`,
`authCode`, `avsResponse`, `cvvResponse` — all persisted on the
`payment_attempts` audit row.

### 8.5 Read-only list helpers — admin NMI section

The NMI admin tabs (Dashboard / Customers / Payments / Transactions /
Failed / Refunds — see `app/routes/app.nmi.*.jsx`) pull live data from
NMI's `query.php`. These helpers live in `services/nmi/nmi.service.js`
and follow the project rule "no NMI calls outside `services/nmi/`".

**XML parsing — no parser dependency.** NMI's `query.php` returns XML
(unlike `transact.php`'s key=value form-encoded response). The
response shape is shallow + well-known, so we use a small regex-based
block extractor rather than pulling in `xml2js` / `fast-xml-parser`:

```js
parseNmiTransactions(xml)
  // <nm_response>
  //   <transaction>
  //     <transaction_id>…</transaction_id>
  //     <transaction_type>cc</transaction_type>
  //     <condition>complete</condition>
  //     <action>
  //       <action_type>sale</action_type>
  //       <amount>100.00</amount>
  //       <success>1</success>
  //       <response_text>SUCCESS</response_text>
  //       …
  //     </action>
  //   </transaction>
  // </nm_response>
  //
  // → [{ ...flatFields, actions: [{ ...actionFields }] }, …]

parseNmiCustomerVaults(xml)
  // <customer_vault>
  //   <customer>
  //     <customer_vault_id>…</customer_vault_id>
  //     <first_name>…</first_name>
  //     <cc_number>4xxxxxxxxxxx1111</cc_number>
  //     <created>20260101010000</created>
  //   </customer>
  // </customer_vault>
  //
  // → [{ ...flatFields }, …]
```

The extractor pulls top-level `<transaction>` / `<customer>` blocks
out of the XML, strips nested `<action>` blocks before extracting the
flat fields (so action-level keys don't leak onto the transaction
record), then re-extracts each action's flat fields separately. Lazy
match `[\s\S]*?` is used to bracket each block — fragile if NMI ever
nests the same tag inside itself, but the report XML we consume
doesn't.

`<error_response>…</error_response>` payloads (auth failure, malformed
date range, etc.) resolve to an empty array — callers can detect
"empty response" but won't see the error reason inline. The underlying
`nmiQuery` throws on HTTP errors, which IS surfaced.

**Date format.** NMI uses contiguous `YYYYMMDDhhmmss` on every date
field (filter inputs + `<date>` outputs). `toNmiDate(Date)` /
`fromNmiDate(string)` are pure helpers exported for callers that need
to render the dates locally.

**Public helpers:**

| Function | Wraps | Notes |
|---|---|---|
| `listNmiTransactions({ startDate?, endDate?, condition?, transactionType?, actionType?, result?, customerVaultId?, transactionId?, orderId?, invoiceId? })` | `nmiQuery({ report_type: 'transaction', … })` | Date window defaults to last 30 days when neither bound is supplied. Returns `{ records, startDate, endDate }`. Records are sorted newest-first on the latest action's date. |
| `listNmiCustomerVaults({ email?, customerVaultId? })` | `nmiQuery({ report_type: 'customer_vault', … })` | Returns `{ records }`. No date filter — NMI's vault report carries every active vault entry. Sorted newest-first on `created`. |
| `getNmiDashboardSnapshot({ periodDays = 30 })` | parallel `listNmiTransactions` + `listNmiCustomerVaults` | Per-metric `safe()` wrapping → `null` on failure, surfaced via `errors[]`. Aggregates counts in JS (no SUM/COUNT in NMI QL). |
| `latestAction(tx)` | — | Returns the last action in the lifecycle. By NMI convention actions are oldest-first, so the last one is the current state. |
| `toNmiDate` / `fromNmiDate` | — | Convert between JS `Date` and NMI's `YYYYMMDDhhmmss`. |

**Pagination model.** `query.php` has no STARTPOSITION / MAXRESULTS
equivalent — every matching row in the window comes back in one
response. Loaders use a bounded `start_date` / `end_date` (default
last 30 days) to keep the response size manageable, then paginate the
parsed array client-side at 50 rows/page. For high-volume merchants
this could lag — surface that with a "showing first N of M" message
if it becomes a problem.

**Aggregation rules** (used by `getNmiDashboardSnapshot`):

| Bucket | Rule |
|---|---|
| Successful payments | latest action's `action_type ∈ {sale, capture, credit}` AND `success = '1'` |
| Failed payments | latest action's `success != '1'` AND latest action's `action_type ∉ {refund}` |
| Refund count + total | latest action's `action_type = 'refund'`; total sums successful refund amounts only |
| ACH count | transaction's `transaction_type = 'ck'` |
| Credit card count | transaction's `transaction_type = 'cc'` |
| Payments collected total | sum of `sale + capture` action amounts where `success = '1'` |

`condition='failed'` on the transaction record is also a signal but
we don't double-count — the action-level outcome already covers it.

**No DB caching.** Every page render hits NMI live. Per-tab "Refresh"
buttons call `useRevalidator().revalidate()`. NMI's query.php is
typically faster than QBO's `/query` (single roundtrip, no OAuth
refresh dance), but for 90-day windows on a busy merchant the
parse + sort can dominate render time.

---

## 9. Cheque / ACH payment handling

Each customer carries a preferred payment method on their wholesale
application (`wholesale_applications.payment.method` — one of `check`,
`ach`, `card`). The CRON auto-charges `card` AND `ach`; `check` is
held for manual admin action from the Order Details page.

**ACH vault sourcing** — every customer (card OR ACH) has at most one
NMI customer vault, stored at the top-level
`wholesale_applications.nmiCustomerVaultId`. NMI's vault model allows
multiple BILLING PROFILES inside a single vault; the `billing_id`
selects which one to charge. For ACH-method invoices the CRON passes
BOTH `customer_vault_id` AND `billing_id` to NMI — the billing id is
sourced from `wholesale_applications.payment.ach.nmi_billing_id`. Card-
method invoices omit the billing id and NMI charges the vault's
default billing.

CustomerMap mirrors both fields (`nmiCustomerVaultId` +
`nmiAchBillingId`) at order intake. `payment.service.chargeInvoice`
picks them out via `resolveInvoiceVault` and feeds both to
`nmi.service.chargeCustomerVault({ customerVaultId, billingId, ... })`.
Vault validation (`validateCustomerVault`) runs against the
customer vault id only; the billing id is trusted and any mismatch
surfaces as a precise NMI decline on the next sale (e.g.
`"vault id not present in NMI response"`).

### 9.1 Method propagation

Three distinct payment-method fields live on the Invoice doc, each
covering a different question:

| Field | Set when | Mutable? | Answers |
|---|---|---|---|
| `Invoice.customerPaymentPreference` | invoice creation | Never | "What did the customer prefer when they placed *this* order?" |
| `Invoice.paymentMethod` | invoice creation; flipped by cheque → card admin override | Yes, by `api/admin/charge-card.js` | "What method is currently *active* for this invoice?" (drives CRON eligibility) |
| `Invoice.paymentSettledVia` | each successful payment event | Latest write wins | "What actually *settled* this invoice?" |

Propagation:

```
WholesaleApplication.payment.method                ← end user can edit
  │                                                  via /api/update-profile
  ↓ refreshed on every order intake
services/customer/customer.service.js → ensureCustomerForOrder
  ↓ writes CustomerMap.paymentMethod                 (kept fresh per order)
services/invoice/invoice.service.js → createInvoiceForOrder
  ↓ on Invoice.create:
    • paymentMethod                = customerMap.paymentMethod  (active)
    • customerPaymentPreference    = customerMap.paymentMethod  (immutable snapshot)

services/payment/payment.service.js → chargeInvoice (NMI approval)
  ↓ paymentSettledVia = invoice.paymentMethod === 'ach' ? 'ach' : 'card'

services/invoice/invoice.service.js → recordManualPayment (cheque receipt)
  ↓ paymentSettledVia = kind === 'ach' ? 'ach' : 'check'
```

The snapshot field gives historical stability: when a customer updates
their preferred method, only *new* invoices pick up the new value via
the `customer.service.js` refresh. Existing invoices continue to show
the original preference forever, because `customerPaymentPreference`
is never mutated after invoice creation.

Legacy invoices that pre-date `customerPaymentPreference` /
`paymentSettledVia` use `paymentMethod` as a display fallback — the
values were equivalent before the cheque → card override existed.

Unknown / missing values default to `card`. This preserves the legacy
auto-charge behavior for customers that pre-date this feature.

**Spelling tolerance** — `normalizePaymentMethod` in
`customer.service.js` accepts either `check` or `cheque` (case
insensitive, trimmed) and folds both to canonical `check`. The
mark-cheque-paid endpoint applies the same tolerance to the inbound
`kind` field. Canonical values are: `card`, `check`, `ach` on the
Invoice fields; `cheque`, `ach` on the manualPayments ledger.

### 9.2 Scheduler gating

PASS 1 of `process-pending-payments` filters by
`paymentMethod: { $in: ['card', 'ach'] }` **and**
`autoChargePaused: { $ne: true }`:

```js
Invoice.find({
  paymentStatus: 'pending',
  paymentMethod: { $in: ['card', 'ach'] },
  autoChargePaused: { $ne: true },
  $expr: { $lt: ['$attemptCount', '$maxAttempts'] },
})
```

Both card and ACH invoices flow through the same charge path —
`payment.service.chargeInvoice` calls `resolveInvoiceVault()`
internally to pick the right NMI ids by `invoice.paymentMethod`:

- Card → `{ vaultId: customerMap.nmiCustomerVaultId, billingId: null }`
- ACH → `{ vaultId: customerMap.nmiCustomerVaultId, billingId: customerMap.nmiAchBillingId }`

The vault id is the SAME on both sides — every customer has at most
one vault. The `billing_id` (ACH only) targets a specific billing
profile inside the vault so NMI can route to the ACH entry rather
than the default-billing card entry. `nmi.service.chargeCustomerVault`
accepts both and threads them into transact.php's `customer_vault_id`
+ optional `billing_id` parameters.

PASS 1.5 (payment follow-up logger) runs only over invoices whose
`paymentStatus` is `'failed'` (card/ACH that exhausted retries). It logs
a `cron_failed_followup` remark as part of this CRON's payment audit
history — no charge, no customer notification.

**Cheque reminders are NOT logged here.** Customer-facing payment
reminders for unpaid cheque invoices are owned exclusively by the
dedicated reminder CRON (`process-check-reminders` / services/reminder —
§10.5), which sends the QBO ladder + recurring emails. This payment CRON
is responsible only for charging, status updates, and payment/audit
logs; keeping the concerns separate is what prevents the duplicate
reminder entries that used to appear when PASS 1.5 also logged a
`cron_cheque_reminder` every tick. The legacy `cron_cheque_reminder` /
`cron_ach_reminder` remark kinds are preserved on the Invoice schema for
back-compat with rows logged before this change; PASS 1.5 no longer
emits them. New ACH activity lands as `cron_ach_attempt` (success /
decline / error) in PASS 1.

PASS 1.5 also carries the same `autoChargePaused: { $ne: true }` term —
pausing is an explicit "leave this one alone" signal.

`$ne: true` (not `false`) is deliberate so legacy rows without the field
default to "not paused".

Cheque invoices sit on `pending` indefinitely until an admin acts.
PASS 2 (downstream sync retry) is NOT gated by method or by the pause
flag — once an invoice has money on it (paid / partially_paid), any
failed QBO/Shopify sync is replayed regardless of how the invoice was
paid or whether new charges are currently paused. That's intentional:
sync retry never starts new charges, it only reconciles money that
already landed.

The same gate applies to the immediate-charge path in
`order.service.processShopifyOrder`: even with
`PAYMENT_CHARGE_IMMEDIATELY=true`, only `card` invoices fire the inline
NMI sale. The pause flag does not affect immediate-charge today (a new
order can't be paused before it exists), but the same `autoChargePaused`
condition should be added if that path ever loops over existing invoices.

#### 9.2.1 Per-invoice auto-charge pause control

Card-preferred invoices can be individually excluded from PASS 1 without
affecting any other invoice, the customer's broader preference, or the
stored NMI vault.

**Storage** — six fields on the Invoice doc:

| Field | Type | Notes |
|---|---|---|
| `autoChargePaused` | Boolean (indexed) | the CRON filter looks at this |
| `autoChargePausedAt` | Date | most recent pause timestamp |
| `autoChargePausedBy` | String | session email of the admin who paused |
| `autoChargePauseNote` | String | optional pause reason (admin-supplied, max 500 chars) |
| `autoChargeResumeAt` | Date | most recent resume timestamp (NOT a scheduled future-resume date) |
| `autoChargeResumedBy` | String | session email of the admin who resumed |

The previous pause-side fields (`autoChargePausedAt` / `By` /
`PauseNote`) are deliberately preserved after a resume — they remain
useful as the "last paused" audit trail. A subsequent pause overwrites
them.

**Endpoints** — both are admin-authenticated, both accept an optional
JSON `{ note }` body that is mirrored into `Invoice.remarks[]`
(`kind: 'admin_action'`, `source: 'admin'`):

```
POST /api/admin/orders/:id/pause-auto-charge
  → app/api/admin/pause-auto-charge.js
    - guards: customerPaymentPreference === 'card',
      paymentStatus ∉ {paid, cancelled}
    - sets autoChargePaused=true + timestamps + admin email
    - appends "Auto-charge paused by <admin> [— note]" remark
  → returns { autoChargePaused, autoChargePausedAt, autoChargePausedBy,
              autoChargePauseNote, reapplied }

POST /api/admin/orders/:id/resume-auto-charge
  → app/api/admin/resume-auto-charge.js
    - sets autoChargePaused=false + resume timestamps + admin email
    - appends "Auto-charge resumed by <admin> [— note]" remark
  → returns { autoChargePaused, autoChargeResumeAt, autoChargeResumedBy,
              wasAlreadyRunning }
```

**Gating** — the feature is restricted to invoices whose
`customerPaymentPreference === 'card'` (the immutable order-time
snapshot, NOT the mutable `paymentMethod` that the cheque → card
fallback can flip). Reasoning: pausing a cheque/ACH invoice would be a
silent no-op (PASS 1 already skips it by method), so the UI hides the
control there. The server re-checks the same condition so an
out-of-band POST cannot pause a non-card invoice.

**Resume is NOT a charge** — clearing the pause flag just unblocks the
next CRON tick. Admins who want to charge immediately keep using the
existing Retry payment / Charge card on file actions.

**Idempotence** —
- re-pausing an already-paused invoice refreshes the timestamps + admin
  identity and appends a "pause refreshed" remark
- resuming an invoice that wasn't paused records a "resume confirmation
  (was already running)" remark — lets ops confirm intended state
  without first verifying live state

**Manual settlement remains available while paused** — the pause flag
only blocks the CRON. Retry payment, Mark cheque paid, and Charge card
on file are deliberate admin actions and never consult
`autoChargePaused`. The Order Details page surfaces a warning banner +
status badge so admins know the auto-side is paused before they take a
manual action.

### 9.3 Manual cheque receipt — admin "Mark cheque paid"

```
POST /api/admin/orders/:id/mark-cheque-paid
  body: { reference, amount?, receivedAt?, kind?='cheque'|'ach', note? }
  → app/api/admin/mark-cheque-paid.js
    → services/invoice/invoice.service.recordManualPayment
        - validates: paymentStatus ∈ {pending, failed},
          paymentMethod ≠ 'card', reference present, amount > 0,
          amount ≤ outstanding
        - appends Invoice.manualPayments[] entry
        - creates PaymentAttempt { outcome: 'manual_paid' }
        - bumps amountPaid, sets paidAt, transitions paymentStatus
          to 'paid' (or stays 'pending' on partial)
        - propagateSuccessfulPayment with paymentRef=`cheque:<ref>`
          (records QBO payment, marks Shopify order paid, updates
          shopify_orders mirror)
  → returns { paymentStatus, amountPaid, amountDue, paidAt,
              reference, kind, syncErrors }
```

The cheque reference is stored on the manualPayments entry AND forwarded
to QBO as the `paymentRef`. On the Shopify side, `markShopifyOrderPaid`
is idempotent so retries are safe.

### 9.4 Cheque → card fallback — admin "Charge card on file"

```
POST /api/admin/orders/:id/charge-card
  → app/api/admin/charge-card.js
    - guards: order in shop, invoice exists,
      paymentStatus ∈ {pending, failed}, vault id present
    - flips Invoice.paymentMethod → 'card' (per-invoice override only,
      CustomerMap.paymentMethod stays 'check'/'ach')
    - same maxAttempts++ / failed→pending unblock as retry-payment
    - calls chargeInvoice() against the NMI vault
  → returns { ...chargeResult, originalMethod, newMethod: 'card' }
```

After this flip, the scheduler will also pick this invoice up on
subsequent ticks if the admin attempt declines (because PASS 1 now
matches). The next order for the same customer still defaults to the
original cheque/ACH preference.

### 9.5 ACH transport + auto-charge

NMI supports ACH/echeck through the same vault add_customer / sale API.
When the vault was created with `paymentDetails.achAccount`,
`createCustomerVault` sends:

```
payment=check
checkname=<full name>
checkaba=<routing>
checkaccount=<account number>
account_type=checking
```

ACH invoices ARE auto-charged by the CRON billing pass (PASS 1). Each
customer has one NMI customer vault (top-level
`wholesale_applications.nmiCustomerVaultId`); when the customer has an
ACH billing profile attached to that vault, its id is stored at
`wholesale_applications.payment.ach.nmi_billing_id`. The cache mirror
lives on CustomerMap as `nmiCustomerVaultId` + `nmiAchBillingId`. PASS
1's per-invoice charge path (`payment.service.chargeInvoice →
resolveInvoiceVault`) reads BOTH ids whenever
`invoice.paymentMethod === 'ach'` (the vault is the same one the card
charge uses; the billing id is the discriminator), runs the standard
`validateCustomerVault` pre-flight against the customer vault, and
dispatches `nmi.service.chargeCustomerVault({ customerVaultId,
billingId, ... })` so transact.php targets the ACH billing entry.

**Failure handling** — ACH declines are recorded the same way as card
declines:
- a `PaymentAttempt` row with `outcome: 'declined'` or `'error'`,
  including the NMI `responsetext` / `responsecode`
- the invoice's `attemptCount` increments; on reaching `maxAttempts`
  the status flips to `'failed'`
- PASS 1 logs a `cron_ach_attempt` remark (success or decline) each
  tick; PASS 1.5 logs `cron_failed_followup` once the invoice exhausts
  retries

Once an ACH invoice is failed (or anytime before), an admin can fall
back to the card-on-file via the existing `POST /api/admin/orders/:id/charge-card`
flow — this is the "Charge card on file" button on the Order Details
page. The handler flips `Invoice.paymentMethod` to `'card'`,
unblocks `maxAttempts` if needed, and runs `chargeInvoice` against
the customer's card vault (`CustomerMap.nmiCustomerVaultId`). The
ACH billing id is left untouched, so subsequent orders for the same
customer keep ACH as the default. If the customer has no card vault
on file, the handler rejects with HTTP 409 — admins capture a card
out-of-band before the fallback becomes available.

ACH-method invoices can also be retried via `POST /api/admin/orders/:id/retry-payment`
(the "Retry ACH payment" button, distinct from "Retry payment" on
card invoices). The endpoint routes to the ACH billing id via
`resolveCustomerAchBillingId` and otherwise behaves identically to
the card retry path.

### 9.5.1 ACH settlement lifecycle (`awaiting_settlement`)

ACH sales are **two-phase** at the gateway:

1. **Submission** — NMI's `transact.php` returns response code 100
   ("Approved") when the transaction is accepted into the ACH network.
   This is NOT a confirmation that funds have moved — at this point
   NMI reports the transaction's `condition` as `pendingsettlement`.
2. **Settlement** — 1–3 business days later, the ACH network either
   settles the debit (`condition='complete'`) or returns it (NSF,
   closed account, frozen funds, etc. → `condition='failed'` or
   `'canceled'`).

To represent this correctly the Invoice has a dedicated payment status
`'awaiting_settlement'` and a small set of in-flight fields:

| Field | Notes |
|---|---|
| `pendingSettlementTxnId` | NMI transaction id we're waiting on; indexed |
| `pendingSettlementAmount` | Total amount submitted (base + fee component, if any) |
| `pendingSettlementFeeAmount` | Fee component staged at submission; applied to QBO only on settle |
| `pendingSettlementSince` | When we entered the awaiting_settlement state |
| `pendingSettlementLastCheckedAt` | When the ACH status-sync CRON last polled NMI (throttles the "still pending" remark) |

**Critical invariant** — `amountPaid` is NOT bumped on ACH approval.
The in-flight amount lives on `pendingSettlementAmount` until
settlement is confirmed. Downstream sync (QBO `recordPayment`,
Shopify mark-paid / SALE transaction) does NOT run until settlement
is confirmed. This avoids the failure mode where an ACH return would
otherwise leave QBO + Shopify falsely showing the invoice as paid.

The `awaiting_settlement` status is **sticky** in
`deriveInvoicePaymentStatus` (`invoice.utils.js`) — the same way
`cancelled` is — so a stray `applyDerivedPaymentStatus` call on an
invoice with `amountPaid = 0` cannot mis-flip it back to `pending` and
have the CRON re-submit a second ACH transaction while NMI is still
processing the first.

**Reconciliation runs in a dedicated CRON.** A separate, independent job
— `process-ach-status-sync` (`services/payment/achStatusSync.service.js`)
— polls NMI for every `awaiting_settlement` ACH invoice and reconciles its
status. Its cadence is **environment-configurable** with no code change:
production runs once per day (`ACH_SYNC_CRON`, default `0 3 * * *`), while
testing runs every minute (`ACH_SYNC_INTERVAL`, e.g. `1 minute`) for rapid
validation of status updates and reconciliation. When `ACH_SYNC_INTERVAL`
is set it takes precedence over the cron; leave it unset in production. This is intentionally **separate from the payment-processing CRON**
(`process-pending-payments`, which only charges) so there is a single owner
of the `awaiting_settlement → paid/pending/failed` transition (no race) and
so settlement is polled frequently rather than only on the twice-monthly
charge ticks. *(Historically this was "PASS 1.7" inside the payment CRON;
it was extracted into its own job.)*

**State transitions** are owned exclusively by `checkAchSettlement`
(`payment.service.js`), which the ACH status-sync CRON calls for each
in-flight invoice:

| NMI `condition` | Action | Result |
|---|---|---|
| `complete` | Apply `pendingSettlementAmount` → `amountPaid`, stage fee → QBO, run `propagateSuccessfulPayment`, clear pending fields, set `paymentSettledVia='ach'` + `paidAt`, re-derive status | `paid` (or `partially_paid` on partial) |
| `failed` / `canceled` | Drop the in-flight credit, write a new `PaymentAttempt` with `outcome='declined'` or `'error'`, bump `attemptCount`, clear pending fields, log `lastAttemptError` | `pending` (next CRON tick will retry ACH), or `failed` if `attemptCount >= maxAttempts` |
| `pendingsettlement` / `pending` / `in_progress` | No state change | stays `awaiting_settlement` |
| unknown / lookup failure | No state change | stays `awaiting_settlement`; remark logs the lookup error |

**Admin endpoints** check the state explicitly:

- `POST /api/admin/orders/:id/retry-payment` — 409 with a message
  pointing the admin at the in-flight transaction. Retrying would
  either duplicate the debit (if the first settles) or burn an attempt
  on a transaction NMI hasn't decided on yet.
- `POST /api/admin/orders/:id/charge-card` — 409 with a message
  suggesting the admin void the ACH in NMI's dashboard first. We
  block the card fallback to avoid double-charging the customer if
  both transactions settle.
- `POST /api/admin/orders/:id/sync-ach-status` — **on-demand sync**
  (see below). Runs the same reconciliation as the CRON for this one
  invoice so an admin doesn't have to wait for the next scheduled tick.

**On-demand sync — "Sync ACH status" button.** The per-invoice
reconciliation body is factored into `reconcileAchInvoice`
(`services/payment/achStatusSync.service.js`), shared verbatim by the
CRON sweep (`syncAchTransactionStatuses`) and the admin button so both
do exactly the same thing — NMI lookup → `checkAchSettlement` → audit
row + remark + critical-alert + "last sync" display fields. The button
is rendered on Order Details **only for ACH invoices in
`awaiting_settlement` with a `pendingSettlementTxnId`** (the exact set
the CRON sweeps); for any other invoice the endpoint returns 409. The
service entry point `manualSyncAchInvoice` takes an **atomic per-invoice
lock** (`Invoice.findOneAndUpdate({ achSyncInProgress: { $ne: true } },
{ $set: { achSyncInProgress: true } })`) before reconciling and releases
it in a `finally` block, so a double-click — or an overlapping CRON tick
— can never reconcile the same invoice twice at once (a blocked request
gets a 409 "already in progress"). Every sync (CRON or manual, any
outcome incl. still-pending) records the display fields `achSyncLastAt`
/ `achSyncLastStatus` (normalized: settled / returned / voided / failed /
pending_settlement / unknown / error) / `achSyncLastCondition` (raw NMI
condition) / `achSyncLastSource` (`cron_ach_status_sync` |
`admin_manual_sync`); a manual run also stamps `achSyncLastBy` (admin
email). Order Details surfaces these as "Last ACH sync: <time> · <status
badge> · via manual/scheduled sync". The manual remark text reads
"Manual ACH status sync — …" (source `admin`) vs the CRON's "ACH status
sync — …" (source `cron`); both reuse the `cron_ach_settlement_check`
remark kind so the badge map is unchanged. A manual sync bypasses the
once-per-day "still settling" remark throttle (the admin explicitly
asked for an update).

**Remarks** are written by the ACH status-sync CRON with kind
`cron_ach_settlement_check`:

- "settled" / "returned" log on every state change.
- "still pending" logs at most once per `STILL_PENDING_REMARK_THROTTLE_MS`
  (24h) so the Remarks panel doesn't flood during the normal wait
  window. The settlement check itself runs every tick — only the
  remark write is throttled.

**Audit trail + return capture.** On every detected status CHANGE the
sync CRON appends an `Invoice.achStatusHistory[]` entry (`status`,
`previousStatus`, `nmiCondition`, `nmiTransactionId`, `returnCode`,
`returnReason`, `amount`) — idempotent, since a no-change poll writes
nothing. On a return/void it also persists the NACHA detail on the
invoice itself (`achReturnCode`, `achReturnReason`, `achReturnedAt`) and
raises a **critical admin alert** (`log.error('ach.alert', …)` + console
banner, plus an optional outbound webhook when `ACH_ALERT_WEBHOOK_URL`
is configured). A transaction still awaiting settlement past
`ACH_SYNC_STUCK_DAYS` (default 5) raises a throttled "stuck" alert.

### 9.6 Immediate Payment — self-pay link

A 4th payment method, **`immediate`**, for customers who pay each invoice
themselves, on demand, for the exact amount — no stored vault, never
auto-charged. The QBO invoice they receive carries a clickable **payment
link** leading to an in-app Collect.js page pre-set to the current outstanding
balance. (Link only — the QR code was removed per request 2026-06-09.)

**Durable in-app link.** The link baked into the invoice is **our** URL —
`/pay/:token`. The base is `PAY_LINK_BASE_URL` (falls back to
`SHOPIFY_APP_URL`) and **must be a stable public host**: the URL is frozen
into the QBO invoice `CustomerMemo` at creation, so if the base changes the
old links die. In production `SHOPIFY_APP_URL` is stable; in dev,
`shopify app dev` rotates the trycloudflare tunnel each restart, so set
`PAY_LINK_BASE_URL` to a stable tunnel/domain. The opaque token (and the
`/pay/<token>` path) never changes — only the host — so an admin can heal an
already-issued invoice with **"Refresh link on invoice"** on Order Details
(`POST /api/admin/orders/:id/refresh-pay-link` → `refreshImmediatePayLink`,
which rewrites the memo's `Pay online:` line to the current URL). The Order
Details "Payment link" section also rebuilds a live link from the token + the
current base, so admins always see/copy a working link.

**Token.** `Invoice.payToken` is an opaque 256-bit random string
(`payLink.utils.mintPayToken`). It carries **no amount** — the outstanding
balance is always recomputed server-side (`amountDue − amountPaid`), which
defeats amount tampering; the random space defeats enumeration. Minted in
`createInvoiceForOrder` for `immediate` invoices (and retro-provisioned by
`paymentPreference.service` when an open invoice is realigned to
`immediate`).

**On the QBO invoice.** The pay URL is appended to the `CustomerMemo` as a
bare `Pay your invoice online:` label followed by the URL **alone on its own
line** (QBO has no inline-image/button API; a bare URL auto-linkifies in the
emailed invoice / PDF). Done in `createInvoiceForOrder` **before** the Phase-4
`/send` so the first email already carries the link.

**Guaranteeing a complete, un-truncated URL.** Two defects could previously
emit an incomplete/invalid link, independent of the host:

1. `buildPayLinkUrl` returned a host-less `/pay/<token>` when the base URL was
   empty/misconfigured — a structurally invalid (relative) link. It now
   **throws** unless the base is a complete absolute `http(s)://host`, so a
   broken base fails loudly at issue time instead of baking a dead link into a
   QBO memo for days. Display callers (Order Details loader) guard with
   try/catch and surface the misconfig in a banner; the admin
   `refresh-pay-link` endpoint returns the error as a 502.
2. `setInvoicePayLinkMemo` built `base + payLinkBlock` then sliced the whole
   string to QBO's 1000-char cap — truncating **from the end**, i.e. chopping
   the pay URL itself when the base memo was long. Both the creation and
   refresh paths now share `payLink.utils.appendPayLinkToMemo`, which trims the
   **base memo** to fit the cap and always appends the pay-link block (label +
   complete URL) intact.

The token itself is hyphen-free **base62** (`mintPayToken`), so the token can
never be split by a linkifier that breaks on `-`/`_`. The remaining truncation
risk is purely cosmetic line-wrapping of a long **host** (a dev trycloudflare
tunnel like `maintains-talked-cardiac-improved.trycloudflare.com` wraps and
breaks at its hostname hyphens in the PDF) — solved operationally by setting
`PAY_LINK_BASE_URL` to a short, stable, hyphen-free production host. The "URL
alone on its own line" memo layout minimises this.

**Payment flow (NMI Collect.js — single page):**

```
QBO invoice (Pay online: link)  →  GET /pay/:token  (api/pay/pay.jsx)
   guard paid/cancelled/outstanding≤0 → friendly page (no form)
   else: render NMI Collect.js card form (iframe fields) + "Pay $X"
customer enters card → CollectJS tokenizes (card never hits our server)
   → POST /pay/:token { paymentToken }  (same route's action)
       amount = outstanding (recomputed SERVER-SIDE, client amount ignored)
       chargeWithPaymentToken({ paymentToken, amount })  → NMI type=sale
       approved → settleHostedPayment(...)  → 'paid'
                → propagateSuccessfulPayment (QBO Payment + Shopify mark-paid)
       declined/error → inline error, customer can re-enter card
```

Collect.js (NMI-hosted iframe fields) keeps card data off our servers
(PCI SAQ A-EP) — the same mechanism the registration form uses to vault
cards. The page loads `NMI_COLLECT_JS_URL` with `NMI_PUBLIC_KEY` as the
publishable tokenization key. *(An earlier attempt used the NMI 3-Step
Redirect API; its `form-url` is a POST target for your own card form, not a
hosted UI to redirect to, so a plain browser redirect produced "ccnumber
field is required" on completion — hence the Collect.js approach.)*

Settlement is **idempotent**: `settleHostedPayment` atomically claims the NMI
transaction id into `Invoice.payTransactionIds[]` (`$addToSet` guarded), so a
resubmit settles exactly once; the amount is clamped to the outstanding
balance so it can never overpay. A captured-but-unrecorded edge (NMI charged,
bookkeeping then failed) still shows the customer success and is logged for
reconciliation — we never tell a paying customer it failed.

**Fee + due date.** `immediate` is a card-based hosted charge, so it carries
the card-style fee `INVOICE_FEE_RATE_IMMEDIATE` (default 3%), baked into
`amountDue` at creation exactly like card — the hosted charge therefore
collects the full fee-inclusive amount. Due window: `IMMEDIATE_DUE_DATE`.

**Scheduler.** No CRON change: PASS 1 auto-charge filters
`paymentMethod ∈ {card, ach}` and the reminder CRON is cheque-only, so
`immediate` invoices are auto-excluded from every sweep.

**Admin.** Order Details renders a "Payment link" section (clickable link +
copy button + **"Refresh link on invoice"** + payment-status badge).
The preference is set via admin `POST /api/admin/customers/:id/payment-method`
(`normalizePaymentMethod` + the model enums already accept `immediate`); the
**registration-form UI for choosing Immediate Payment is intentionally out of
scope here** and handled separately.

**Config.** `NMI_COLLECT_JS_URL` (Collect.js script; per-environment default,
overridable) + `NMI_PUBLIC_KEY` (publishable tokenization key, already
configured for the registration form) + `PAY_LINK_BASE_URL` (stable link base;
falls back to `SHOPIFY_APP_URL`). The one-time charge runs through
`nmi.service.chargeWithPaymentToken` (`type=sale` + `payment_token`). Files:
`services/payment/payLink.{utils,service}.js`, `app/api/pay/pay.jsx`,
`app/api/admin/refresh-pay-link.js`, `app/components/pay-ui.jsx`.

---

## 10. Scheduler & cron workflow

### 10.1 Engine

Agenda 5 (MongoDB-backed). Single shared connection via the same
`MONGODB_URI`. Job state in `agenda_jobs` collection.

```js
new Agenda({
  db: { address: MONGODB_URI, collection: 'agenda_jobs' },
  processEvery: '5 seconds' | '1 minute',   // tighter when retryIntervalOverride is set
  maxConcurrency: 5,
  defaultConcurrency: 2,
  defaultLockLifetime: 10 * 60 * 1000,
})
```

### 10.2 Lifecycle

- `entry.server.jsx` calls `getAgenda()` once at server boot.
- `getAgenda()` is a coalescing singleton — concurrent first calls all await the same `startPromise`.
- On boot the scheduler cancels any stale `process-pending-payments` registration and re-registers based on current env.
- `agenda.every(interval|cron, jobName, data, opts)` is idempotent on `(interval, name)` so re-runs don't double-register.

### 10.3 Cron expressions

Defaults (production):

```
PAYMENT_RETRY_CRON_PRIMARY=30 0 15 * *    # 00:30 on the 15th
PAYMENT_RETRY_CRON_SECONDARY=30 0 L * *   # 00:30 on the last day
PAYMENT_SCHEDULE_TZ=America/Los_Angeles
```

Dev override (replaces both crons):

```
PAYMENT_RETRY_INTERVAL=30 seconds         # Agenda "every" expression
```

### 10.4 Boot behaviour

```
[scheduler] DEV MODE — process-pending-payments running every 30 seconds
```

or in prod:

```
{scope:"scheduler","event":"scheduler.recurring_registered","mode":"cron","primary":"30 0 15 * *","secondary":"30 0 L * *","timezone":"America/Los_Angeles"}
```

### 10.5 Check-payment reminder CRON (notification-only)

A **separate job** — `process-check-reminders` — distinct from the
payment-retry ticks. It only *notifies*; it never charges. Registered in
`scheduler.service.ensureRecurring` (dev + prod) alongside the retry job.
Cadence is the daily cron in production, or a fast `REMINDER_INTERVAL`
sweep in dev/test (currently every minute).

```
REMINDER_CRON=0 2 * * *        # default: 02:00 daily (scheduler timezone)
REMINDER_INTERVAL=1 minute     # dev/test override (Agenda "every" expression)
REMINDER_USE_MINUTES=true      # TEST knob: use the MINUTE ladder, count minutes
# Production (day) ladder — defaults:
REMINDER_DAY_FIRST=9  REMINDER_DAY_SECOND=11  REMINDER_DAY_CARD=13
# Testing (minute) ladder — defaults, live only when REMINDER_USE_MINUTES=true:
REMINDER_MIN_FIRST=1  REMINDER_MIN_SECOND=3   REMINDER_MIN_CARD=4
# Recurring cadence AFTER the final stage (repeats until paid):
REMINDER_REPEAT_DAYS=2  REMINDER_REPEAT_MINUTES=1
```

**Code:** `services/reminder/reminder.service.js`
(`processCheckPaymentReminders()`) + `reminder.config.js`; thin Agenda
wrapper `services/scheduler/jobs/processCheckReminders.job.js`.

**Eligibility filter** (the only invoices it touches):

```js
{ paymentMethod: 'check',
  paymentStatus: { $in: ['pending', 'partially_paid'] },
  qboCreationStatus: 'created',
  qboInvoiceId: { $exists: true, $ne: null },
  reminderPaused: { $ne: true } }
```

Once an invoice is paid it drops out of the `paymentStatus` set, so
reminders stop automatically. `reminderPaused` is the admin mute switch
(see "Pause control" below) — distinct from `autoChargePaused`, which
gates the card auto-charge sweep, not email reminders.

**Reminder ladder** (elapsed measured from `qboTxnDate`, fallback
`createdAt`; the active threshold column is chosen by `REMINDER_USE_MINUTES`):

| Stage | Prod threshold | Test threshold | Meaning |
|---|---|---|---|
| `first`  | 9 days  | 1 min | First payment reminder |
| `second` | 11 days | 3 min | Second payment reminder |
| `card`   | 13 days | 4 min | Final card-on-file notice (balance may be charged to card on file — admin does the charge) |
| `recurring` | every 2 days *after* `card` | every 1 min *after* `card` | Repeats until paid — keeps reminding the customer the balance is still outstanding |

Prod thresholds are env-tunable (`REMINDER_DAY_FIRST/SECOND/CARD`); the
test ladder via `REMINDER_MIN_FIRST/SECOND/CARD`; the recurring cadence
via `REMINDER_REPEAT_DAYS` (prod, default 2) / `REMINDER_REPEAT_MINUTES`
(test, default 1).

Stage keys are semantic (`first` / `second` / `card` / `recurring`),
independent of the threshold value, so the same keys dedup correctly
whether the day or minute ladder is live. (Legacy `day7` / `day9` /
`day13` keys remain in the `paymentReminders[].stage` enum only for
back-compat with old rows.)

"Current level wins": each run sends only the highest-threshold named
stage reached **and not yet sent**, so a CRON outage jumps straight to
the most advanced reminder instead of replaying earlier ones. Each named
stage fires at most once, in order.

**Recurring phase:** once the final (`card`) stage has been sent and the
invoice is still unpaid, the job keeps sending the `recurring` reminder,
throttled to `recurringIntervalUnits()` (the `REMINDER_REPEAT_*` cadence)
since the most recent reminder of any stage. This is independent of how
often the CRON ticks — a daily cron with `REMINDER_REPEAT_DAYS=2` emails
every other day; the every-minute test sweep with
`REMINDER_REPEAT_MINUTES=1` emails each minute. `recurring` entries
accumulate in `paymentReminders[]` (one per cycle) as the audit trail.
Because a paid invoice leaves the eligibility filter, the recurring
reminders stop automatically the moment the balance is settled.

**Email:** triggers the QBO invoice email via
`qbo.service.sendInvoiceEmail({ qboInvoiceId, sendTo: invoice.customerEmail })`
(`POST /invoice/<id>/send`). QBO delivers the standard invoice email; the
stage governs *our* logging/intent, not the email body.

**Dedup + audit:**
- `Invoice.paymentReminders[]` — one entry per stage (`{ stage, sentAt,
  daysSinceOrder, recipient, status: 'sent'|'failed', qboEmailStatus,
  errorMessage }`). Only a `sent` entry suppresses a stage; a `failed`
  entry is retried on the next run.
- `Invoice.emailEvents[]` — append a row with `source: 'payment_reminder'`
  (surfaces in the Order Details "Email history" panel).
- `Invoice.remarks[]` — append `kind: 'cron_payment_reminder'`
  (operator timeline; distinct from the legacy log-only PASS 1.5
  `cron_cheque_reminder`).

**Pause control** (admin mute switch): the Order Details page exposes a
**Pause / Resume auto email notifications** button (cheque invoices only),
backed by `POST /api/admin/orders/:id/pause-reminders` +
`/resume-reminders`. Pausing sets `Invoice.reminderPaused = true` (+
`reminderPausedAt/By`, `reminderPauseNote`); the eligibility filter's
`reminderPaused: { $ne: true }` clause then skips the invoice on every
run until an admin resumes (`reminderResumeAt/By`). Both endpoints append
an `admin_action` remark and are idempotent. This is independent of the
auto-charge pause (`autoChargePaused`) — different flag, different sweep.

**Guarantees:** never processes payments / charges methods; only Check
invoices; idempotent per stage; safe to re-run; paid or paused invoices
are skipped.

---

## 11. Payment retry mechanism

`scheduler/jobs/processPendingPayments.job.server.js` runs **two passes** per tick.

### 11.1 PASS 1 — charge pending invoices

```js
Invoice.find({
  paymentStatus: 'pending',
  paymentMethod: 'card',
  $expr: { $lt: ['$attemptCount', '$maxAttempts'] },
})
```

`paymentMethod: 'card'` is the cheque/ACH gate (see §9). Only card
invoices are eligible for CRON auto-charge; cheque/ACH invoices sit on
`pending` until an admin acts.

For each invoice in the cursor:

1. Load the linked `CustomerMap` (for the NMI vault id).
2. Call `chargeInvoice({ invoice, customerMap })`.
3. Outcome counters: `processed / approved / declined / errored / skipped`.

Skip reasons:

- `invoice already paid` / `cancelled` (pre-check, before any NMI call)
- `max attempts reached` (attemptCount ≥ maxAttempts)
- `no NMI customer vault on file` (customerMap has no vault id — logged as a `skipped` PaymentAttempt)

On approved: `propagateSuccessfulPayment` is called (see §12).
On declined/error: `attemptCount++`, status stays `pending` if under cap or flips to `failed` once at cap.

### 11.2 PASS 2 — retry broken downstream sync

```js
Invoice.find({
  paymentStatus: 'paid',
  $or: [{ qboPaymentRecorded: false }, { shopifyMarkedPaid: false }],
})
```

For each invoice in the cursor, call `propagateSuccessfulPayment` directly — **no NMI re-charge**. Re-runs the QBO and Shopify sync against the already-paid invoice. Idempotent per-side flags ensure already-synced sides are skipped.

### 11.3 Attempt cap

`PAYMENT_MAX_RETRY_ATTEMPTS` (default `6`). After the 6th failed attempt
the invoice transitions to `paymentStatus: 'failed'` and the scheduler
stops trying. Failed invoices need explicit operator action.

### 11.4 Manual retry — admin actions on Order Details

The Order Details page surfaces a different primary action depending on
`Invoice.paymentMethod`. All three endpoints share the same eligibility
guards (`paymentStatus ∈ {pending, failed}`, order in shop, etc.) and
re-validate server-side, so an out-of-date UI cannot bypass them.

#### "Retry payment" — card invoices only

```
admin click → POST /api/admin/orders/:id/retry-payment
            → app/api/admin/retry-payment.js
                → guards: invoice.paymentMethod === 'card',
                  CustomerMap.nmiCustomerVaultId present
                → if attemptCount ≥ maxAttempts, bumps maxAttempts++
                → if paymentStatus === 'failed', flips to 'pending'
                → calls services/payment/payment.service.chargeInvoice
            → returns { outcome, transactionId?, responseText? }
```

Refuses non-card invoices with HTTP 409 — those have their own actions
below.

#### "Mark cheque paid" — cheque / ACH invoices

```
admin click → modal collects reference (+ amount + receivedAt)
            → POST /api/admin/orders/:id/mark-cheque-paid (JSON body)
            → app/api/admin/mark-cheque-paid.js
                → guards: invoice.paymentMethod !== 'card'
                → services/invoice/invoice.service.recordManualPayment
                  (see §9.3 for details)
            → returns { paymentStatus, amountPaid, amountDue, paidAt,
                        reference, kind, syncErrors }
```

Partial payments are supported — the invoice stays `pending` until
cumulative `amountPaid ≥ amountDue`.

#### "Charge card on file" — cheque / ACH invoices (fallback)

```
admin click → POST /api/admin/orders/:id/charge-card
            → app/api/admin/charge-card.js (see §9.4 for details)
            → returns { ...chargeResult, originalMethod, newMethod }
```

`attemptCount` is never reset across any of these paths — the
`PaymentAttempt` ledger is strictly append-only. The `manual_paid`
outcome distinguishes cheque receipts from NMI-driven attempts in the
audit history.

---

## 12. Status synchronization across QBO, Shopify, and local DB

`propagateSuccessfulPayment` (in `services/invoice/invoice.service.js`)
is the single funnel for mirroring payment activity into QBO + Shopify
+ the local order mirror. It is **cumulative-aware** — partial payments
each get their own QBO Payment record and their own Shopify SALE
transaction, instead of being skipped after the first one. Each side
is independent: a failure on one side does not block the others, and
re-invocations only do the missing work.

### 12.1 Sync model — diff-against-cumulative

Each downstream system carries its own running total on the Invoice
doc:

| System | Cumulative field | Per-event id list |
|---|---|---|
| QBO `Payment` | `Invoice.qboRecordedTotal` | `Invoice.qboPaymentIds[]` |
| Shopify SALE transactions | `Invoice.shopifyRecordedTotal` | `Invoice.shopifyTransactionIds[]` |

On every propagate call we record the **diff** between
`Invoice.amountPaid` and the running total — never the caller-passed
amount and never the full invoice balance. A cheque receipt of $5 then
a cheque receipt of $2.72 on a $7.72 invoice produces TWO QBO Payments
($5 and $2.72) and TWO Shopify SALE transactions, summing to $7.72 on
each side. The legacy `qboPaymentRecorded` / `shopifyMarkedPaid`
booleans are derived (true iff cumulative >= amountPaid within 0.005)
and still drive `CRON PASS 2`'s coarse sweep filter alongside an
`$expr` cumulative-mismatch check.

```
┌──────── 1. QBO Payment (per-partial) ──────────────────────────────┐
│  qboOwed = amountPaid - qboRecordedTotal                           │
│  if qboOwed > 0.005:                                               │
│    recordQboPayment({ amount: qboOwed, paymentRef: transactionId })│
│    qboPaymentIds.push(payment.Id)                                  │
│    qboRecordedTotal += qboOwed                                     │
│    qboPaymentRecorded = (qboRecordedTotal >= amountPaid)           │
└────────────────────────────────────────────────────────────────────┘

┌──────── 2. Shopify SALE transaction (per-partial) ─────────────────┐
│  shopOwed = amountPaid - shopifyRecordedTotal                      │
│  if shopOwed > 0.005:                                              │
│    recordOrderTransaction({ amount: shopOwed, ... })  ← REST       │
│    shopifyTransactionIds.push(transaction.id)                      │
│    shopifyRecordedTotal += shopOwed                                │
│  Shopify's displayFinancialStatus auto-computes from the           │
│  sum of transactions: paid / partially_paid / refunded.            │
└────────────────────────────────────────────────────────────────────┘

┌──────── 3. Shopify orderMarkAsPaid (once on full settlement) ──────┐
│  if invoice.paymentStatus == 'paid' AND !shopifyMarkedPaid:        │
│    markShopifyOrderPaid({ shop, shopifyOrderId })                  │
│    shopifyMarkedPaid = true                                        │
│  Idempotent: Shopify returns "already paid" once the SALE          │
│  transactions cover the total. Still called for its downstream-    │
│  workflow side effects (notifications, fulfillment hooks).         │
└────────────────────────────────────────────────────────────────────┘

┌──────── 4. shopify_orders local mirror ────────────────────────────┐
│  ShopifyOrder.findOneAndUpdate({ _id: invoice.orderRef }, { $set:  │
│    paymentStatus:    'paid' | 'pending'  (partial),                │
│    financialStatus:  'paid' | 'partially_paid',                    │
│    processingStatus: 'completed'  (when paymentStatus=paid),       │
│    paidAt, completedAt, nmiTransactionId, shopifyPaidSyncedAt,     │
│  })                                                                │
└────────────────────────────────────────────────────────────────────┘
```

`syncWithRetry` = 3 attempts with exponential backoff. `PermanentError`
(e.g. validation, auth) bypasses retry. The diff guard means re-runs
naturally skip work that's already done — we never write the same
payment to QBO twice.

### 12.2 Backward compatibility for pre-cumulative invoices

Invoices created before this change carry `qboPaymentRecorded: true`
and `shopifyMarkedPaid: true` but no cumulative total. The first call
into `propagateSuccessfulPayment` after the upgrade backfills:

```
if (qboPaymentRecorded && !(qboRecordedTotal > 0))
  qboRecordedTotal = amountPaid           // assume prior sync was full
if (shopifyMarkedPaid && !(shopifyRecordedTotal > 0))
  shopifyRecordedTotal = amountPaid
```

After backfill the diff guard sees nothing owed and skips, so old
fully-paid invoices don't re-record their old payments. New activity
on those invoices (e.g. an admin refund or a follow-up cheque on a
partially-paid pre-upgrade invoice) goes through the normal cumulative
path.

### 12.3 Shopify Admin call without a request

The scheduler runs autonomously, no logged-in admin session. To call
the Shopify Admin GraphQL API from the scheduler:

```js
import { unauthenticated } from '../../shopify.server'

const { admin } = await unauthenticated.admin(shop)
const response = await admin.graphql(mutation, { variables })
const json = await response.json()
```

`unauthenticated.admin(shop)` pulls an **offline session** from the
same `MongoDBSessionStorage` populated at OAuth install. If the shop
has uninstalled the app, no offline session exists and the call throws
`PermanentError("No installed session for shop … — re-install the app")`.

The `orderMarkAsPaid` mutation:

```graphql
mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
  orderMarkAsPaid(input: $input) {
    order { id displayFinancialStatus updatedAt }
    userErrors { field message }
  }
}
```

Idempotency: a second call to a paid order returns a userError matching
`/already.*paid/i` which `markShopifyOrderPaid` translates to a success
with `{ alreadyPaid: true }`.

### 12.4 Per-partial Shopify SALE transactions (REST)

The Admin GraphQL API has no general "record an arbitrary manual
payment transaction" mutation — `orderCapture` only operates on
existing AUTHORIZATION transactions, which our wholesale storefront
orders never carry. Instead we use the documented REST endpoint:

```http
POST /admin/api/{api_version}/orders/{order_id}/transactions.json
X-Shopify-Access-Token: <offline-session-token>

{ "transaction": {
    "kind":     "sale",
    "amount":   "5.00",
    "currency": "USD",
    "status":   "success",
    "gateway":  "manual",
    "source":   "external"
} }
```

The low-level helper is `shopify.apis.shopifyRestPost({ shop, session,
path, body })`; the domain wrapper is
`shopify.service.recordOrderTransaction({ shop, shopifyOrderId,
amount, currency, paymentRef })`. It reuses the offline session
loaded by `getUnauthenticatedAdmin(shop)` for the access token, so
no separate config is needed.

### 12.5 CRON PASS 2 sweep filter

PASS 2 catches invoices where any downstream is behind. Filter:

```js
{
  paymentStatus: { $in: ['paid', 'partially_paid', 'partially_refunded'] },
  $or: [
    { qboPaymentRecorded: false },
    { shopifyMarkedPaid: false, paymentStatus: 'paid' },
    { $expr: { $gt: [{ $subtract: ['$amountPaid', { $ifNull: ['$qboRecordedTotal', 0] }] }, 0.005] } },
    { $expr: { $gt: [{ $subtract: ['$amountPaid', { $ifNull: ['$shopifyRecordedTotal', 0] }] }, 0.005] } },
  ],
}
```

The two `$expr` clauses catch cumulative-mismatch cases (partial sync
left QBO or Shopify behind). The first two clauses cover legacy /
boolean-only invoices.

### 12.1 Shopify Admin call without a request

The scheduler runs autonomously, no logged-in admin session. To call
the Shopify Admin GraphQL API from the scheduler:

```js
import { unauthenticated } from '../../shopify.server'

const { admin } = await unauthenticated.admin(shop)
const response = await admin.graphql(mutation, { variables })
const json = await response.json()
```

`unauthenticated.admin(shop)` pulls an **offline session** from the same
`MongoDBSessionStorage` populated at OAuth install. If the shop has
uninstalled the app, no offline session exists and the call throws
`PermanentError("No installed session for shop … — re-install the app")`.

The `orderMarkAsPaid` mutation:

```graphql
mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
  orderMarkAsPaid(input: $input) {
    order { id displayFinancialStatus updatedAt }
    userErrors { field message }
  }
}
```

Idempotency: a second call to a paid order returns a userError matching
`/already.*paid/i` which `markShopifyOrderPaid` translates to a success
with `{ alreadyPaid: true }`.

---

## 13. Duplicate invoice prevention

Four independent layers — described in execution order:

### 13.1 Webhook-id dedup (cheapest)

`ShopifyOrder.seenWebhookIds: [String]`. Before any work,
`processShopifyOrder` checks whether `x-shopify-webhook-id` was already
processed. Shopify's at-least-once retries reuse the same id, so this
single check covers the most common cause of duplicates.

### 13.2 Terminal-status return

If the existing `ShopifyOrder.processingStatus` is one of `completed`,
`invoiced`, `scheduled`, or `rejected`, the orchestrator records the
new webhook id and returns the existing doc.

### 13.3 Atomic ShopifyOrder claim

Single `findOneAndUpdate` transitions `processingStatus` to `'processing'`
only if the order is in a claimable state (or has a stale lock). Two
concurrent workers — only one wins this transition; the other returns
the now-locked doc.

Stale-lock recovery: a `processing` doc whose `processingClaimedAt` is
older than `STALE_CLAIM_MS` (5 min) is reclaimable.

### 13.4 Claim-first Invoice creation (the critical fix)

Order of operations in `createInvoiceForOrder`:

```
phase 1  Invoice.create({ qboInvoiceId: null, qboCreationStatus: 'claimed' })
         ← unique (shop, shopifyOrderId) index lets exactly ONE worker through;
           others get E11000

phase 2  the winning worker calls QBO POST /invoice
         (the loser polls waitForClaimToComplete for up to 30 s)

phase 3  the winner writes qboInvoiceId + qboCreationStatus: 'created'
         the loser's poll sees the populated row and returns it
```

**This is the fix for the user-reported duplicate-invoice bug.** The
previous order (QBO call → Invoice insert) let two workers each call QBO
before either inserted; the unique index fired only after the
side-effect we wanted to prevent. Reversing the order makes a duplicate
QBO POST structurally impossible — the unique index now fires *before*
QBO is touched.

### 13.5 Boot-time verification

`entry.server.jsx` runs `verifyCriticalIndexes` after Mongo connect:

```
[boot] index OK     — Invoice unique (shop, shopifyOrderId) (name=shop_1_shopifyOrderId_1)
[boot] index OK     — ShopifyOrder unique (shop, shopifyOrderId) (name=shop_1_shopifyOrderId_1)
```

If duplicate rows in the collection prevented Mongo from building the
unique index, you'll see `[boot] index MISSING` instead. Cleanup script
in §22.4.

---

## 14. Error handling & retry strategy

### 14.1 Error taxonomy — `app/utils/retry.utils.js`

```
class PermanentError  - bypassed by retry; 4xx auth/validation
class TransientError  - retried with exponential backoff; 5xx / network / 429
```

`retry(fn, { attempts, baseMs, maxMs, factor, onAttempt })`:

- Exponential backoff with ±25% jitter
- Throws after `attempts` retries
- `PermanentError` short-circuits — caller gets the first failure

### 14.2 Where retry is used

| Layer | Function | Attempts |
|---|---|---|
| QBO HTTP | `services/qbo/qbo.apis.js` | `HTTP_RETRY_ATTEMPTS` (default 4) |
| NMI HTTP | `services/nmi/nmi.apis.js` | `HTTP_RETRY_ATTEMPTS` (default 4) |
| Sync to QBO/Shopify after success | `syncWithRetry` in `invoiceService.server.js` | 3 |
| NMI payment retry across days/ticks | scheduler | `PAYMENT_MAX_RETRY_ATTEMPTS` (default 6) |

### 14.3 Failure isolation

- A QBO outage does not invalidate an NMI success — the invoice stays in `paid` state but `qboPaymentRecorded: false`. Next scheduler tick (PASS 2) retries just the QBO side.
- A Shopify outage similarly leaves `shopifyMarkedPaid: false`. Next tick retries.
- An NMI decline does not block QBO invoice creation — the invoice exists in `pending` state and the scheduler retries the charge.

### 14.4 undici fetch errors

Node's `fetch` (undici) wraps DNS / TLS / connection errors as
`TypeError: fetch failed` with the real reason on `.cause`. Both NMI and
QBO clients unwrap this — logs show the actual code (`ENOTFOUND`,
`ECONNREFUSED`, …) instead of the opaque wrapper.

---

## 15. Logging & monitoring

### 15.1 Logger — `app/utils/logger.utils.js`

Two output modes selected by `LOG_PRETTY`:

- `LOG_PRETTY=false` (default, prod): one JSON line per event — friendly to log aggregators.
- `LOG_PRETTY=true` (dev): human-readable multi-line with stack traces on a separate line.

```js
const log = createLogger('qbo.invoice')
log.info('create.success', { invoiceId, qboId })
log.error('create.failed', { err })   // err.stack always printed
```

`LOG_LEVEL` filters: `debug` | `info` (default) | `warn` | `error`.

### 15.2 Boot banner

`entry.server.jsx` prints a single banner at startup showing every
relevant env var (with secrets masked as `set (X chars)`), all URLs in
use, scheduler mode, and the result of index verification:

```
=========================================================
  Natural Solutions wholesale app — boot
=========================================================
  SHOPIFY_APP_URL           : https://...
  Webhook endpoint          : https://.../webhooks/orders/create
  MONGODB_URI               : set (44 chars)
  --- QBO ---
  QBO_ENVIRONMENT           : sandbox
  QBO_API_BASE_URL          : https://sandbox-quickbooks.api.intuit.com
  QBO_REFRESH_TOKEN (seed)  : set (40 chars)
  --- NMI ---
  NMI_ENVIRONMENT           : sandbox
  NMI_API_URL               : https://sandbox.nmi.com/api/transact.php
  NMI test card (dev only)  : ACTIVE — last4 1111 exp 1234
  --- Payments ---
  PAYMENT_CHARGE_IMMEDIATELY: false
  PAYMENT_RETRY_INTERVAL    : 30 seconds
=========================================================
[routes] webhook + api routes registered:
  - /webhooks/orders/create
  - /webhooks/app/uninstalled
  ...
[boot] index OK     — Invoice unique (shop, shopifyOrderId)
[boot] index OK     — ShopifyOrder unique (shop, shopifyOrderId)
[boot] MongoDB connected
[scheduler] DEV MODE — process-pending-payments running every 30 seconds
[boot] Agenda scheduler started
```

### 15.3 Per-flow console output

Every hop emits a labeled console line in addition to the structured logger:

- `[webhook] orders/create POST received ...`
- `========== Shopify webhook: orders/create ==========` followed by `console.dir(payload)`
- `[orders] processShopifyOrder ...`
- `[orders] CLAIMED order ...`
- `[customers] resolved profile: ...`
- `[QBO →] POST /invoice` / `[QBO ←] status=200 ...`
- `[NMI →] op: sale / params: ...` (sensitive keys redacted)
- `[NMI charge] outcome=APPROVED txn=... code=100 "Approved"`
- `[sync] QBO ✓ payment recorded id=...`
- Scheduler tick: `┌─── [scheduler tick ...]` ... `└─── tick ... done in Xms — charges: ... | sync-retries: ...`

### 15.4 Audit ledger

Every NMI charge attempt — approved, declined, errored, skipped —
appends one row to `payment_attempts`. This is append-only and never
mutated. Full NMI response is stored in `rawResponse`. Use this as the
source of truth for any payment reconciliation.

---

## 16. Environment variables

Read and validated at boot by `services/<svc>/<svc>.config.js (per-service) + app/configs/index.js (boot aggregator)`. Missing
required values throw immediately.

| Variable | Default | Purpose |
|---|---|---|
| `MONGODB_URI` | _required_ | Mongo connection string for app + Agenda |
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` / `SHOPIFY_APP_URL` / `SCOPES` | _from Shopify CLI_ | Shopify app credentials |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `LOG_PRETTY` | `false` | `true` = human-readable, `false` = JSON lines |
| **QBO** | | |
| `QBO_CLIENT_ID` | _required_ | Intuit OAuth2 client id |
| `QBO_CLIENT_SECRET` | _required_ | Intuit OAuth2 client secret |
| `QBO_REALM_ID` | _required_ | Company / realm to invoice into |
| `QBO_REFRESH_TOKEN` | _required first run_ | Seed refresh token (from OAuth Playground) |
| `QBO_ENVIRONMENT` | `sandbox` | `sandbox` or `production` |
| `QBO_MINOR_VERSION` | `73` | API minor version |
| `QBO_DEFAULT_ITEM_ID` | `1` | QBO Item Id for invoice lines |
| `QBO_API_BASE_URL` | _auto_ | Override API host |
| `QBO_OAUTH_TOKEN_URL` | _auto_ | Override OAuth endpoint |
| **NMI** | | |
| `NMI_ENVIRONMENT` | `sandbox` | `sandbox` or `production` — MUST match security key |
| `NMI_SECURITY_KEY` | _required_ | Merchant security key |
| `NMI_PUBLIC_KEY` | (optional) | Collect.js public key for hosted tokenization |
| `NMI_API_URL` | _auto_ | Override transact.php URL |
| `NMI_QUERY_URL` | _auto_ | Override query.php URL |
| `NMI_COLLECT_JS_URL` | _auto_ | Collect.js script URL for the Immediate Payment self-pay page (§9.6). Auto-derived per environment (`secure`/`sandbox`); the page loads it with the publishable `NMI_PUBLIC_KEY` as the tokenization key. |
| `PAY_LINK_BASE_URL` | `SHOPIFY_APP_URL` | Stable public base URL for the Immediate Payment link baked into the QBO invoice (§9.6). Pin this in dev (the trycloudflare tunnel rotates each restart, killing old links); unset in prod to use the stable `SHOPIFY_APP_URL`. |
| `NMI_TEST_CCNUMBER` | (optional) | Dev test card number (sandbox only) |
| `NMI_TEST_CCEXP` | (optional) | Dev test card expiry MMYY |
| `NMI_TEST_CVV` | (optional) | Dev test card CVV |
| **Invoicing** | | |
| `INVOICE_TERMS_DAYS` | `15` | Generic fallback: days from order date to invoice due date when no per-method override is set. Sent as `DueDate` to QBO (overrides any customer-level SalesTerm) |
| `CHEQUE_DUE_DATE` | `INVOICE_TERMS_DAYS` | Days from order date → due date for **cheque** invoices (§7.3) |
| `ACH_DUE_DATE` | `INVOICE_TERMS_DAYS` | Days from order date → due date for **ACH** invoices (§7.3) |
| `CARD_DUE_DATE` | `INVOICE_TERMS_DAYS` | Days from order date → due date for **card** invoices (§7.3) |
| `IMMEDIATE_DUE_DATE` | `INVOICE_TERMS_DAYS` | Days from order date → due date for **Immediate Payment** invoices (§9.6) |
| `INVOICE_TERMS_MINUTES` | `0` | Extra minutes added on top of `INVOICE_TERMS_DAYS` for the local full-datetime `Invoice.dueAt` field. **Testing knob** — set to `1` to flag invoices Overdue ~1 minute after creation without waiting whole days. The QBO date-only `DueDate` ignores this offset (it still rounds to `termsDays`); only the local Order List "Overdue" indicator + cheque-reminder UI uses `dueAt`. |
| `INVOICE_FEE_RATE_CARD` | `0.03` | Per-method processing fee (decimal): card. Added as a line at invoice creation for card invoices (and at settlement for the cheque → card admin fallback / legacy invoices). `0` disables. |
| `INVOICE_FEE_RATE_ACH` | `0.01` | Per-method processing fee (decimal): ACH. Added as a line at invoice creation for ACH invoices (and on legacy `kind='ach'` manual receipts). `0` disables. |
| `INVOICE_FEE_RATE_CHECK` | `0` | Per-method processing fee (decimal): cheque. Defaults to no fee. |
| `INVOICE_FEE_RATE_IMMEDIATE` | `0.03` | Per-method processing fee (decimal): Immediate Payment (hosted card charge). Baked into `amountDue` at creation like card (§9.6). `0` disables. |
| **Payments** | | |
| `PAYMENT_CHARGE_IMMEDIATELY` | `false` | `true` = NMI charge in webhook process |
| `PAYMENT_MAX_RETRY_ATTEMPTS` | `6` | Cap on NMI charge attempts per invoice |
| `PAYMENT_SCHEDULE_TZ` | `America/Los_Angeles` | Cron timezone |
| `PAYMENT_RETRY_CRON_PRIMARY` | `30 0 15 * *` | Primary monthly cron expression |
| `PAYMENT_RETRY_CRON_SECONDARY` | `30 0 L * *` | Secondary monthly cron expression |
| `PAYMENT_RETRY_INTERVAL` | (unset) | Dev override, e.g. `30 seconds` |
| **ACH status-sync CRON** | | |
| `ACH_SYNC_CRON` | `0 3 * * *` | Production cron for the dedicated ACH status-sync job (once per day at 03:00) |
| `ACH_SYNC_INTERVAL` | (unset) | Testing override, e.g. `1 minute` — runs the sweep every minute; takes precedence over `ACH_SYNC_CRON` when set |
| `ACH_SYNC_STUCK_DAYS` | `5` | Days awaiting settlement before a "stuck" admin alert |
| `ACH_ALERT_WEBHOOK_URL` | (unset) | Optional outbound webhook for critical ACH alerts (off unless set) |
| **HTTP retries** | | |
| `HTTP_RETRY_ATTEMPTS` | `4` | Per-request retry cap (QBO + NMI) |
| `HTTP_RETRY_BASE_MS` | `500` | Base backoff |
| `HTTP_RETRY_MAX_MS` | `4000` | Max backoff |
| **Webhook** | | |
| `WEBHOOK_PROCESS_MODE` | `inline` | `inline` or `agenda` |

Production safety: `assertSafeTestCardConfig()` runs at boot. If
`NMI_TEST_CCNUMBER` or `NMI_TEST_CCEXP` is set but `NMI_ENVIRONMENT !==
'sandbox'`, both values are scrubbed and a warning prints.

---

## 17. Database collections

All in MongoDB, single database from `MONGODB_URI`.

| Collection | Model | Role |
|---|---|---|
| `sessions` | (Shopify session storage) | OAuth offline sessions per shop |
| `agenda_jobs` | (Agenda's own) | Scheduler job state |
| `qbo_tokens` | `models/qboToken.server.js` | One row per realm — current access + refresh token |
| `customer_maps` | `models/customerMap.server.js` | Shopify email ↔ QBO customer ↔ NMI vault; carries `paymentMethod` preference |
| `shopify_orders` | `models/order.server.js` | Local mirror of every received Shopify order |
| `invoices` | `models/invoice.server.js` | Local invoice mirror + sync state; carries `paymentMethod` (active, mutable), `customerPaymentPreference` (immutable order-time snapshot), `paymentSettledVia` + `paymentSettledAt` (recorded on each successful payment), `qboDueDate`, `manualPayments[]` ledger, `remarks[]` ledger (append-only CRON + admin follow-up entries — `kind` ∈ `cron_card_attempt` / `cron_cheque_reminder` / `cron_failed_followup` / `admin_action` / `system_note`; powers the Order List **Remarks** column), and the auto-charge pause control (`autoChargePaused` Boolean + `autoChargePausedAt` / `autoChargePausedBy` / `autoChargePauseNote` / `autoChargeResumeAt` / `autoChargeResumedBy` — §9.2.1), and the email-reminder pause control (`reminderPaused` Boolean + `reminderPausedAt` / `reminderPausedBy` / `reminderPauseNote` / `reminderResumeAt` / `reminderResumedBy` — §10.5) |
| `payment_attempts` | `models/paymentAttempt.server.js` | Append-only charge ledger (NMI + manual cheque receipts as `outcome: 'manual_paid'`) |
| `wholesale_applications` | `models/wholesaleApplication.server.js` | Wholesale signups (pre-existing) |

### 17.1 Critical indexes

```
sessions          (managed by @shopify/shopify-app-session-storage-mongodb)
qbo_tokens        unique on realmId
customer_maps     unique on (shop, email)
shopify_orders    unique on (shop, shopifyOrderId)
invoices          unique on (shop, shopifyOrderId)
                  + (paymentStatus, attemptCount)  for scheduler cursor
                  + (paymentMethod)                for cheque/ACH filter
                  + (autoChargePaused)             for CRON pause skip (§9.2.1)
payment_attempts  (invoiceRef, attemptedAt)
```

The two `unique (shop, shopifyOrderId)` indexes are the structural duplicate guards described in §13.

---

## 18. API request/response examples

### 18.1 Shopify orders/create webhook (inbound)

```
POST /webhooks/orders/create
Content-Type: application/json
X-Shopify-Topic: orders/create
X-Shopify-Shop-Domain: ns-wholesale-staging-1.myshopify.com
X-Shopify-Webhook-Id: <uuid>
X-Shopify-Hmac-Sha256: <base64>

{ "id": 6655991611461, "name": "#1021", "email": "buyer@example.com",
  "total_price": "23.16", "currency": "USD",
  "billing_address": { ... }, "shipping_address": { ... },
  "line_items": [ ... ], "customer": { ... } }
```

Response: `200 OK` with empty body (returned within ms; downstream work runs after the response).

### 18.2 QBO — create customer

```
POST /v3/company/{realmId}/customer?minorversion=73
Authorization: Bearer <accessToken>

{ "DisplayName": "Buyer Example", "GivenName": "Buyer",
  "PrimaryEmailAddr": { "Address": "buyer@example.com" },
  "BillAddr": { "Line1": "...", "City": "...", "PostalCode": "...",
                "CountrySubDivisionCode": "CA", "Country": "US" } }

→ { "Customer": { "Id": "58", "DisplayName": "Buyer Example", ... } }
```

### 18.3 QBO — create invoice

```
POST /v3/company/{realmId}/invoice?minorversion=73

{ "CustomerRef": { "value": "58" },
  "Line": [ { "DetailType": "SalesItemLineDetail", "Amount": 23.16,
              "SalesItemLineDetail": { "ItemRef": { "value": "1" },
                                       "Qty": 4, "UnitPrice": 5.79 } } ],
  "DocNumber": "1021", "CustomerMemo": { "value": "Shopify order #1021" },
  "DueDate": "2026-06-05", "ShipDate": "2026-05-21",
  "ShipAddr": { "Line1": "123 Main St", "City": "Austin",
                "CountrySubDivisionCode": "TX", "PostalCode": "78701",
                "Country": "US" } }

→ { "Invoice": { "Id": "175", "DocNumber": "1021", "TotalAmt": 23.16,
                 "SyncToken": "0", "CurrencyRef": { "value": "USD" } } }
```

### 18.4 NMI — add customer (sandbox)

```
POST https://sandbox.nmi.com/api/transact.php
Content-Type: application/x-www-form-urlencoded

security_key=<secret>&
customer_vault=add_customer&
first_name=Buyer&last_name=Example&email=buyer@example.com&
address1=...&city=...&state=CA&zip=...&country=US&
ccnumber=4111111111111111&ccexp=1234

→ response=1&responsetext=Customer Added&customer_vault_id=900001&...
```

### 18.5 NMI — charge stored card

```
POST https://sandbox.nmi.com/api/transact.php

security_key=<secret>&type=sale&customer_vault_id=900001&
amount=23.16&currency=USD&orderid=6655991611461

→ response=1&responsetext=Approved&transactionid=12078125393&authcode=123456&...
```

### 18.6 QBO — record payment

```
POST /v3/company/{realmId}/payment?minorversion=73

{ "CustomerRef": { "value": "58" },
  "TotalAmt": 23.16,
  "PaymentRefNum": "12078125393",
  "Line": [ { "Amount": 23.16,
              "LinkedTxn": [ { "TxnId": "175", "TxnType": "Invoice" } ] } ] }

→ { "Payment": { "Id": "201", "TotalAmt": 23.16, ... } }
```

### 18.7 Shopify Admin — mark order paid

```graphql
mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
  orderMarkAsPaid(input: $input) {
    order { id displayFinancialStatus updatedAt }
    userErrors { field message }
  }
}
# variables: { "input": { "id": "gid://shopify/Order/6655991611461" } }
```

---

## 19. Development vs production behavior

| Concern | Dev | Production |
|---|---|---|
| Scheduler interval | `PAYMENT_RETRY_INTERVAL=30 seconds` | `PAYMENT_RETRY_INTERVAL=` (empty) → cron |
| Cron | overridden | `30 0 15 * *` + `30 0 L * *` |
| NMI host | `sandbox.nmi.com` | `secure.nmi.com` |
| QBO host | `sandbox-quickbooks.api.intuit.com` | `quickbooks.api.intuit.com` |
| Test card | active (`NMI_TEST_*` populated) | scrubbed at boot, warning logged |
| Log format | `LOG_PRETTY=true` (multi-line) | `LOG_PRETTY=false` (JSON lines) |
| `PAYMENT_CHARGE_IMMEDIATELY` | typically `false` (scheduler-driven) | `false` |
| `WEBHOOK_PROCESS_MODE` | `inline` | either, depending on host worker reliability |

`assertSafeTestCardConfig()` is the runtime guard preventing test cards leaking into production.

---

## 20. Testing flow & test credentials

### 20.1 NMI test card

Set in `.env`:
```
NMI_ENVIRONMENT=sandbox
NMI_TEST_CCNUMBER=4111111111111111
NMI_TEST_CCEXP=1234
NMI_TEST_CVV=123
```

The static-test-card strategy in `paymentDetailsResolver` injects these
when no real card is available. Production env scrubs them.

### 20.2 QBO sandbox

Get an initial refresh token from Intuit's OAuth Playground
(https://developer.intuit.com/app/developer/playground) using the
sandbox company. Paste it into `QBO_REFRESH_TOKEN`. The first call
exchanges it for an access token; subsequent calls use the persisted
token in `qbo_tokens`.

### 20.3 End-to-end test

1. Create an order in Shopify admin for a sandbox dev store.
2. Watch the dev console:
   - `[webhook] orders/create POST received ...` — webhook arrived
   - `[customers] resolved profile: ...` — billing/shipping resolved
   - `[customers] QBO customer created Id=...` / `NMI vault created — id=...`
   - `[invoice] CREATED Invoice ... qboInvoiceId=...`
   - 30 s later: `┌─── [scheduler tick dev #...]` followed by the charge attempt
   - On approved: `[sync] QBO ✓ ... SHOP ✓ ... DB ✓ ... all systems in sync`
3. Refresh Shopify admin orders — the order flips to **Paid**.
4. Open QBO sandbox → Invoices — the invoice flips to **Paid**.

### 20.4 Trigger a synthetic webhook without a real order

```
shopify app webhook trigger \
  --topic=orders/create \
  --api-version=2025-07 \
  --address=https://your-public-url/webhooks/orders/create
```

Useful while waiting for Partners-dashboard approval of the protected-data topic.

---

## 21. Public webhook URL handling (Cloudflare / ngrok)

The app needs an HTTPS public URL Shopify can reach. Options:

- **Shopify CLI tunnel** (`shopify app dev`) — auto-managed when
  `automatically_update_urls_on_dev = true` in the active TOML. Updates
  `application_url` on every restart.
- **ngrok / Cloudflare Tunnel** — manual. Set the URL in
  `shopify.app.<config>.toml`'s `application_url`, run `shopify app
  deploy --config=<config>` to push, then point your tunnel at the local
  port. Useful when `automatically_update_urls_on_dev = false`.
- **Render / Fly / Railway / etc.** — set `SHOPIFY_APP_URL` env and
  ensure `application_url` in the TOML matches.

In all cases the webhook endpoint resolves as:
`{SHOPIFY_APP_URL}/webhooks/orders/create`

The boot banner prints this URL on every restart so you can verify it
at a glance.

---

## 22. Edge cases & validations

### 22.1 Order arrives without billing AND without customer.default_address

Validation `NO_BILLING` triggers. Order is persisted with
`processingStatus: 'rejected'` and `rejectionCode: 'NO_BILLING'`.
No QBO/NMI calls. Operator can manually add an address in Shopify and
replay the webhook from the Partners dashboard.

### 22.2 NMI sandbox returns "Sandbox accounts must use sandbox.nmi.com"

Wrong host configured. Fix: `NMI_ENVIRONMENT=sandbox`. Production
security key on sandbox host (or vice versa) returns "Authentication
Failed".

### 22.3 QBO refresh token expired

`QBO token refresh failed: invalid_grant` from
`refreshAccessToken`. Re-fetch a fresh refresh token from the Intuit
OAuth Playground and replace `QBO_REFRESH_TOKEN` in env. The next call
will reseed `qbo_tokens`.

### 22.4 Boot reports `[boot] index MISSING — Invoice unique (shop, shopifyOrderId)`

Existing duplicate rows in `invoices` are blocking the unique index
build. Clean them up:

```js
// mongosh
db.invoices.aggregate([
  { $group: {
      _id: { shop: '$shop', shopifyOrderId: '$shopifyOrderId' },
      ids: { $push: '$_id' }, count: { $sum: 1 } } },
  { $match: { count: { $gt: 1 } } }
]).forEach(doc => {
  const [keep, ...drop] = doc.ids
  db.invoices.deleteMany({ _id: { $in: drop } })
  print(`order ${doc._id.shopifyOrderId}: kept ${keep}, dropped ${drop.length}`)
})
```

Restart the server — Mongoose builds the index on next connect.

### 22.5 Worker crashes mid-flight between Invoice claim and QBO call

The Invoice row stays in `qboCreationStatus: 'claimed'` with no
`qboInvoiceId`. Concurrent retries enter `waitForClaimToComplete` and
time out after `CLAIM_WAIT_MS` (30 s) with `"Timed out waiting for
concurrent claim to complete"`. Operator action: inspect, void any
orphaned QBO invoice if one was created, and either delete the Invoice
row to allow a fresh claim or mark it failed.

### 22.6 Shopify uninstalled the app

`orderMarkAsPaid` throws `PermanentError("No installed session for shop
… — re-install the app")`. The invoice's `shopifyMarkedPaid` stays
false. Scheduler PASS 2 keeps trying every tick (no NMI re-charge) and
will succeed automatically once the merchant reinstalls.

### 22.7 Partial payment / split charge

Currently `chargeInvoice` charges the full outstanding balance
(`amountDue - amountPaid`) in one transaction. If NMI splits a charge
into installments (e.g. partial capture), the invoice transitions to
`paymentStatus: 'pending'` (not `paid`) until `amountPaid >=
amountDue`. The scheduler retries the remaining balance on subsequent
ticks.

### 22.8 Webhook for an order that was cancelled in Shopify

Validation `CANCELLED`. Order persisted as `rejected`. No QBO/NMI calls.

### 22.9 Webhook for a fully-refunded order

Validation `FINANCIAL_TERMINAL`. Same handling as above.

### 22.10 Two simultaneous taps of "Resend webhook" in Shopify admin

Same webhook id, multiple deliveries. Layer 1 (webhook-id dedup) catches it on the second delivery onward.

### 22.11 Customer has no wholesale application on file

`ensureCustomerForOrder` queries `wholesale_applications` by `(shop,
email)` to resolve `paymentMethod`. If no application exists (or
`payment.method` is unset), the resolver defaults to `card`. This
preserves the legacy CRON auto-charge behavior for customers that
pre-date the cheque/ACH workflow. Operator override path: edit
`customer_maps.paymentMethod` directly in Mongo if the default is wrong
for a given customer.

### 22.12 Customer changes payment-method preference after orders exist

End users can update their preferred payment method via
`/api/update-profile`, which writes `wholesale_applications.payment.method`.
On the next order for that customer, `ensureCustomerForOrder` re-reads
the application and refreshes `CustomerMap.paymentMethod`, so new
invoices automatically pick up the change.

Existing invoices retain their original preference forever — the
immutable `Invoice.customerPaymentPreference` snapshot is the source
of truth for the "Preferred method" column in the Order List and the
"Customer preference (at order)" KV on Order Details. Display layers
must NEVER read `CustomerMap.paymentMethod` to render historical
preference — that would drift.

Open invoices likewise keep their active `paymentMethod` until an
admin explicitly flips it via the cheque → card admin action. That
override mutates only `Invoice.paymentMethod`; the preference snapshot
is never touched. Once the invoice settles, `Invoice.paymentSettledVia`
records what actually settled it — so a cheque order overridden to
card shows `preference=Cheque, settledVia=Credit card` (and the
Settled-via cell renders an "override" hint).

---

## 23. Deployment / setup

### 23.1 First-time setup (local)

```bash
git clone <repo>
cd wholesale
npm install
cp .env.example .env   # fill in QBO + NMI credentials
```

Required env values for first boot:
- `MONGODB_URI`
- Shopify credentials (`SHOPIFY_API_KEY`, etc — managed by Shopify CLI)
- `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REALM_ID`, `QBO_REFRESH_TOKEN`
- `NMI_SECURITY_KEY`

```bash
shopify app dev   # or shopify app config use <config> && shopify app dev
```

### 23.2 Webhook subscription

If `orders/create` is approved in Partners:

```bash
shopify app deploy --config=<your-config>
```

If not yet approved: `ensureProtectedWebhooks` (called from
`app/routes/app.jsx` loader) tries to register programmatically. Open
the embedded admin once to trigger registration. Outcome is logged.

### 23.3 Production deployment checklist

- [ ] `NMI_ENVIRONMENT=production` and `NMI_SECURITY_KEY` is the production key
- [ ] `QBO_ENVIRONMENT=production` and `QBO_REALM_ID` is the production realm
- [ ] `QBO_REFRESH_TOKEN` is set from a production OAuth Playground exchange
- [ ] `NMI_TEST_CCNUMBER`, `NMI_TEST_CCEXP`, `NMI_TEST_CVV` are **unset** (boot logs confirm scrubbing if accidentally set)
- [ ] `PAYMENT_CHARGE_IMMEDIATELY=false`
- [ ] `PAYMENT_RETRY_INTERVAL=` (empty) — cron takes over
- [ ] `PAYMENT_RETRY_CRON_PRIMARY` / `SECONDARY` / `PAYMENT_SCHEDULE_TZ` reflect the merchant's billing schedule
- [ ] `LOG_PRETTY=false` — JSON lines for the log aggregator
- [ ] `SHOPIFY_APP_URL` matches the `application_url` in the active TOML
- [ ] Mongo has both unique indexes (verify in boot banner)
- [ ] Shopify Partners → app → API health shows the orders/create subscription as registered and healthy

### 23.4 Scaling notes

- Multiple Node processes are fine: Agenda's MongoDB-backed locking
  ensures each scheduler tick runs in only one process at a time.
- The atomic ShopifyOrder + Invoice claims are designed for horizontal
  scale-out — concurrent webhook deliveries to different instances
  don't produce duplicates.
- A single Mongo replica set is the only stateful dependency.

---

## 24. Future enhancements

- **DB-driven payment details** — wire the `wholesale-application`
  strategy in `paymentDetailsResolver` to read an NMI Collect.js token
  stored at registration time. Removes the static test card from the
  dev critical path.
- **Vault token capture at registration** — `app/api/registration-form.js`
  currently hashes the card number. Switching to Collect.js hosted
  tokenization at form submit and storing the resulting
  `customer_vault_id` on the wholesale application would close the gap
  between registration and first invoice.
- **Manual cheque flow** — a new strategy `{ method: 'manual-check' }`
  plus a corresponding branch in `chargeInvoice` that records a
  pending manual payment instead of calling NMI. Status flips to
  `paid` on operator action via a new admin route.
- **Webhook idempotency table** — promote `seenWebhookIds[]` from an
  array on ShopifyOrder to a dedicated `webhook_events` collection
  keyed by webhook id. Lets us dedup webhooks for orders we've never
  seen the order doc for (e.g. orders/updated arriving before
  orders/create's processing wins the race).
- **Admin reconciliation UI** — list invoices where
  `lastSyncError` is set, with one-click retry per side.
- **Per-shop QBO realms** — current model keys `qbo_tokens` by
  realmId. Promote to `(shop, realmId)` so a single app instance can
  invoice into multiple QBO companies.
- **Refund / void from Shopify** — listen for `refunds/create` and
  drive `refundTransaction` / `voidTransaction` in NMI plus
  `createCreditMemo` in QBO.
- **Backfill job** — replay the Shopify orders/list for a date range
  into the local pipeline. Useful when subscribing to `orders/create`
  for the first time after operating without webhooks.

## 25. Practitioner Portal (CDO referral dashboard) — MOVED to ns-retail

> **Moved out of this app on 2026-06-08.** The Practitioner Portal is a
> CDO-program feature, and the sibling **`ns-retail`** app owns and writes the
> `cdo_*` collections it reads. The entire feature — the Customer Account UI
> extension AND its `/api/portal/*` backend + `cdo.portal.service.js` — now
> lives in `ns-retail`, reading the real cdo models there instead of the
> read-only mirrors this app used to carry. **Canonical spec: `ns-retail/docs/payout.md §18`.**
> The section below is retained for historical context only; the code it
> describes no longer exists in the wholesale workspace.

A storefront self-service dashboard for **CDO practitioners** (approved
wholesale customers who hold a referral code). It is a **read-only view**
over data that the sibling **`ns-retail`** app writes — the wholesale app
never generates commissions or payouts; it only surfaces them. Delivered
as Phase 1 (foundation) on 2026-06-08.

### 25.1 The CDO data model (shared MongoDB collections)

`ns-retail` owns and writes these collections in the same database
(`MONGODB_URI`). The wholesale app reads them through `strict:false`
mirror models that are explicitly flagged read-only (same convention as
the pre-existing `cdo_practitioner_codes` mirror — see `cdoPractitionerCode.server.js`).

| Collection | Mirror model | Holds | Key fields used here |
|---|---|---|---|
| `cdo_practitioner_codes` | `cdoPractitionerCode.server.js` (pre-existing) | Referral codes | `practitionerId`, `code`, `discountPercent`, `commissionRate`, `status`, `isPrimary` |
| `cdo_orders` | `cdoOrder.server.js` | Attributed retail orders | `practitionerId`, `referralCode`, `customerEmail`, `pricing.total` / `amount`, `commissionAmount`, `placedAt`, `lineItems[]` |
| `cdo_commissions` | `cdoCommission.server.js` | Per-order commission | `practitionerId`, `orderName`, `amount`, `rate`, `status` (`pending`/`paid`), `payoutStatus` (`paid`/`failed`/`paused`), `earnedAt` |
| `cdo_payouts` | `cdoPayout.server.js` | Payout records | `practitionerId`, `amount`, `method`, `status`, `reference`, `qboBillId`, `paidAt` |
| `cdo_referrals` | `cdoReferral.server.js` | Referred patients | `practitionerId`, `referredEmail`, `referredName`, `referralCode`, `status`, `referredAt`, `convertedAt` |
| `cdo_applications` | `cdoApplication.server.js` | Patient applications | `applicantType`, `referral{}`, `customerId`, `email`, `submittedAt` |

> **Maintenance rule:** these collections are owned by `ns-retail`. If its
> schema changes, the mirrors here only need updating when the portal
> starts depending on a new field — `strict:false` keeps reads working
> regardless. Never write to these collections from the wholesale app.

### 25.2 The tenant key (how identity resolves)

The single linkage that makes the whole portal work and stay isolated:

```
wholesale_applications._id   ===   practitionerId (across every cdo_* collection)
wholesale_applications.customerId   ===   gid://shopify/Customer/<id>
```

So a logged-in customer is mapped to their CDO data as:

```
Customer-account UI extension calls shopify.sessionToken.get() → signed JWT
  → fetch(`${api_base_url}/api/portal/*`, { Authorization: Bearer <jwt> })
  → authenticate.public.customerAccount(request)  // verifies JWT sig/aud/exp → { sessionToken, cors }
  → sessionToken.sub  ===  gid://shopify/Customer/<id>   (present iff logged in + protected-data access)
  → WholesaleApplication.findOne({ customerId: sessionToken.sub, status: 'approved' })
  → practitionerId = String(application._id)
  → every cdo_* query is scoped { practitionerId }
```

The mapping lives in
`services/cdo/cdo.portal.service.js#resolvePractitionerByCustomerGid` (the
guard performs the JWT verification, then passes `sessionToken.sub`).

### 25.3 Security model (core requirement)

- **Identity is never trusted from the client.** `practitionerId` is
  re-derived server-side on *every* request from the Shopify-signed
  session-token `sub` claim (verified by `authenticate.public.customerAccount`,
  built into `@shopify/shopify-app-react-router`). No `practitionerId`/`email`
  from the query or body is ever used for scoping.
- Auth outcomes the extension branches on:
  - **401** (no/invalid/expired token, or `sub` claim absent because the
    buyer isn't logged in / protected-data access not granted) → extension
    shows a "sign in required" notice.
  - **403** (logged in, but not an approved `WholesaleApplication`) →
    extension shows an "access restricted" notice.
- All endpoints are GET/read-only and share the `app/api/portal/_guard.js`
  `portalLoader` wrapper (DB connect → `authenticate.public.customerAccount`
  → resolve `sub` → error-map → handler → `cors(res)`).
- **CORS:** the extension runs in a null-origin Web Worker and sends an
  `Authorization` header, so its `fetch` is "non-simple" → the browser issues
  an `OPTIONS` preflight (carrying no auth). Each portal route's `action`
  (`portalAction`) answers the preflight with a 204 + CORS headers; success
  responses are wrapped by the library `cors` helper, error responses carry
  `sendResponse`'s wildcard `Access-Control-Allow-Origin: *`.
- **Prerequisites:** Shopify *new customer accounts* + *protected customer
  data access* (the `sub` claim is only present when the app may read
  customer data).

### 25.4 Endpoints (called by the extension at `${api_base_url}/api/portal/*`)

Thin handlers in `app/api/portal/*`, registered in `app/routes.js`. All
business logic is in `services/cdo/cdo.portal.service.js`.

| Endpoint | Service fn | Returns |
|---|---|---|
| `GET /me` | `getProfile` | practitioner name/email/primary code (bootstrap) |
| `GET /summary` | `getSummary` | summary cards (patients, revenue, commission buckets, active codes) |
| `GET /revenue?from&to` | `getRevenue` | revenue: this month / last month / current year / lifetime + optional range |
| `GET /customers?search&page&pageSize` | `getReferredCustomers` | referred patients + per-customer total orders & LTV (joins `cdo_orders` by email) |
| `GET /commissions?status&from&to&page&pendingOnly` | `getCommissions` | commission list + totals; `pendingOnly=1` → earned-but-unpaid view |
| `GET /payouts?status&from&to&page` | `getPayouts` | payout history |
| `GET /referrals` | `getReferralCodes` | codes + per-code usage (referrals/orders/revenue/commission) |
| `GET /discounts` | `getDiscounts` | discounts derived from codes (type/value/status/usage) |

Commission buckets: **paid** = `payoutStatus==='paid'`; **pending** =
`status==='pending'`; **awaiting payout** = `status==='paid' &&
payoutStatus!=='paid'`; **failed** = `payoutStatus==='failed'`. Per-code
commission is summed from `cdo_orders.commissionAmount` (commissions link
to orders, not codes). Money values are rounded to 2 dp server-side
(`round2`) to strip float noise.

### 25.5 Frontend (Customer Account UI extension, full-page)

`extensions/practitioner-portal-account/` is a Customer Account UI
extension (`type = "ui_extension"`, api_version `2025-10`), built and
deployed by the Shopify CLI (`shopify app dev` / `deploy`) — there is no
separate Vite step.

- **`shopify.extension.toml`**: single `[[extensions.targeting]]` →
  `target = "customer-account.page.render"`, `module =
  "./src/PractitionerPortal.jsx"`; `[extensions.capabilities] network_access
  = true`; one `[extensions.settings]` field `api_base_url` (the app backend
  base URL, set per environment in the customer-account editor; read at
  runtime via `shopify.settings.value.api_base_url`).
- **Runtime/UI**: Preact (`@shopify/ui-extensions/preact`, `render(<App/>,
  document.body)`) + **Polaris web components** (`s-page`, `s-section`,
  `s-grid`, `s-stack`, `s-text`, `s-heading`, `s-badge`, `s-button`,
  `s-banner`, `s-spinner`, `s-text-field`, `s-select`, `s-divider`). The
  sandbox forbids arbitrary HTML/CSS, so **tables are built from `s-grid`**
  (`src/ui.jsx#Table`) and the UI inherits the merchant's branding.
- **Files**: `src/PractitionerPortal.jsx` (entry + auth bootstrap via
  `/api/portal/me` + local-state tab nav: overview / patients / commissions /
  pending / payouts / referrals / discounts), `src/api.js` (fetch wrapper —
  reads `api_base_url`, attaches a fresh `shopify.sessionToken.get()` Bearer
  per call, parses the `{status,message,result}` envelope), `src/sections.jsx`
  (the seven sections), `src/ui.jsx` (`useResource` hook, `Table`, `StatCards`,
  `StatusBadge`, `Pagination`), `src/format.js` (Intl formatters).
- **Merchant step**: add the page to the customer-account navigation menu and
  set `api_base_url` (full-page targets allow direct linking by default).

### 25.6 Out of scope / limitations (later phases)

- **CSV export is not available on this surface.** The extension runs in a
  sandboxed Web Worker with no DOM/Blob, so a client-side download is
  impossible (and a plain `<link>` can't carry the Bearer token). A later
  phase can add a server endpoint emitting CSV behind a short-lived signed
  URL. (The removed storefront theme-block portal had client-side CSV.)
- Commission / payout **generation** — owned by `ns-retail`.
- Live **Shopify Discount API** objects — Phase 1 derives the Discounts
  section from practitioner codes (`discountPercent`, status, usage).
- Charts / graphs — Phase 1 is cards + tables only.
