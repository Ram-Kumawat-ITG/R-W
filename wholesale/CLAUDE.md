# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

This repository contains a single Shopify app workspace. All code lives under [wholesale/](wholesale/) — the repo root holds only this file and `.git`. Inside `wholesale/` are three independently-deployable pieces:

| Piece | Path | Purpose |
|---|---|---|
| **Shopify app** (server) | `wholesale/` | React Router 7 (Remix-style) Shopify embedded admin app + webhook handlers + scheduler |
| **Registration form** (embedded) | `wholesale/registration-form/` | Standalone Vite + React 19 + MUI form, built into the theme extension's `assets/` |
| **Theme extension** | `wholesale/extensions/theme-extension/` | Shopify theme app extension that exposes the registration form as a storefront block |

Two `package.json` files; treat them as separate workspaces. Most work happens in `wholesale/`.

## Primary spec — read first for non-trivial work

[wholesale/CLAUDE.md](wholesale/CLAUDE.md) is the canonical project spec. It covers the wholesale app's purpose, stack, implementation status (✅ / 🟡 / ⏳), critical project rules, and the **maintenance protocol** that requires spec updates alongside meaningful code changes.

[wholesale/INTEGRATIONS.md](wholesale/INTEGRATIONS.md) is the deep technical reference (~1,400 lines, 24 sections) for the Shopify → QBO → NMI order-to-payment pipeline. Architecture, end-to-end flow, scheduler logic, error taxonomy, env vars, collections, edge cases, deployment.

Open both before touching webhook, orchestrator, integration, or scheduler code.

## Commands

All commands run from `wholesale/` unless noted. Node 20.19+ / 22.12+ required (`engines` in `package.json`).

### Shopify app (wholesale/)

```bash
npm install                      # install deps
shopify app dev                  # local dev with auto-tunnel (preferred)
npm run dev                      # alias for above
npm run build                    # production build via react-router build
npm run start                    # serve a prebuilt bundle (react-router-serve)
npm run lint                     # ESLint over the app
npm run typecheck                # react-router typegen + tsc --noEmit
npm run deploy                   # shopify app deploy — pushes webhooks + scopes + extensions
npm run config:use <config>      # switch between shopify.app.*.toml profiles
npm run config:link              # link to a Partners app
shopify app webhook trigger \    # synthetic webhook (useful while orders/create approval pending)
  --topic=orders/create \
  --api-version=2025-07 \
  --address=https://<tunnel>/webhooks/orders/create
```

`npm run predeploy` runs automatically before `deploy` and triggers `build:theme` (see below).

### Registration form (wholesale/registration-form/)

Driven by Vite. Build output lands in the theme extension's `assets/` so the storefront block can load it.

```bash
npm install                      # from inside registration-form/
npm run dev                      # Vite dev server (port 5173)
npm run build                    # production build → theme-extension/assets/
npm run lint
npm run preview                  # serve the built bundle locally
```

Or, from `wholesale/`:

```bash
npm run build:theme              # equivalent to `npm --prefix registration-form run build`
```

### Theme extension

Deployed via `shopify app deploy` (along with the Shopify app and any other extensions).

## Architecture — the big picture

### Order-to-payment pipeline (the critical path)

The Shopify app's reason for existing: turn new Shopify orders into paid QBO invoices via NMI.

```
Shopify orders/create webhook  →  routes/webhooks.orders.create.jsx   (URL: /webhooks/orders/create, file-based)
   → services/order/order.service.js     (idempotent orchestrator)
       → services/customer/customer.service.js   (QBO find-or-create + NMI vault find-or-create)
       → services/invoice/invoice.service.js     (claim-first invoice creation, calls services/qbo/qbo.service.createInvoice)
   → scheduler tick (Agenda 5; 30s in dev, cron 15th+last in prod)
       → services/scheduler/jobs/processPendingPayments.job.js
           PASS 1: services/payment/payment.service.chargeInvoice  (NMI charge for pending invoices)
           PASS 2: services/invoice/invoice.service.propagateSuccessfulPayment  (re-sync paid invoices)
   → propagateSuccessfulPayment
       → services/qbo/qbo.service.recordPayment + services/shopify/shopify.service.markOrderPaid + DB update
```

