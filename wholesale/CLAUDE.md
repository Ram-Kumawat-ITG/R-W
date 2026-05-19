# Natural Solutions Wholesale App — Project Spec & Memory

> **Read this first.** This is the canonical project spec. Any developer
> or AI agent joining this project must read this file before writing
> code. For full technical detail, also read [INTEGRATIONS.md](./INTEGRATIONS.md)
> — that file is the deep spec (architecture, flows, env, edge cases).

---

## 1. What this app does

Turns a new Shopify order into a paid QuickBooks Online (QBO) invoice
via the NMI payment gateway, on a scheduled cadence.

```
Shopify orders/create webhook
   → QBO invoice (pending)
   → Scheduler tick (30s dev / 15th + last day of month in prod)
   → NMI charge against stored Customer Vault
   → on approved: QBO invoice marked Paid + Shopify order marked Paid
   → on declined: retry next tick up to PAYMENT_MAX_RETRY_ATTEMPTS (6)
```

Three external systems, one orchestrator. Failures isolated per side.

## 2. Stack

- **App**: React Router 7 (Remix-style) on Node 20+
- **DB**: MongoDB via Mongoose 9
- **Scheduler**: Agenda 5 (MongoDB-backed cron + interval jobs)
- **Auth**: Shopify offline sessions in MongoDB session storage
- **Integrations**: QBO (OAuth2 + rotating refresh tokens), NMI (form-encoded REST + Customer Vault)

## 3. Where things live

```
wholesale/app/
  api/                                ← INBOUND HTTP route handlers (thin), explicitly mapped in routes.js
    registration-form.js                /api/registration-form
    admin-*.js                          /api/admin/customers/...
  services/                           ← All server-side logic, organized service-wise
    APIService/                         ← Shared foundation
      mongo.service.js                    MongoDB connection (was db.server.js)
      api.service.js                      sendResponse + common response helpers
      http.service.js                     fetch wrapper with retry + classify
    shopify/                            shopify.service|apis|queries|mutations|utils|constants|config
    qbo/                                qbo.service|apis|utils|constants|config
    nmi/                                nmi.service|apis|utils|constants|config
    payment/                            payment.service|config (charge orchestration on top of nmi)
    customer/                           customer.service|utils + paymentDetails.service
    invoice/                            invoice.service|utils (creation + propagateSuccessfulPayment)
    order/                              order.service (orchestrator) + order.validator
    scheduler/                          scheduler.service + scheduler.config + jobs/
  utils/                              ← Global utilities (cross-service)
    env.utils.js                        readEnv / readInt / readBool
    logger.utils.js                     structured logger
    retry.utils.js                      retry() + PermanentError / TransientError
  configs/index.js                    ← Boot-time config aggregator (re-exports + assertions)
  models/                             ← Mongoose schemas only (no business logic)
  routes/                             ← UI / admin pages + webhook handlers (file-based routing)
    webhooks.orders.create.jsx        ← Shopify orders/create webhook (POST /webhooks/orders/create)
    webhooks.app.uninstalled.jsx      ← Shopify app lifecycle (pre-existing template)
    webhooks.app.scopes_update.jsx
```

**Per-service file convention.** Each service folder under `services/<svc>/`
uses a consistent file split:

- `<svc>.service.js` — domain methods the rest of the app calls
- `<svc>.apis.js` — HTTP plumbing for outbound integrations (auth, retry, error classification)
- `<svc>.queries.js` / `<svc>.mutations.js` — GraphQL strings (Shopify only)
- `<svc>.config.js` — service-specific env-driven config + asserts
- `<svc>.utils.js` — pure helpers used only by this service
- `<svc>.constants.js` — value constants for this service

Anything that's cross-service is global (`app/utils/`). Section 2 of
[INTEGRATIONS.md](./INTEGRATIONS.md) has the full file map.

## 4. Implementation status

