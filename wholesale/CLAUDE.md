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
| NMI vault add + sale | ✅ | card path; ACH transport supported but not used in CRON |
| Scheduler PASS 1 (auto-charge) | ✅ | card-only via `paymentMethod: 'card'` filter (§9.2) |
| Scheduler PASS 2 (sync retry) | ✅ | method-agnostic |
| Admin Retry payment (card) | ✅ | `/api/admin/orders/:id/retry-payment` |
| Admin Mark cheque paid | ✅ | `/api/admin/orders/:id/mark-cheque-paid` — records `manualPayments[]`, propagates to QBO + Shopify |
| Admin Charge card fallback (cheque → card) | ✅ | `/api/admin/orders/:id/charge-card` — flips invoice method only |
| Pending-approval replay | ✅ | `replayPendingOrdersForCustomer` on customer approve |

## Changelog

- **2026-05-21** — Cheque/ACH workflow: invoices carry `paymentMethod` (locked at creation from `CustomerMap.paymentMethod`, which is sourced from `wholesale_applications.payment.method`). CRON scheduler now skips non-card invoices. Order Details page exposes "Mark cheque paid" (records cheque ref + propagates to QBO + Shopify) and "Charge card on file" (per-invoice override) for cheque/ACH invoices. New audit outcome `manual_paid`. Spec details in [INTEGRATIONS.md §9](wholesale/INTEGRATIONS.md), gating in §11.1, admin endpoints in §11.4, edge cases §22.11–22.12.

> **Heads up:** this file contains unresolved git merge conflict markers (lines around 96/104/151 and 192/193/196). They predate the changes in this entry — flagging so they can be resolved separately. The §4 Implementation Status / §6 Maintenance protocol / §8 Changelog headings referenced elsewhere were lost in the conflict; the snapshot + changelog above are a temporary stand-in until the conflict is cleaned up.