Three idempotency layers prevent duplicate invoices:
1. **Webhook-id dedup** — `seenWebhookIds[]` on the ShopifyOrder doc catches Shopify's at-least-once retries.
2. **Atomic claim** — `findOneAndUpdate({ processingStatus: { $in: claimable } }, $set: 'processing' })`. Loser exits.
3. **Claim-first Invoice insert** — `Invoice.create({ qboInvoiceId: null, qboCreationStatus: 'claimed' })` fires the unique `(shop, shopifyOrderId)` index **before** the QBO POST. Losers `waitForClaimToComplete` (poll up to 30s). This is the structural fix for the user-reported duplicate-invoice bug — see [wholesale/INTEGRATIONS.md §13](wholesale/INTEGRATIONS.md).

<<<<<<< HEAD
### Module boundaries (project laws)

- No `process.env.X` outside service config files. Add new env keys to the right per-service config in [services/<svc>/<svc>.config.js](wholesale/app/services), using `readEnv` / `readInt` / `readBool` from [utils/env.utils.js](wholesale/app/utils/env.utils.js). Boot aggregator lives at [app/configs/index.js](wholesale/app/configs/index.js).
- No QBO calls outside `services/qbo/`. Same rule for `services/nmi/` and `services/shopify/`. Each integration is internally split: `<svc>.apis.js` owns I/O, `<svc>.service.js` exposes domain methods, GraphQL strings live in `<svc>.queries.js` / `<svc>.mutations.js`.
- API handlers in [app/api/](wholesale/app/api) are thin: validate, auth, call a service, respond. All business logic lives in `services/`.
- Models in `app/models/` are schema + indexes only.
- Errors are typed as `PermanentError` or `TransientError` ([utils/retry.utils.js](wholesale/app/utils/retry.utils.js)) so retry layers can decide. QBO + NMI clients retry transients up to `HTTP_RETRY_ATTEMPTS` (default 4); the scheduler retries NMI charges up to `PAYMENT_MAX_RETRY_ATTEMPTS` (default 6).
=======
### Wholesale registration form feature

A separate flow from the order pipeline. Storefront customers fill out a 3-step form embedded via the theme extension; approved applicants become Shopify wholesale customers.

```
Storefront Liquid block
  → registration-form/ React SPA (Vite, 3-step react-hook-form + Yup)
      Step 1 — name, email, phone, password, credentials (+ file uploads), referral
      Step 2 — billing/shipping address, tax info
      Step 3 — payment method, signature, terms
  → POST /api/registration-form  (Shopify app proxy: authenticate.public.appProxy)
      → uploads files to Shopify Files API (stagedUploadsCreate → fileCreate → poll)
      → hashes password (scrypt) and card PAN (HMAC-SHA256 keyed by SHOPIFY_API_SECRET)
      → WholesaleApplication.create() in MongoDB
      → customerCreate() via Admin GraphQL → adds "Pending" tag, sends acknowledgment email
  → Admin dashboard (app.customers._index.jsx + app.customers.$id.jsx)
      → Review → adds "Approved" tag + sends invite via customerSendInvite
      → Decline → deletes Shopify customer + MongoDB doc
```

**Key files:**

| File | Role |
|---|---|
| `registration-form/src/RegistrationForm.jsx` | Form root; `useForm` with `mode:'onTouched'`, `reValidateMode:'onChange'`; step navigation |
| `registration-form/src/schema/step*.schema.js` | Yup schemas per step; `step*Fields` arrays used for partial validation on "Continue" |
| `registration-form/src/components/SignaturePad.jsx` | Draw (canvas + toBlob) or typed signature; blob stored via `savedBlobRef` and restored on remount |
| `registration-form/src/components/Dropzone.jsx` | File picker; `has-file` state renders a green card |
| `app/api/registration-form.js` | App proxy POST handler |
| `app/utils/shopifyNoteMap.js` | Canonical map of credential IDs → Shopify customer note keys (source of truth for both form and note builder) |
| `app/utils/buildShopifyNote.js` | Assembles the note string written to the Shopify customer record |
| `app/utils/shopifyCustomer.js` | `customerCreate` + `customerSendInvite` Admin GraphQL helpers |
| `app/routes/app.customers._index.jsx` | Admin list page (search, status filter chips, Review/Revoke/Decline actions) |
| `app/routes/app.customers.$id.jsx` | Admin detail page (all fields, signature image/text, payment, credentials, license files) |

**Registration form validation gotcha** — `credentials` and `referrals` use object-level `.test('one-selected', …)` in Yup. `reValidateMode:'onChange'` only re-validates the specific path that changed (e.g. `credentials.acupuncturist.selected`), not the parent object test. After any checkbox toggle, call `trigger('credentials')` / `trigger('referrals')` explicitly.