| Module | Status | Notes |
|---|---|---|
| Shopify orders/create webhook handler | ✅ Complete | HMAC verified, 200 returned fast, fire-and-forget orchestrator |
| Order processing orchestrator (idempotent, 3 dedup layers) | ✅ Complete | webhook-id dedup → terminal-status return → atomic claim |
| Order payload validation (9 rejection codes) | ✅ Complete | PAYLOAD_INVALID, NO_EMAIL, NO_BILLING, ZERO_TOTAL, etc. |
| QBO OAuth2 token rotation + refresh coalescing | ✅ Complete | tokens persisted in `qbo_tokens` keyed by realmId |
| QBO customer find-or-create + invoice creation + payment recording | ✅ Complete | minor version 73 |
| NMI Customer Vault find/create (card + ACH) | ✅ Complete | form-encoded; sandbox/prod host switching |
| NMI sale transaction with vault id | ✅ Complete | response code parsing, full audit trail |
| Customer mapping (Shopify email ↔ QBO id ↔ NMI vault id) | ✅ Complete | unique index on (shop, email) |
| Claim-first invoice creation (duplicate-invoice fix) | ✅ Complete | unique index fires BEFORE QBO POST |
| Scheduler with dev interval + prod cron (15th + last) | ✅ Complete | timezone-aware, singleton bootstrap |
| Two-pass scheduler (charge pending + retry broken sync) | ✅ Complete | failure-isolated per side |
| Shopify orderMarkAsPaid via unauthenticated.admin offline session | ✅ Complete | "already paid" treated as success |
| Boot banner + critical-index verification | ✅ Complete | logs missing indexes loudly |
| Structured logger (JSON or pretty) | ✅ Complete | LOG_LEVEL + LOG_PRETTY |
| Payment-details resolver strategy registry | 🟡 Partial | `static-test-card` works; `wholesale-application` is a stub |
| Wholesale-application → vault token capture (Collect.js) | ⏳ Pending | Section 24 of INTEGRATIONS.md |
| Manual cheque / non-electronic payment flow | ⏳ Pending | Needs new resolver strategy + branch in attemptInvoiceCharge |
| Refund / void (refunds/create webhook → NMI refund + QBO credit memo) | ⏳ Pending | — |
| Per-shop QBO realms (multi-company support) | ⏳ Pending | Currently keyed on realmId only |
| Admin reconciliation UI (list invoices with `lastSyncError`) | ⏳ Pending | — |
| Backfill job (replay orders/list into pipeline) | ⏳ Pending | — |
| Promote `seenWebhookIds[]` to dedicated `webhook_events` collection | ⏳ Pending | Would let us dedup webhooks for not-yet-seen orders |

Legend: ✅ complete · 🟡 partial · ⏳ pending · ❌ blocked

## 5. Critical project rules

These are project laws — bend code to fit them, not the other way around:

1. **No direct `process.env.X` in business logic.** Add a key to the right per-service config (`services/<svc>/<svc>.config.js`) using helpers from `utils/env.utils.js`. The aggregator at `app/configs/index.js` exposes everything for boot validation.
2. **No QBO calls outside `services/qbo/`.** Same rule for NMI (`services/nmi/`) and Shopify Admin GraphQL (`services/shopify/`). Each integration is internally split: `<svc>.apis.js` does I/O, `<svc>.service.js` exposes domain methods, GraphQL strings live in `<svc>.queries.js` / `<svc>.mutations.js`.
3. **API handlers are thin.** Files under `app/api/` only do request validation, HMAC/auth, request/response shaping, and a single call into a service. All business logic lives in `services/`.
4. **Models are schema + indexes only.** Business logic lives in services.
5. **Idempotency lives in the data layer.** Unique indexes and atomic `findOneAndUpdate` — not just application checks. The duplicate-invoice bug fix in §13.4 of INTEGRATIONS.md is the canonical example.
6. **Webhook handler returns 200 immediately.** Downstream work is fire-and-forget; never block on it.
7. **NMI sandbox key on production host (or vice versa) returns "Authentication Failed".** Always match `NMI_ENVIRONMENT` to the key. Same for QBO.
8. **Test cards are sandbox-only.** `assertSafeTestCardConfig()` scrubs `NMI_TEST_*` env vars at boot if `NMI_ENVIRONMENT !== 'sandbox'`.
9. **Never amend commits or force-push.** Create new commits; preserve history.

