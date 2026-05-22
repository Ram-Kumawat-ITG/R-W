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
│   │   ├── customer.service.js           #   ensureCustomerForOrder
│   │   ├── customer.utils.js             #   normalizeAddress, buildProfileFromShopifyOrder
│   │   └── paymentDetails.service.js     #   Strategy registry for NMI payment details
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

---

## 5. Order processing orchestrator

`services/order/order.service.js` is the only place that drives an order from "received" to "scheduled." It is **idempotent and concurrency-safe**.

### 5.1 Lifecycle states (`ShopifyOrder.processingStatus`)

```
received  → processing ──┬─→ pending_approval ──(admin approves)──┐
                         │                                         │
                         └─→ customer_ready → invoiced → scheduled → completed
                                  │
                                  ├── rejected (validation failed or no customer)
                                  └── failed   (downstream error)
```

`pending_approval` is the hold state for orders from Shopify customers that
do **not** carry the `Approved` tag. The orchestrator skips QBO and NMI
work entirely for these orders. They are re-entered into the pipeline by
`replayPendingOrdersForCustomer` (triggered from `admin/review.js` when an
admin approves the customer) — see §5.4 below.

### 5.2 The three idempotency layers (in this function)

| Layer | Mechanism | Catches |
|---|---|---|
| Webhook-id dedup | `seenWebhookIds[]` on ShopifyOrder | Shopify retries — same `x-shopify-webhook-id` |
| Terminal-status return | `if status ∈ {completed, invoiced, scheduled, rejected} → return` | Order already processed |
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
  ├── if !mapping.nmiCustomerVaultId:
  │     paymentDetails ← resolvePaymentDetails({ shop, email })
  │     findOrCreateCustomerVault({ profile, paymentDetails })
  │                                          ← query.php by email, then add_customer
  │     mapping.nmiCustomerVaultId = result.customer_vault_id
  │
  └── mapping.save()
```

QBO and NMI customer creation are **skipped** if the mapping already has
the corresponding ID. Re-running the orchestrator for a known customer
makes zero external calls.

### 6.4 Payment details resolver

`services/customer/paymentDetails.service.js` implements a
strategy registry so the source of customer payment data is pluggable.

Currently registered strategies (tried in order, first non-null wins):

1. **`static-test-card`** — returns `NMI_TEST_CCNUMBER` / `NMI_TEST_CCEXP` from env, **sandbox only**. Production env throws these out at boot via `assertSafeTestCardConfig()`.
2. **`wholesale-application`** — stub in place, not yet implemented. Future code path that pulls a Collect.js token stored at registration time in the `wholesale_applications` collection.

Adding a new source = one `registerPaymentDetailsStrategy(name, fn)` call. No other code changes.

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

`DueDate` is computed in this app as **order date + `INVOICE_TERMS_DAYS`**
(default 15) by `invoice.utils.computeInvoiceDueDate`, then sent
explicitly to QBO. This makes us the source of truth for terms and
overrides any customer-level `SalesTerm` configured in QBO. The
returned `DueDate` is captured on the local invoice as `qboDueDate`
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

**Processing-fee line — applied at settlement, per actual method.**
A `<Method> Processing Fee – <X>%` line is appended to the QBO invoice
the moment a payment is processed. The fee is decided by the **actual
settlement method**, not the customer's preference, and per-method
rates are configurable:

| Method  | Default rate | Env var |
|---|---|---|
| Credit card | `3%` | `INVOICE_FEE_RATE_CARD` |
| ACH | `1%` | `INVOICE_FEE_RATE_ACH` |
| Cheque | `0%` | `INVOICE_FEE_RATE_CHECK` |

| Settlement path | Fee applied? |
|---|---|
| CRON auto-charge (card-preferred customer) | ✓ card rate |
| Admin **Retry payment** (card-preferred) | ✓ card rate |
| Admin **Charge card on file** (cheque → card fallback) | ✓ card rate |
| Admin **Mark ACH paid** (`kind='ach'`) | ✓ ACH rate |
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

`findOrCreateCustomerVault({ profile, paymentDetails })`:

1. **Lookup** via `query.php?report_type=customer_vault&email=…`. NMI doesn't expose a structured search; we substring-match the email in the returned XML.
2. **Create** via `transact.php`:
   ```
   customer_vault=add_customer
   first_name, last_name, company, email, phone
   address1, city, state, zip, country
   shipping_address1, shipping_city, ...
   (one of:)
     ccnumber, ccexp[, cvv]
     payment_token              ← Collect.js / hosted tokenizer
     payment=check, checkaba, checkaccount, account_type
   ```

NMI rejects `add_customer` without a billing address. The orchestrator
pre-validates the five required fields (see §6.2) so a missing field
produces a clear local error instead of a generic NMI rejection.

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

---

## 9. Cheque / ACH payment handling

Each customer carries a preferred payment method on their wholesale
application (`wholesale_applications.payment.method` — one of `check`,
`ach`, `card`). The CRON only auto-charges `card`; `check` and `ach`
are held for manual admin action from the Order Details page.

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

PASS 1 of `process-pending-payments` filters by `paymentMethod: 'card'`:

```js
Invoice.find({
  paymentStatus: 'pending',
  paymentMethod: 'card',
  $expr: { $lt: ['$attemptCount', '$maxAttempts'] },
})
```

Cheque / ACH invoices sit on `pending` indefinitely until an admin acts.
PASS 2 (downstream sync retry) is NOT gated by method — once an invoice
is `paid`, any failed QBO/Shopify sync is replayed regardless of how
the invoice was paid.

The same gate applies to the immediate-charge path in
`order.service.processShopifyOrder`: even with
`PAYMENT_CHARGE_IMMEDIATELY=true`, only `card` invoices fire the inline
NMI sale.

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

### 9.5 ACH transport (existing)

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

This transport is unchanged. The workflow change in this section gates
*when* we run the sale, not how. Per project decision, ACH invoices are
treated as manual (same as cheque) and skipped by the CRON.

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

After NMI returns `response=1` (approved), `propagateSuccessfulPayment`
(in `services/invoice/invoice.service.js`) mirrors the state into
three systems. Each side is independent:

```
┌──────── 1. QBO ────────────────────────────────────────────────────┐
│  if !invoice.qboPaymentRecorded:                                   │
│    syncWithRetry('qbo.record_payment', () =>                       │
│      recordQboPayment({ customer, invoice, amount, paymentRef }))  │
│    on success → set qboPaymentRecorded=true, qboPaymentId=<id>     │
│    on failure → push msg to syncErrors[], keep flag false          │
└────────────────────────────────────────────────────────────────────┘