### Module boundaries (project laws)

- No `process.env.X` outside [services/config.server.js](wholesale/app/services/config.server.js). Required values are asserted at boot.
- No QBO calls outside `services/qbo/`. Same rule for `services/nmi/` and `services/shopify/`.
- Models in `app/models/` are schema + indexes only. Business logic lives in services.
- Errors are typed as `PermanentError` or `TransientError` ([services/retry.server.js](wholesale/app/services/retry.server.js)) so retry layers can decide. QBO + NMI clients retry transients up to `HTTP_RETRY_ATTEMPTS` (default 4); the scheduler retries NMI charges up to `PAYMENT_MAX_RETRY_ATTEMPTS` (default 6).
- **CSS only in `registration-form/src/styles/registration-form.css`** — never add `style={{}}` props or CSS classes to admin routes (`app/routes/app.*.jsx`). Admin UI uses Polaris web components (`s-*` tags) styled through their own props.
- **New admin API endpoints go in `app/api/`** and are registered manually in `app/routes.js` (not file-based routes). Follow the existing pattern: `route("/api/admin/customers/:id/action", "api/admin-action.js")`.
- **After any change to `registration-form/src/`**, run `npm run build:theme` from `wholesale/` to regenerate `extensions/theme-extension/assets/react-app-bundle.*`. The storefront loads the bundle from there; changes are invisible until rebuilt.
>>>>>>> f25e7c0c25b569010264e3d301afe4440a830172

### Boot sequence ([entry.server.jsx](wholesale/app/entry.server.jsx))

1. Mongo connect.
2. `verifyCriticalIndexes` — logs `[boot] index OK` / `[boot] index MISSING` for the two unique `(shop, shopifyOrderId)` indexes. Missing means duplicate rows are blocking the index build; cleanup script in INTEGRATIONS.md §22.4.
3. `assertSafeTestCardConfig` — scrubs `NMI_TEST_*` env vars if `NMI_ENVIRONMENT !== 'sandbox'`.
4. Boot banner — prints every relevant env var (secrets masked), URLs in use, scheduler mode. Use this to confirm config when something behaves unexpectedly.
5. `getAgenda()` — coalescing singleton; starts scheduler and registers `process-pending-payments` against current env (dev interval or prod cron).

### Session storage

Note: `prisma/schema.prisma` is template residue. Active session storage is **MongoDB** via `@shopify/shopify-app-session-storage-mongodb` (configured in [app/shopify.server.js](wholesale/app/shopify.server.js)), using the same `MONGODB_URI` as the app data. The Prisma session table is unused. The `npm run setup` script (`prisma generate && prisma migrate deploy`) is also legacy from the template — running it is harmless but doesn't affect production behavior.

### Webhook registration (two paths)

- **Declarative** (preferred once approved) — `[[webhooks.subscriptions]]` blocks in the active `shopify.app.<config>.toml`. Pushed by `shopify app deploy`.
- **Programmatic** — `ensureProtectedWebhooks` from [services/shopify/shopify.service.js](wholesale/app/services/shopify/shopify.service.js) runs from `app/routes/app.jsx`'s loader on every admin page load. Idempotent. Used when `orders/create` (a protected customer data topic) is awaiting Partners-dashboard approval.

## Configuration profiles

Multiple `shopify.app.*.toml` files exist:
- [shopify.app.toml](wholesale/shopify.app.toml) — default
- [shopify.app.dev-rk.toml](wholesale/shopify.app.dev-rk.toml) — developer-specific dev profile

Switch with `npm run config:use <name>`. The active profile drives `shopify app dev` / `shopify app deploy` and determines which Partners app is targeted.

## MCP servers configured for this repo

- [wholesale/.mcp.json](wholesale/.mcp.json) and [wholesale/.cursor/mcp.json](wholesale/.cursor/mcp.json) wire up the Shopify Dev MCP (used by Claude Code, Cursor, Copilot, Gemini CLI). Use the MCP's `search_docs_chunks`, `graphql_schema`, `validate_graphql_codeblocks` etc. when writing Shopify Admin GraphQL queries or mutations.

## Gotchas worth knowing up front

These are pulled from [wholesale/README.md](wholesale/README.md) and the integration-spec; they bite in non-obvious ways:

- **Embedded-app navigation** — inside the admin iframe, use `Link` from `react-router` (not `<a>`), use the `redirect` returned from `authenticate.admin` (not `react-router`'s `redirect`), and use `useSubmit` from `react-router`.
- **NMI sandbox vs production hosts** — sandbox keys are rejected on `secure.nmi.com` and vice versa. Always match `NMI_ENVIRONMENT` to the key. Same idea for QBO.
- **QBO refresh tokens rotate on every refresh** — they're seeded once from `QBO_REFRESH_TOKEN` env, then Mongo is the source of truth (`qbo_tokens` collection). Concurrent refreshes are coalesced via an in-flight promise.
- **Webhook handler returns 200 immediately.** Downstream work is fire-and-forget. Never block the webhook response on QBO/NMI calls.
- **`orders/create` is a protected customer data topic.** It requires Partners-dashboard approval. Until then, use synthetic webhook triggers and the programmatic registration path.
- **Windows + Prisma ARM64 error** — if you hit `query_engine-windows.dll.node is not a valid Win32 application`, set `PRISMA_CLIENT_ENGINE_TYPE=binary`. (Mostly irrelevant since session storage is MongoDB now, but the Prisma client still initializes.)
<<<<<<< HEAD
=======
- **Polaris `s-button icon="…"` accepts only exact names from `privateIconArray`** — valid examples: `"check"`, `"undo"`, `"delete"`, `"arrow-left"`. `"checkmark"` is not valid and silently shows no icon. Check `node_modules/@shopify/polaris-types/dist/polaris.d.ts` line ~203 for the full list.
- **React Router 7 auto-revalidates loaders after every fetcher action** — do not call `revalidator.revalidate()` manually inside a `useEffect` that has `revalidator` in its dep array; the reference changes on each state transition and causes an infinite loop. Remove the manual call and rely on auto-revalidation.
>>>>>>> f25e7c0c25b569010264e3d301afe4440a830172

## When updating code, update the spec

The maintenance protocol in [wholesale/CLAUDE.md §6](wholesale/CLAUDE.md) requires that meaningful code changes ship with corresponding updates to `wholesale/CLAUDE.md` (status table + changelog) and `wholesale/INTEGRATIONS.md` (affected sections). This is per the project owner's explicit request. Trivial fixes (whitespace, comments) are exempt.

## Implementation status (snapshot)

This list focuses on the order-to-payment pipeline. Detailed flow lives in [wholesale/INTEGRATIONS.md](wholesale/INTEGRATIONS.md).

| Module | Status | Notes |
|---|---|---|
| Shopify orders/create webhook ingest | ✅ | `app/routes/webhooks.orders.create.jsx` → `processShopifyOrder` |
| QBO customer + invoice creation | ✅ | claim-first invoice insert (§13.4) |
| NMI vault add + sale | ✅ | vault `add_customer` happens ONCE at registration (`api/registration-form.js`); order/payment flows only read + validate the stored id (`customer.service` mirror + `validateCustomerVault` pre-flight in `chargeInvoice`). Card path; ACH transport supported but not used in CRON |
| Scheduler PASS 1 (auto-charge) | ✅ | card-only via `paymentMethod: 'card'` filter (§9.2) |
| Scheduler PASS 2 (sync retry) | ✅ | method-agnostic |
| Admin Retry payment (card) | ✅ | `/api/admin/orders/:id/retry-payment` |
| Admin Mark cheque paid | ✅ | `/api/admin/orders/:id/mark-cheque-paid` — records `manualPayments[]`, propagates to QBO + Shopify |
| Admin Charge card fallback (cheque → card) | ✅ | `/api/admin/orders/:id/charge-card` — flips invoice method only |
| Partial payments | ✅ | Status flows `pending → partially_paid → paid` via `deriveInvoicePaymentStatus`; cheque receipts + card retries both support `amount` arg |
| Pending-approval replay | ✅ | `replayPendingOrdersForCustomer` on customer approve |
| `orders/cancelled` webhook | ✅ | `routes/webhooks.orders.cancelled.jsx` → `handleOrderCancelled`. Order doc flips to `processingStatus: 'cancelled'`, linked invoice to `paymentStatus: 'cancelled'`, QBO invoice voided when `amountPaid === 0` (skipped for paid/partially-paid invoices). CRON auto-skips via existing `paymentStatus: 'pending'` filter. |

## Changelog

- **2026-05-25** — Fixed Order List showing "Processing: Scheduled / Payment: In progress" after a successful card-fallback charge on a partially-paid invoice. Root cause: `deriveInvoicePaymentStatus` treated `'in_progress'` as sticky. `chargeInvoice` writes `paymentStatus='in_progress'` as a transient lock before the NMI sale and calls `applyDerivedPaymentStatus(invoice)` right after the charge to release it — but the sticky check returned `'in_progress'` unchanged, so the status never transitioned to `'paid'` even though `amountPaid` now equaled `amountDue`. Cascading effect: `propagateSuccessfulPayment`'s `if (invoice.paymentStatus === 'paid')` branch never fired, so `ShopifyOrder.processingStatus` stayed `'scheduled'` and `paidAt` / `completedAt` were never set. Fix: removed `'in_progress'` AND `'failed'` from the sticky set in `deriveInvoicePaymentStatus` (only `'cancelled'` remains sticky — the only state with admin / webhook intent that should resist amount-based derivation). `'in_progress'` is a transient lock managed by `chargeInvoice` itself; deriving after the charge IS the lock release. `'failed'` no longer being sticky means a manual cheque receipt landing on a previously-failed invoice correctly transitions to `partially_paid` / `paid` since the money actually arrived — CRON PASS 1's `paymentStatus: 'pending'` filter still prevents auto-charge retries. Recovery for existing stuck invoices: added a self-heal at the top of `propagateSuccessfulPayment` (re-derives status before any downstream work) and expanded CRON PASS 2's sweep cursor to include `'in_progress'`. The race between the sweep and a truly in-flight chargeInvoice is benign — propagate's diff-against-cumulative sync never posts duplicates, and chargeInvoice's own save() runs after the loop. Spec: INTEGRATIONS.md §11 (status derivation rules).

- **2026-05-25** — Fixed "Charge card on file" button incorrectly disabled when a vault exists. `customer_maps.nmiCustomerVaultId` is just a cache populated at order intake; the source of truth is `wholesale_applications.nmiCustomerVaultId`. If a customer captured a card after their order was processed (or for orders pre-dating the cumulative-sync customer.service refactor), the cache was empty while the source had the real vault id, so the Order Details page's `canChargeCard = !!customerMap?.nmiCustomerVaultId` gating disabled the button and `charge-card.js` / `retry-payment.js` returned 409. New helper `customer.service.resolveCustomerVaultId({ shop, email, customerMap })` — fast-paths the cache hit, falls through to wholesale_applications on miss, and lazily syncs the cache back so the next reader sees the resolved id. Wired into the Order Details loader (button-gating self-heals) + both admin charge endpoints (lazy-sync the in-memory map so `chargeInvoice`'s downstream read picks up the resolved id). New "No card on file" warning banner replaces the previous subdued one-liner so admins see immediately when this customer truly has no saved card vs. when the cache was just stale. Spec: INTEGRATIONS.md §6.