## 6. Maintenance protocol — UPDATE THIS FILE ON EVERY MEANINGFUL CHANGE

Any change that affects future work — new flow, new env var, new integration,
schema change, behavior change, new failure mode, lifted limitation — must
ship with a doc update in the same change set. Specifically:

- **New env var, integration, route, or schema field** → add it to the
  relevant section of [INTEGRATIONS.md](./INTEGRATIONS.md).
- **New module shipped or moved from 🟡/⏳ to ✅** → update the
  Implementation Status table in §4 above.
- **Behavior change in an existing flow** → edit the affected section of
  [INTEGRATIONS.md](./INTEGRATIONS.md). Don't add a new section that
  contradicts the old one.
- **New edge case discovered + handled** → add to §22 of [INTEGRATIONS.md](./INTEGRATIONS.md).
- **Always**: add a one-line entry to the Changelog (§8 below) — date,
  short summary, link to affected sections.

If a change is too small to warrant a doc edit (whitespace, comment
fix), skip the doc update. Use judgement.

## 7. Quick reference

### Common dev commands
```bash
npm install                          # one-time
shopify app dev                      # local dev with tunnel
shopify app deploy --config=<name>   # push webhook + scope changes
npm run lint
npm run typecheck
```

### First-boot env minimum
`MONGODB_URI`, `SHOPIFY_*` (CLI-managed), `QBO_CLIENT_ID`,
`QBO_CLIENT_SECRET`, `QBO_REALM_ID`, `QBO_REFRESH_TOKEN`,
`NMI_SECURITY_KEY`. Full table in §16 of [INTEGRATIONS.md](./INTEGRATIONS.md).

### Boot-time health checks
- Banner prints every relevant env var (secrets masked).
- `[boot] index OK` lines confirm the two unique indexes built. `[boot] index MISSING` means cleanup needed — see §22.4.
- Scheduler mode is printed on the last banner line (`DEV MODE — every 30 seconds` or cron expressions).

### Production deployment gate
Checklist in §23.3 of [INTEGRATIONS.md](./INTEGRATIONS.md). Don't ship
without it — the test-card / sandbox-key combo is the most common foot-gun.

## 8. Changelog

Append-only. Newest at top. One-line summaries; link to section for detail.

- **2026-05-19** — Moved the Shopify webhook handler back to `app/routes/webhooks.orders.create.jsx` (file-based routing), matching the sibling `webhooks.app.*.jsx` convention. Removed the explicit `route()` declaration from `app/routes.js`. `app/api/` is now reserved for non-webhook inbound REST endpoints (admin-* + registration-form). URL `/webhooks/orders/create` unchanged.
- **2026-05-19** — Major service-oriented restructure. Each integration
  service now has a consistent file split (`<svc>.service.js` /
  `<svc>.apis.js` / `<svc>.queries.js` / `<svc>.mutations.js` /
  `<svc>.config.js` / `<svc>.utils.js` / `<svc>.constants.js`).
  Created `services/APIService/` shared foundation (mongo + http + api
  helpers). New `services/payment/` extracted from the old invoice service
  for charge orchestration. Renamed domain folders to singular
  (`customers/` → `customer/`, `invoices/` → `invoice/`, `orders/` → `order/`).
  Moved `routes/webhooks.orders.create.jsx` → `api/webhook/shopify-order-create.js`.
  Global utils moved to `app/utils/` (`logger.utils.js`, `retry.utils.js`,
  `env.utils.js`). Boot config aggregator at `app/configs/index.js`.
  See §3 above for the new layout and §5 for updated project rules.
  ~25 new files, 26 deletions, ~14 caller updates. All `node --check`
  passes; zero stale path references in app code.
- **2026-05-19** — Initial canonical spec consolidated into `CLAUDE.md`.
  `INTEGRATIONS.md` remains the deep technical reference.
- **(prior)** — See git log on branch `QBO_and_NMI` for the build-out of
  the QBO + NMI + Shopify pipeline.