┌──────── 2. SHOPIFY ────────────────────────────────────────────────┐
│  if !invoice.shopifyMarkedPaid:                                    │
│    syncWithRetry('shopify.mark_paid', () =>                        │
│      markShopifyOrderPaid({ shop, shopifyOrderId }))               │
│    on success → set shopifyMarkedPaid=true, shopifyMarkedPaidAt    │
│    "Already paid" userError is treated as success (idempotent)     │
└────────────────────────────────────────────────────────────────────┘

┌──────── 3. shopify_orders local doc ───────────────────────────────┐
│  ShopifyOrder.findOneAndUpdate({ _id: invoice.orderRef }, { $set:  │
│    paymentStatus:    'paid' | 'pending'  (partial),                │
│    financialStatus:  'paid' | 'partially_paid',                    │
│    processingStatus: 'completed'  (when paymentStatus=paid),       │
│    paidAt, completedAt, nmiTransactionId, shopifyPaidSyncedAt,     │
│  })                                                                │
└────────────────────────────────────────────────────────────────────┘
```

`syncWithRetry` = 3 attempts with exponential backoff. `PermanentError`
(e.g. validation, auth) bypasses retry. Each side's success flag is
checked before the call so re-invocations only do the missing work.

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
| `NMI_TEST_CCNUMBER` | (optional) | Dev test card number (sandbox only) |
| `NMI_TEST_CCEXP` | (optional) | Dev test card expiry MMYY |
| `NMI_TEST_CVV` | (optional) | Dev test card CVV |
| **Invoicing** | | |
| `INVOICE_TERMS_DAYS` | `15` | Days from order date to invoice due date — sent as `DueDate` to QBO (overrides any customer-level SalesTerm) |
| `INVOICE_FEE_RATE_CARD` | `0.03` | Per-method processing fee (decimal): card. Appended as a line at settlement when an NMI card charge approves or the cheque → card admin fallback runs. `0` disables. |
| `INVOICE_FEE_RATE_ACH` | `0.01` | Per-method processing fee (decimal): ACH. Appended on `kind='ach'` manual receipts. `0` disables. |
| `INVOICE_FEE_RATE_CHECK` | `0` | Per-method processing fee (decimal): cheque. Defaults to no fee. |
| **Payments** | | |
| `PAYMENT_CHARGE_IMMEDIATELY` | `false` | `true` = NMI charge in webhook process |
| `PAYMENT_MAX_RETRY_ATTEMPTS` | `6` | Cap on NMI charge attempts per invoice |
| `PAYMENT_SCHEDULE_TZ` | `America/Los_Angeles` | Cron timezone |
| `PAYMENT_RETRY_CRON_PRIMARY` | `30 0 15 * *` | Primary monthly cron expression |
| `PAYMENT_RETRY_CRON_SECONDARY` | `30 0 L * *` | Secondary monthly cron expression |
| `PAYMENT_RETRY_INTERVAL` | (unset) | Dev override, e.g. `30 seconds` |
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
| `invoices` | `models/invoice.server.js` | Local invoice mirror + sync state; carries `paymentMethod` (active, mutable), `customerPaymentPreference` (immutable order-time snapshot), `paymentSettledVia` + `paymentSettledAt` (recorded on each successful payment), `qboDueDate`, and `manualPayments[]` ledger |
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