- **2026-05-25** — Fixed duplicate-QBO-payment bug caused by non-idempotent retries. Symptom: one local `recordManualPayment` call (one `PaymentAttempt` row, $15 cheque) but TWO `Payment` records on the QBO invoice (Balance shows $1 instead of $16 against a $31 invoice). Root cause: `qbo.apis.qboRequest` wraps `rawRequest` in a transient-error retry loop (default 4 attempts), and `propagateSuccessfulPayment` adds another `syncWithRetry` (3 attempts) on top. When QBO's POST `/payment` committed server-side but the response was slow / hit a 502 / dropped a TCP packet on the way back, the retry layer fired the POST a second time — QBO had no way to know it was a retry and cheerfully created a duplicate. Fix: pass QBO's documented `requestid` idempotency token on every POST. New helper generates one UUID per logical `qboRequest()` call (before the retry loop) and threads it through `rawRequest` and the 401-refresh recursion, so all internal retries share the same id and QBO dedups them server-side. Only mutating verbs (POST/PUT) get the id — GETs / queries are inherently idempotent. Callers can pin a specific id via `opts.requestId` for cross-process idempotency (e.g. resuming a crashed job). Spec: INTEGRATIONS.md §7 (QBO transport).
- **2026-05-25** — `orders/cancelled` webhook integrated. New route `routes/webhooks.orders.cancelled.jsx` and orchestrator `services/order/order.service.handleOrderCancelled` mirror the create-handler shape (HMAC verify, fire-and-forget, idempotent on `seenWebhookIds[]`). Effects: upserts the local `ShopifyOrder` to `processingStatus: 'cancelled'` (covers the case where the cancel webhook beats the create webhook); flips any linked `Invoice.paymentStatus → 'cancelled'`; voids the QBO invoice via new `qbo.service.voidInvoice` ONLY when `amountPaid === 0` (paid/partially-paid invoices are left intact so the admin can decide on a refund manually); appends a `system_note` remark to the invoice timeline. New `ShopifyOrder` fields: `cancelledAt`, `cancelReason`; new enum value `'cancelled'` on `processingStatus`. CRON skip is automatic — PASS 1's existing `paymentStatus: 'pending'` filter excludes `'cancelled'`. Race protection: `processShopifyOrder` re-fetches `cancelledAt` immediately after invoice creation and aborts (cancelling + voiding the just-created invoice) if the cancel webhook ran during processing — handles the narrow window where the cancel webhook flips the order while create is mid-flight and `local.save()` would otherwise overwrite `cancelled → invoiced`. Subscription registered both declaratively (in the dev-rk profile) and programmatically (in `shopify.constants.REQUIRED_SUBSCRIPTIONS` — covers the protected-customer-data approval gap on the default profile). UI: `ProcessingBadge` gains a `cancelled` tone (default/grey); Order List adds a "Cancelled" filter chip. Spec: INTEGRATIONS.md §4 + §5 (cancellation flow).

- **2026-05-25** — Removed refund + cancel-invoice functionality per scope change. Dropped: `POST /api/admin/orders/:id/refund` + `POST /api/admin/orders/:id/cancel-invoice` endpoints; `invoice.service.refundInvoice` + `cancelInvoice` orchestrators; `qbo.service.recordRefund` (RefundReceipt); `shopify.service.refundShopifyOrder` + `MUTATION_REFUND_CREATE` + `QUERY_ORDER_REFUNDABLE`; the `Invoice.refunds[]` ledger, `Invoice.amountRefunded`, `Invoice.cancelledAt/By/Reason` fields; the `partially_refunded` / `refunded` enum values from `Invoice.paymentStatus`; Refund + Cancel UI (buttons, modals, fetchers, ledger card, cancellation banner, Refunded/Refundable summary KVs) from Order Details; `partially_refunded` / `refunded` badge tones from `admin-ui.PaymentStatusBadge` + Order List `PaymentBadge`. `nmi.service.refundTransaction` reverted to its original simpler form (still exported as an admin-tooling helper but no caller wires it up). Partial-payment support (the `partially_paid` status + cumulative QBO/Shopify sync — `qboRecordedTotal`, `qboPaymentIds[]`, `shopifyRecordedTotal`, `shopifyTransactionIds[]`, `recordOrderTransaction` REST helper) is RETAINED — that was a separate requirement, not part of the refund/cancel scope being rolled back. Spec: INTEGRATIONS.md §9 (removed §9.6 + §9.7 + §9.8 — derivation lives in code now).

- **2026-05-25** — Multi-payment downstream sync — each partial payment now lands its own QBO `Payment` record and its own Shopify SALE transaction, instead of being skipped after the first one. Root cause of the prior bug: `propagateSuccessfulPayment` gated QBO's `recordPayment` on the single boolean `qboPaymentRecorded`, so the second cheque receipt's call short-circuited and QBO's invoice balance stayed at the partial. New Invoice fields: `qboRecordedTotal` + `qboPaymentIds[]` (cumulative QBO sync state) and `shopifyRecordedTotal` + `shopifyTransactionIds[]` (cumulative Shopify sync state). Each propagate call now records the DIFFERENCE between `amountPaid` and what's already been booked on each side. New Shopify path: `shopify.service.recordOrderTransaction` posts a manual SALE transaction via Admin REST (`/admin/api/{version}/orders/{id}/transactions.json`) for every partial — Shopify's `displayFinancialStatus` updates to `partially_paid` / `paid` as transactions accumulate. `orderMarkAsPaid` still fires once on full settlement (idempotent — Shopify returns "already paid" when transactions already cover the total) so downstream Shopify workflows still trigger. Backward-compat: legacy invoices with `qboPaymentRecorded: true` (or `shopifyMarkedPaid: true`) but no cumulative total backfill `qboRecordedTotal`/`shopifyRecordedTotal` from `amountPaid` on first propagate so they don't double-record. CRON PASS 2 cursor expanded with `$expr`-based cumulative-mismatch checks so any invoice (paid OR partially_paid OR partially_refunded) with unsynced amount gets re-swept. New low-level helper `shopify.apis.shopifyRestPost` (Shopify Admin GraphQL has no equivalent mutation for manual SALE recording on orders without an existing AUTHORIZATION). Spec: INTEGRATIONS.md §12 (rewritten — partial-payment sync).

- **2026-05-25** — Partial payments, refunds, and admin-cancel are first-class. `Invoice.paymentStatus` enum extended with `partially_paid`, `partially_refunded`, `refunded`; transitions go through a single derivation helper `deriveInvoicePaymentStatus` (`invoice.utils.js`) so no service ever sets the status ad-hoc. New schema: `Invoice.refunds[]` (per-refund kind/amount/NMI+QBO+Shopify sync flags), `Invoice.amountRefunded` (denormalized), `Invoice.cancelledAt/By/Reason`. New endpoints: `POST /api/admin/orders/:id/refund` (NMI refund against most-recent approved sale, falls back to manual ledger when no NMI sale exists; QBO `RefundReceipt`; Shopify `refundCreate`) and `POST /api/admin/orders/:id/cancel-invoice` (flips `paymentStatus → 'cancelled'`; CRON auto-skips via the existing `paymentStatus: 'pending'` filter). `retry-payment.js` now accepts an optional `amount` body for partial card charges; `chargeInvoice` clips against remaining outstanding and only stages the processing-fee line on the charge that actually settles. Order Details surfaces Refund + Cancel buttons (with eligibility flags `canRefund` / `canCancel`), a Refundable KV, a refunds ledger card, and a cancellation banner. Shopify `orderMarkAsPaid` only fires on full settlement now — partials sync the local mirror with `financialStatus: 'partially_paid'` and defer the Shopify mark-paid call. Spec: INTEGRATIONS.md §6, §9, §11 (refund flow + cancel flow), §17 (Invoice collection schema).

- **2026-05-25** — `ProcessingBadge` now swaps its label when an order's `processingStatus === 'scheduled'` but the linked invoice's `paymentMethod` is `check` or `ach`. Cheque invoices render **"Awaiting cheque"** (warning tone) and ACH invoices render **"Awaiting ACH"** — "Scheduled" implied CRON auto-charge, which is misleading since the scheduler intentionally skips non-card invoices (§9.2). Card invoices still render "Scheduled" as before. Implementation: optional `paymentMethod` prop on `components/admin-ui.ProcessingBadge`; passed from both the Order List (`app.orders._index.jsx`) and Order Details (`app.orders.$id.jsx`). No model / API / scheduler changes.

- **2026-05-25** — NMI Customer Vault is now created **exactly once per customer**, at wholesale-registration submit (`app/api/registration-form.js`). Every downstream flow reads through `wholesale_applications.nmiCustomerVaultId` rather than re-creating: `customer.service.ensureCustomerForOrder` mirrors the id onto `CustomerMap.nmiCustomerVaultId` and validates it via the new `validateCustomerVault(vaultId)` helper (`query.php?report_type=customer_vault&customer_vault_id=…`); `payment.service.chargeInvoice` re-runs the same pre-flight before every NMI sale and writes a `skipped` PaymentAttempt with `"NMI vault X invalid: …"` if the id no longer resolves (vault deleted out-of-band, env swap, etc.). Removed: `nmi.service.findOrCreateCustomerVault` call from `customer.service` (still exported for legacy/diagnostic use); the `paymentDetails.service.js` strategy registry + its dev-only static-test-card strategy (it only fed the now-dead vault-create path on the order side). `customer.service.ensureCustomerForOrder` no longer accepts a `paymentDetails` argument. Spec: INTEGRATIONS.md §6.3 (rewritten), §6.4 (new — vault sourcing), §8.3 (rewritten — three vault-facing helpers).

- **2026-05-22** — QBO invoice payload now includes `ShipAddr` and `ShipDate`. Address derived via `customer.utils.buildProfileFromShopifyOrder` (shipping → billing → customer default fallback) and projected through new `qbo.utils.toQboAddress`, which `BillAddr` on the customer payload now also uses. Ship date is `order.created_at` formatted to `YYYY-MM-DD` via new `invoice.utils.toYmd` (Shopify's `orders/create` fires pre-fulfillment, so the order date is the best ship-on marker). Both fields are omitted when no source data is available. Spec: INTEGRATIONS.md §7.3 + §18.3.
- **2026-05-22** — Card invoices now carry a "Credit Card Processing Fee – 3%" line, appended by `shopifyLinesToQboLines` on top of the products + shipping + tax subtotal. Rate is `INVOICE_CREDIT_CARD_FEE_RATE` (default `0.03`); set to `0` to disable. Cheque/ACH invoices never carry the fee, and the surcharge is locked at invoice creation — the cheque → card admin fallback does NOT retroactively add a fee line (existing QBO line items are immutable). New helper `readNumber` in `utils/env.utils.js`. Spec: INTEGRATIONS.md §7.3 + env table.
- **2026-05-22** — Processing-fee model reworked from creation-time / single-rate to **settlement-time / per-method**. Three rates: card=`INVOICE_FEE_RATE_CARD` (3% default), ACH=`INVOICE_FEE_RATE_ACH` (1% default), cheque=`INVOICE_FEE_RATE_CHECK` (0% default). The fee follows the actual settlement method, not the customer's preference — every settlement path (CRON auto-charge, admin retry, cheque → card fallback, manual ACH receipt) lands the correct fee. New: `qbo.service.appendInvoiceLines` (GET + sparse update of the Line array with fresh SyncToken), `invoice.utils.computeProcessingFee` / `buildProcessingFeeLine` / `findExistingProcessingFeeLine` / `processingFeeLabel`, Invoice model fields `processingFeeAmount/Rate/Method/AppliedAt`, and a read-only confirmation endpoint `POST /api/admin/orders/:id/preview-payment` ({ method } → `{ baseAmount, feeAmount, newTotal, ... }`) for admin "confirm before charge" flows. Fee is applied only on successful settlement: declined card attempts leave no fee line. Cheque-preferred customers paying by card via admin fallback now correctly get the 3%. Spec: INTEGRATIONS.md §7.3 (rewritten) + env table.
- **2026-05-22** — New `Invoice.remarks[]` ledger powers a **Remarks** column on the Order List page. Each CRON tick now writes one entry per touched invoice (PASS 1: card-charge outcome; new PASS 1.5: cheque/ACH reminder + failed-card follow-up) and every admin settlement action (retry, charge-card fallback, mark cheque/ACH paid) appends an `admin_action` entry tagged with the operator's email. Three new invoice-scoped filter chips on the list: **Overdue** (`qboDueDate < today` AND unpaid), **Pending cheque** (cheque/ACH unpaid), **Failed payments** (`paymentStatus: 'failed'`). The Remarks cell shows a red "Payment Due — $X · OVERDUE" header for unpaid cheque/ACH invoices, a "Payment Failed — N/M attempts" header for failed invoices, the latest remark message + date, and a "+N more" tail counter pointing to Order Details. New helper `invoice.service.appendInvoiceRemark`. No customer-facing notifications sent yet — log-only. Spec: INTEGRATIONS.md §11 + Collections table.
- **2026-05-22** — Added full-datetime `Invoice.dueAt` field + `INVOICE_TERMS_MINUTES` env testing knob. `dueAt = order.created_at + termsDays + termsMinutes`; set `INVOICE_TERMS_MINUTES=1` to make every new invoice flag as Overdue ~1 minute after creation (lets admins watch the Overdue indicator + cheque-reminder UI fire without waiting whole days). QBO's date-only `DueDate` still uses `termsDays` only — `termsMinutes` is local-only. New helper `invoice.utils.computeInvoiceDueAt`; the Order List Overdue filter + `RemarksCell` + `DueDateCell` now go through a shared `isOverdueByInvoice` predicate that prefers `dueAt` and falls back to `qboDueDate` for older invoices.


- **2026-05-21** — Cheque/ACH workflow: invoices carry `paymentMethod` (locked at creation from `CustomerMap.paymentMethod`, which is sourced from `wholesale_applications.payment.method`). CRON scheduler now skips non-card invoices. Order Details page exposes "Mark cheque paid" (records cheque ref + propagates to QBO + Shopify) and "Charge card on file" (per-invoice override) for cheque/ACH invoices. New audit outcome `manual_paid`. Spec details in [INTEGRATIONS.md §9](wholesale/INTEGRATIONS.md), gating in §11.1, admin endpoints in §11.4, edge cases §22.11–22.12.

> **Heads up:** this file contains unresolved git merge conflict markers (lines around 96/104/151 and 192/193/196). They predate the changes in this entry — flagging so they can be resolved separately. The §4 Implementation Status / §6 Maintenance protocol / §8 Changelog headings referenced elsewhere were lost in the conflict; the snapshot + changelog above are a temporary stand-in until the conflict is cleaned up.
