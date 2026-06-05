# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Session protocol — MUST FOLLOW

This file is the **single persistent memory** of every meaningful conversation that has happened on this project. The user has explicitly requested that nothing be lost across sessions. Two rules:

### Rule 1 — Read this file at the start of EVERY session

Before doing anything else in a new conversation about this repo, read this file in full. Pay special attention to the **Changelog** section at the bottom — recent entries describe what's working, what's broken, what decisions were locked in, and what follow-ups are still open. Do not assume anything about the codebase state from training data; trust the Changelog.

### Rule 2 — Update this file at the end of EVERY significant session

When you've done meaningful work in a conversation (built a feature, made an architectural decision, fixed a non-trivial bug, discovered a gotcha, agreed on a future direction), append a new dated entry to the **Changelog** before the session ends. The entry should capture:

- **What was built / changed** — files touched, what was added or removed
- **Why** — the decision and the alternatives that were rejected (so future-you understands the reasoning, not just the outcome)
- **Gotchas discovered** — anything that surprised us or wasted time
- **Open follow-ups** — things explicitly deferred ("we'll do X later") so they aren't forgotten

Tiny fixes (a typo, a one-line bug fix that's already obvious from `git log`) don't need a Changelog entry. Anything that changes how the system behaves, how someone should think about it, or what's allowed and disallowed, **does**.

Treat Changelog entries the same way you treat code: write them so a stranger walking in cold can pick up the work. Use tables, diagrams, and short prose — match the style of existing entries.

If a topic grows too large for the Changelog (e.g. a dedicated subsystem spec), create a separate markdown file in the repo and link it from here. Do not let CLAUDE.md become unreadable, but also do not fragment for the sake of fragmenting.

> User's exact request (2026-05-28): "abse hum jo bhi is chat me kam kre hum us file update krna h isi ke sath app harr roz is file ko read kroge taki track na badlo … me chata hu claude ke pass saare detail rhe aur ye kabhi na bhule mene isse kya baat ki h."

## Repository layout

The repo contains **two independent Shopify app workspaces** plus an embedded React SPA + theme extension under the wholesale workspace. Most ongoing work happens in `wholesale/`.

| Path | What it is |
|---|---|
| [wholesale/](wholesale/) | Primary Shopify app — React Router 7 admin app, webhook handlers, scheduler, registration form, theme extension, cross-store sync |
| [wholesale/registration-form/](wholesale/registration-form/) | Standalone Vite + React 19 SPA for the 3-step practitioner application; build output lands in the theme extension's `assets/` |
| [wholesale/extensions/theme-extension/](wholesale/extensions/theme-extension/) | Shopify theme app extension; storefront blocks (registration form, custom login email-check page) |
| [ns-retail/](ns-retail/) | Separate Shopify app installed on the **retail** store (mirror of wholesale catalog) |

The retail and wholesale stores are different Shopify shops. The wholesale app holds all cross-store sync logic (id maps in MongoDB, GraphQL mutations on wholesale, REST mutations on retail). The `ns-retail/` app exists for retail-specific concerns and is referenced from wholesale via shared-secret-authenticated webhooks (see "Cross-store sync" below).

> **Note:** `wholesale/CLAUDE.md` contains the canonical project spec but currently has **unresolved git merge conflict markers** (lines around 96/104/151). Either file may be opened by Claude Code — the conflict needs cleanup. Treat the content on both sides of the markers as historically valid.

## Primary specs

- [wholesale/CLAUDE.md](wholesale/CLAUDE.md) — canonical project spec (status table, project laws, maintenance protocol, changelog). Has merge conflicts; the spec is still load-bearing once they're resolved.
- [wholesale/INTEGRATIONS.md](wholesale/INTEGRATIONS.md) — ~1,400-line technical reference for the Shopify → QBO → NMI order-to-payment pipeline. Read before touching webhook, orchestrator, integration, or scheduler code.
- [wholesale/README.md](wholesale/README.md) — quickstart + Shopify CLI background.

The maintenance protocol in `wholesale/CLAUDE.md §6` requires meaningful code changes ship with corresponding spec + INTEGRATIONS updates. Trivial fixes (whitespace, comments) are exempt.

## Commands

Each workspace has its own `package.json`. Always `cd` into the workspace first. Node 20.19+ / 22.12+ required.

### wholesale/

```bash
shopify app dev                      # local dev with auto-tunnel (cloudflare quick tunnel by default)
npm run dev                          # alias
npm run build                        # react-router build
npm run build:theme                  # rebuild registration-form/ → theme-extension/assets/
npm run start                        # serve a prebuilt bundle (react-router-serve)
npm run lint
npm run typecheck                    # react-router typegen + tsc --noEmit
npm run deploy                       # shopify app deploy (runs `predeploy` → build:theme first)
npm run config:use <name>            # switch between shopify.app.*.toml profiles
```

### wholesale/registration-form/

```bash
npm run dev                          # Vite dev server (port 5173)
npm run build                        # → ../extensions/theme-extension/assets/react-app-bundle.{js,css}
```

After **any** change under `registration-form/src/`, run `npm run build:theme` from `wholesale/` (or `npm run build` from `registration-form/`). The storefront loads the built bundle, not the source. Changes are invisible until the bundle is rebuilt.

### ns-retail/

Same Shopify CLI script layout as wholesale (`dev`, `build`, `deploy`, `lint`, `typecheck`). Run from `ns-retail/`.

### Synthetic webhook trigger (while a topic is awaiting Partners approval)

```bash
shopify app webhook trigger \
  --topic=orders/create \
  --api-version=2026-07 \
  --address=https://<tunnel>/webhooks/orders/create
```

## Architecture — big picture

The wholesale app does four loosely coupled jobs. Each has its own subsystem in `wholesale/app/`:

### 1. Order-to-payment pipeline (critical path)

```
Shopify orders/create webhook
  → app/routes/webhooks.orders.create.jsx
  → services/order/order.service.processShopifyOrder (idempotent orchestrator)
      → services/customer/* (QBO find-or-create + NMI vault find-or-create)
      → services/invoice/* (claim-first invoice creation)
  → Agenda scheduler tick (30s dev, cron 15th+last in prod)
      → jobs/processPendingPayments.job.js
          PASS 1: services/payment/payment.service.chargeInvoice  (NMI charge)
          PASS 2: services/invoice/invoice.service.propagateSuccessfulPayment  (re-sync paid invoices)
```

Three idempotency layers prevent duplicate invoices: webhook-id dedup, atomic claim on `processingStatus`, claim-first Invoice insert against the unique `(shop, shopifyOrderId)` index. See `INTEGRATIONS.md §13` for the structural deep-dive.

### 2. Wholesale registration form

A separate flow from the order pipeline. Storefront customers fill a 3-step React form embedded via the theme extension; submission goes through Shopify's app proxy to `POST /api/registration-form`, which uploads files, hashes password/card, persists to MongoDB, and creates a Shopify customer with the `Approved` tag (auto-approval — no admin gating in current flow).

App proxy subpath: `wholesale-application`. Storefront calls path: `/apps/wholesale-application/<route>`.

### 3. Cross-store inventory sync (wholesale ↔ retail)

Two Shopify stores, one MongoDB id map (`sync_id_maps` collection) bridges them.

```
WHOLESALE → RETAIL                          RETAIL → WHOLESALE
─────────────────────────                   ──────────────────
products/create webhook                     orders/create (retail Shopify config)
  → services/sync/product.sync                → POST /api/sync/retail-order
  → REST create on retail                     → services/sync/inventory.sync.deductWholesaleInventoryForOrder
                                              → GraphQL inventoryAdjustQuantities on wholesale
orders/create webhook
  → deductRetailInventoryForOrder           inventory_levels/update (retail Shopify config)
  → REST adjust on retail                     → POST /api/sync/retail-inventory-update
                                              → syncWholesaleRestockFromRetail
inventory_levels/update webhook               → GraphQL inventoryAdjustQuantities (+delta) on wholesale
  → syncInventoryRestockToRetail
  → REST set on retail (only positive deltas)
```

Loop prevention is critical: every sync direction writes BOTH `available` (wholesale-side) and `retailAvailable` (retail-side) in `sync_id_maps` after a successful sync. The next webhook coming back the other way sees delta=0 and skips. Order-direction (negative-delta) events are always skipped in restock handlers; they're already covered by the `orders/create` deduction path on the originating store.

Retail-direction webhooks authenticate via shared secret (`RETAIL_SYNC_SECRET` env), accepted on either `x-sync-secret` header or `?secret=` query param. The wholesale shop is passed as `?shop=<domain>` so the handler can pick the right offline admin session.

**Retail-store webhooks must be configured manually in the retail Shopify admin** (Settings → Notifications → Webhooks). They are not declared in `wholesale/shopify.app.toml` because that toml binds to the wholesale Partners app, not the retail store.

### 4. Custom passwordless login (Shopify new customer accounts)

Implemented as a vanilla-JS theme extension block on `/pages/login`:

```
Customer enters email on /pages/login
  → POST /apps/wholesale-application/api/auth/check-email
      → Shopify Admin GraphQL customers(query:"email:...")
      → Has "Approved" tag?
  → Yes  → redirect to {{ routes.storefront_login_url }}?login_hint=<email>
            (Shopify takes over from there; OTP entry on Shopify's hosted page,
             email pre-filled via OAuth-standard login_hint param)
  → No   → redirect to /pages/contact (registration form)
```

Tag-based authorization is enforced via two paths:
- **Read path**: `check-email` only returns `exists:true` when the Shopify customer carries the `Approved` tag.
- **Write path**: `customers/create` webhook (`app/routes/webhooks.customers.create.jsx`) inspects the tags on the newly-created customer. If `Approved` is missing AND order count is 0 → `customerDelete`. If `Approved` is missing AND orders exist → tag as `unauthorized_signup` and surface for admin review (never auto-cancel orders).

The webhook does a live re-fetch via GraphQL before deleting, so customers that get tagged `Approved` between creation and webhook delivery aren't accidentally removed. Module-level Set dedup guards against Shopify's at-least-once webhook delivery.

For existing customers that pre-date this rule, `POST /api/admin/backfill-customer-tags` (exposed as the "Backfill customer tags" button on the admin Customers page) walks every customer in the store and adds the `Approved` tag if it's missing. Run once after deploying the webhook.

## Project laws (do not violate)

- **No `process.env.X` outside `services/*/*.config.js`.** Read via `readEnv` / `readInt` / `readBool` from [wholesale/app/utils/env.utils.js](wholesale/app/utils/env.utils.js). Boot aggregator lives at `app/configs/index.js`.
- **No QBO calls outside `services/qbo/`.** Same rule for `services/nmi/` and `services/shopify/`. Each integration is internally split: `<svc>.apis.js` owns I/O, `<svc>.service.js` exposes domain methods, GraphQL strings live in `<svc>.queries.js` / `<svc>.mutations.js`.
- **API handlers in `app/api/` are thin** — validate, auth, call a service, respond. Business logic lives in `services/`.
- **Models in `app/models/` are schema + indexes only.**
- **Errors are typed** — `PermanentError` vs `TransientError` from [wholesale/app/utils/retry.utils.js](wholesale/app/utils/retry.utils.js). Integration clients retry transients (default 4); the scheduler retries NMI charges (default 6).
- **CSS only in `registration-form/src/styles/registration-form.css`.** Admin routes (`app/routes/app.*.jsx`) use Polaris web components (`s-*` tags); never add `style={{}}` or CSS classes to them.
- **New admin API endpoints register manually in `app/routes.js`** (not file-based) — pattern: `route("/api/admin/...", "api/admin/...")`.

## Critical gotchas

- **Cloudflare quick tunnels are ephemeral.** `shopify app dev` mints a new `*.trycloudflare.com` URL on every restart. Any webhook configured in the retail Shopify admin against the previous URL stops working silently. Use ngrok with a reserved subdomain (or a persistent tunnel) when actively testing retail-direction sync.
- **`orders/create` is a protected customer data topic** and CANNOT be declared in `shopify.app.toml` until the app is approved in the Partners dashboard. Until then it's registered programmatically by `ensureProtectedWebhooks` on every admin page load.
- **Embedded admin nav** — inside the Shopify admin iframe, use `Link`/`useSubmit` from `react-router`, and the `redirect` returned from `authenticate.admin` (not the one from `react-router`).
- **NMI sandbox vs production hosts** — sandbox keys are rejected on `secure.nmi.com` and vice versa. Always match `NMI_ENVIRONMENT` to the key. Same idea for QBO.
- **QBO refresh tokens rotate on every refresh** — seeded once from env, then Mongo is the source of truth. Concurrent refreshes are coalesced via an in-flight promise.
- **Webhook handlers must return 200 quickly.** Downstream work is fire-and-forget. Never block the webhook response on QBO/NMI/cross-store calls.
- **Mongoose strict mode silently strips unknown fields from `$set`.** If you `updateOne(...{ $set: { newField: ... } })` and the field isn't on the schema, Mongoose drops it without warning. This bit the sync `wholesaleInventoryItemId` rollout — always add the field to the schema first.
- **Polaris `s-button icon="…"` accepts only exact names from `privateIconArray`** — valid examples: `"check"`, `"undo"`, `"delete"`, `"arrow-left"`. `"checkmark"` silently shows no icon. Check `node_modules/@shopify/polaris-types/dist/polaris.d.ts` (~L203) for the full list.
- **React Router 7 auto-revalidates loaders after fetcher actions.** Do NOT call `revalidator.revalidate()` in a `useEffect` that lists `revalidator` as a dep — its reference flips each state transition and causes an infinite loop. Rely on auto-revalidation.

## Configuration profiles

`shopify.app.toml` + per-developer overrides (e.g. `shopify.app.dev-rk.toml`). Switch with `npm run config:use <name>`. The active profile drives `shopify app dev`/`deploy` and decides which Partners app is targeted.

App proxy subpath is `wholesale-application` (configured in `[app_proxy]` block of the active toml). Storefront calls reach the app via `/apps/wholesale-application/<path>` — authenticated by `authenticate.public.appProxy(request)` in the handler.

## Session storage

Active session storage is **MongoDB** via `@shopify/shopify-app-session-storage-mongodb` (see `app/shopify.server.js`). The `prisma/` directory is template residue and unused. `npm run setup` is harmless but unnecessary.

## Changelog

### 2026-06-04 (afternoon) — Drop-ship automation Phases A + B (retail order → parallel wholesale order at ½ price) + dev-port workaround

Continued from the morning's block/tag/rename work. This is the BIG one — the start of the drop-ship pipeline that automates the ~6 hours/day Trace was doing manually. Phases A + B are built; Phases C–F are roadmap.

**Decisions locked this session (user Q&A):**

| Decision | Value |
|---|---|
| Trigger | Retail orders/create — fire the whole chain immediately when patient places order |
| Pricing | **½ of product BASE price** (variant.price ÷ 2). Patient discount, shipping, tax do NOT affect wholesale pricing. |
| NS Retail customer | New synthetic B2B customer on wholesale store, email `naturalsolutionsretail@gmail.com`, tagged `ns-retail-internal` |
| Retail QBO | Has its own QBO + credentials. Set up env vars when Phase D begins. |
| Variant mapping | Use existing `sync_id_maps` collection — `entityType: productVariant, retailId → wholesaleId` |
| Shipping + tax on drop-ship order | Mirror retail order (shipping_lines copied, tax handled by Shopify based on shipping address) |
| Order email | NS Retail's email (not the patient's) so patient doesn't get duplicate confirmations |

**Files changed:**

| File | Change |
|---|---|
| NEW: [wholesale/app/models/dropshipMapping.server.js](wholesale/app/models/dropshipMapping.server.js) | Mongoose model `dropship_mappings`. One row per retail order — anchors the whole drop-ship lifecycle. Unique index on `(shop, retailOrderId)` for webhook-retry idempotency. Status enum: `received → wholesale_order_created → wholesale_invoice_created → retail_bill_created → paid` (or `cancelled` / `error`). Tracks GIDs of every entity created downstream, plus amounts locked at creation (retail base subtotal + ½ wholesale subtotal). |
| NEW: [wholesale/app/services/dropship/dropship.service.js](wholesale/app/services/dropship/dropship.service.js) | The drop-ship orchestrator. Three public exports: (a) `ensureNsRetailCustomer(shop)` — finds the "Natural Solutions Retail" customer by tag, creates it if missing, memoizes GID in-process. (b) `processRetailOrderForDropShip({order, wholesaleShop, retailShop})` — main orchestrator, called fire-and-forget from the retail-order endpoint. Computes amounts, upserts the mapping doc, resolves NS Retail customer, then triggers Draft Order creation. (c) Test helper `_resetNsRetailCustomerCache` for tests. **Phase B logic**: `createDropshipWholesaleOrder` builds line items via variant mapping + ½-price `priceOverride`, copies shipping address + shipping line from retail order, creates a Draft Order via `draftOrderCreate`, immediately completes it via `draftOrderComplete(paymentPending: true)` to convert to a real Order. The real-order completion natively decrements wholesale inventory. |
| [wholesale/app/api/sync/retail-order.js](wholesale/app/api/sync/retail-order.js) | Replaced the disabled `deductWholesaleInventoryForOrder` call (commented out earlier today) with a fire-and-forget `processRetailOrderForDropShip` invocation. Endpoint still returns 200 immediately, all heavy lifting happens async. Reads optional `retail_shop` query param for telemetry. |
| [ns-retail/app/routes/webhooks.orders.create.jsx](ns-retail/app/routes/webhooks.orders.create.jsx) | Added `forwardToWholesaleDropship` function. After the existing CDO tagging logic, ns-retail now fire-and-forget POSTs the retail order payload to wholesale's `/api/sync/retail-order` endpoint (with `x-sync-secret` header). The forward happens for EVERY retail order, regardless of whether a practitioner code was used. Reads three env vars: `WHOLESALE_API_BASE`, `WHOLESALE_SHOP`, `RETAIL_SYNC_SECRET`. Silently skips if any env var is missing (lets ns-retail run standalone in dev without wholesale booted). |
| [ns-retail/.env](ns-retail/.env) | Added `WHOLESALE_API_BASE` (current wholesale tunnel URL), `WHOLESALE_SHOP` (wholesale shop domain), `RETAIL_SYNC_SECRET` (must match wholesale's `.env`). |
| [ns-retail/package.json](ns-retail/package.json) | Dev script: `shopify app dev` → `shopify app dev --graphiql-port=13458`. See "Port-conflict workaround" below for context. |

**Architecture of what runs at runtime:**

```
Patient orders on retail Shopify
       ↓
[Retail Shopify fires orders/create webhook]
       ↓
ns-retail's webhook handler (webhooks.orders.create.jsx)
       │
       ├─ Existing: tag customer with code:<practitioner> + email tag (if code used)
       └─ NEW: POST retail order payload to wholesale's /api/sync/retail-order
                       │
                       ↓
       wholesale's /api/sync/retail-order
                       ↓
       processRetailOrderForDropShip
              │
              ├─ Compute amounts (retailBaseSubtotal, wholesaleSubtotal = ÷ 2)
              ├─ Upsert dropship_mappings row (unique on shop+retailOrderId)
              ├─ ensureNsRetailCustomer (lookup by tag, create if missing)
              ├─ buildDropshipLineItems
              │    For each retail line:
              │     • SyncIdMap.findOne({entityType: 'productVariant', retailId})
              │     • Compute price = retail.price ÷ 2
              │     • Push {variantId: gid://shopify/ProductVariant/<wholesale-id>,
              │             quantity, priceOverride: {amount, currencyCode}}
              ├─ Build DraftOrderInput (customer = NS Retail, ship address = patient,
              │    email = NS Retail's, shipping line copied, tags = drop-ship +
              │    retail-order:<id> + mapping:<mongoid>)
              ├─ draftOrderCreate → draft order id
              ├─ draftOrderComplete(paymentPending: true) → real order id
              │   (decrements wholesale inventory natively)
              └─ Update mapping: wholesaleOrderId + status='wholesale_order_created'
```

**What does NOT happen yet (intentional — future phases):**

- ❌ Wholesale invoice creation will ride the existing wholesale orders/create webhook → invoice service automatically, but Phase C must land first to skip retail-mirror inventory sync (avoid double-decrement)
- ❌ Retail QBO Bill creation (Phase D — needs retail QBO credentials)
- ❌ Cancellation cascade (Phase E — retail orders/cancelled → reverse the chain)
- ❌ Weekly batch pay (Phase F — new Agenda job, closes all retail QBO bills with one payment)
- ❌ Patient discount lines — patient discount stays on retail's books only. Wholesale gets ½ of full base regardless.

**Port-conflict workaround (Shopify CLI bug):**

When running BOTH wholesale and ns-retail dev servers simultaneously on the same machine, the second-to-start crashes with `EADDRINUSE` on `::1:3457`. Root cause: Shopify CLI runs a GraphiQL server on port 3457 by default, and the two apps collide.

Tried fixes (in order):
1. `PORT=3458` in `.env` — only affects React Router server, not GraphiQL. Didn't help.
2. `--localhost-port=3460` flag — **wrong flag**, actually triggers `--use-localhost` mode which DISABLES WEBHOOKS. Don't use this.
3. `--graphiql-port=3458` flag — should work but [Shopify CLI Issue #4927](https://github.com/Shopify/cli/issues/4927) reports the port-availability check (`get-port-please`) misbehaves on some platforms (including Windows here).
4. `--graphiql-port=13458` (high port, current) — works most reliably; nothing else on the system fights for ports above 10000.

For dev testing of drop-ship without running both servers (when port conflict persists), the workaround is to manually POST a sample retail-order payload directly to wholesale's `/api/sync/retail-order` endpoint via PowerShell `Invoke-WebRequest` with the right `x-sync-secret` header — bypasses ns-retail entirely.

**Gotchas discovered:**

| Gotcha | Resolution |
|---|---|
| Shopify CLI GraphiQL port (3457) collision when running two apps locally | Use `--graphiql-port=13458` on ns-retail |
| `--localhost-port` flag accidentally enables `--use-localhost` mode which silently breaks webhooks ("not compatible with Shopify features which directly invoke your app") | Use `--graphiql-port=<port>` NOT `--localhost-port=<port>` |
| Retail order has retail variant IDs; wholesale Draft Order needs wholesale variant IDs | `SyncIdMap.findOne({entityType: 'productVariant', retailId})`. If ANY variant is unmappable the whole drop-ship order errors — hard-fail vs silently drop products |
| `draftOrderComplete` would try to charge NS Retail customer if `paymentPending` not set | Pass `paymentPending: true` — order completes in "Payment pending" state, correct since NS Retail pays via weekly batch (Phase F) |
| Draft Order line item custom-price API evolved | Use modern `priceOverride: { amount, currencyCode }` (October 2025+ API). Older `price: Money` is deprecated. |
| Forwarder runs on EVERY retail order, even ones without practitioner codes | Intentional — drop-ship is independent of CDO attribution |
| Adding new imports triggers stale TS "declared but never read" hints | Hints are stale; functions ARE called. Ignore until TS daemon catches up. |

**Open follow-ups (Phases C–F + deployment):**

- **Phase C** — Skip retail-mirror inventory sync for drop-ship-tagged wholesale orders. ~0.5 day.
- **Phase D** — Retail QBO Bill creation. Needs net-new QBO OAuth + token storage in ns-retail. ~3-4 days.
- **Phase E** — Cancellation cascade. retail orders/cancelled → reverse the chain. ~1-2 days.
- **Phase F** — Weekly batch pay. New Agenda cron job, closes all retail QBO bills with ONE payment. Mechanism (check vs ACH vs Bill Pay) TBD with Trace. ~2-3 days.
- **Practitioner Dashboard (wholesale storefront)** — `/pages/practitioner-portal` storefront page (theme app extension block) where approved practitioners self-manage. Tabs: My Code(s) + copy, My Patients list, Create Patient form (Flow 4 — practitioner-initiated retail-customer create via cross-store secret), My Commissions (after Phase 3), W-9 upload + payout details (Phase 4). Reuses `wholesale/registration-form/` bundle or spins a new SPA. Auth-gated on `Approved` + `practitioner` tags. ~5-7 days. Not started — was in original CDO Phase 1 plan but never built.
- **Patient Dashboard (retail storefront)** — `/pages/my-account` or theme block on customer account area where patients see their referring practitioner (name+email from `cdo_applications.referral`), the `code:*` tag on their record, and (optional) a "Change practitioner" form. Smaller SPA than practitioner dashboard — mostly read-only display. ~2-3 days. Not started.
- **Inventory sync re-enable** — Stays commented. Drop-ship's auto-created wholesale order natively decrements wholesale inventory, replacing the old sync.
- **Deployment plan documented** — This session also covered the local → live deployment story: recommended hosting (Render or Fly.io with two services from one monorepo, shared MongoDB Atlas), two `.env` files per env, two `shopify app deploy` commands per release, Partners approval needed for `orders/create` protected-data + `network_access` for checkout-ui-code extension. See the "Deployment" section / earlier session message — not building yet.

### 2026-06-04 — Block (soft) replaces Decline+Delete · inventory sync gate · practitioner tag · bare-email tag on patients · file renamed to PROGRAM.md

Four behavior changes + the file rename of CLAUDE.md → PROGRAM.md (this file you're reading). Each change is small but they touch enough of the system that a future session needs to know.

#### Change 1 — Retail → wholesale inventory sync DISABLED (commented out)

**File:** [wholesale/app/api/sync/retail-order.js](wholesale/app/api/sync/retail-order.js#L72)

The `deductWholesaleInventoryForOrder(order, wholesaleShop)` call inside the `/api/sync/retail-order` endpoint is commented out. The import stays — uncomment one line to re-enable.

**Why:** Drop-ship automation (planned next, see 2026-06-03 entry roadmap) will create a parallel wholesale Shopify order for every retail order, and THAT order natively decrements wholesale inventory. Running this sync at the same time would double-deduct.

**Gotcha to know:** Until drop-ship lands, **retail orders no longer decrement wholesale stock**. Wholesale inventory will drift higher than reality. Accepted gap, deliberately so. Re-enable by uncommenting the 3 lines + removing the disabled comment.

#### Change 2 — Wholesale practitioner customer gets a `practitioner` tag

**File:** [wholesale/app/api/registration-form.js](wholesale/app/api/registration-form.js#L379)

`tags: ["Approved"]` → `tags: ["Approved", "practitioner"]` when creating the Shopify customer after a successful wholesale registration.

**Why:** Lets admin filter "all practitioners" in Shopify customer search. Also lets future drop-ship logic differentiate practitioner customers from the synthetic "Natural Solutions Retail" customer the drop-ship orders will be attached to.

#### Change 3 — Patient gets the practitioner's BARE EMAIL as a tag

**Files:**
- [ns-retail/app/api/signup-form.js](ns-retail/app/api/signup-form.js#L130) (signup flow)
- [ns-retail/app/routes/webhooks.orders.create.jsx](ns-retail/app/routes/webhooks.orders.create.jsx#L184) (post-checkout webhook)

When a patient signs up or places an order using a practitioner code, their Shopify customer now gets TWO new tags: `code:<the-code>` (existing) AND the **bare practitioner email** (e.g. `drjohn@example.com`, no prefix). The webhook handler `tagCustomerWithCode` was extended to accept a `practitionerEmail` arg and batches both tag adds into ONE `customerUpdate` mutation, skipping the call entirely if both are already present (idempotent).

**Why:** Lets the wholesale admin filter "all patients referred by drjohn@example.com" in Shopify's customer search by typing the email. Bare format (no `practitioner:` prefix) was the locked decision — Trace finds it easier to search by typing just the email.

**Tag list per scenario (final):**

| Customer type | Tags applied |
|---|---|
| New wholesale practitioner | `Approved`, `practitioner` |
| Patient signs up WITHOUT a code | `Signup-Self` |
| Patient signs up WITH code `john_a3f1c8e2` | `Signup-Self`, `code:john_a3f1c8e2`, `drjohn@example.com` |
| Guest patient places order with code | `code:john_a3f1c8e2`, `drjohn@example.com` |
| Blocked wholesale customer (see change 4) | `Blocked` (and `Approved` removed) |

#### Change 4 — Decline+Delete REMOVED, Block (soft, reversible) added

**Major behavioral change.** Previously, declining a wholesale customer = email + Shopify customer delete + order delete + Mongo doc delete (totally destructive). Now there's only ONE action: Block. **Block keeps everything in place** — record, orders, Shopify customer — and just flips the customer's tag to `Blocked` plus sets `status: "blocked"` + `blockedAt` in Mongo.

**Files:**

| File | Change |
|---|---|
| [wholesale/app/models/wholesaleApplication.server.js](wholesale/app/models/wholesaleApplication.server.js#L86) | Added `"blocked"` to the `status` enum + new `blockedAt: Date` field |
| NEW: [wholesale/app/api/admin/block.js](wholesale/app/api/admin/block.js) | `POST /api/admin/customers/:id/block`. Fetches Shopify customer tags, removes `Approved`, adds `Blocked`, then sets `status: 'blocked'` + `blockedAt` in Mongo. Idempotent. NO destructive calls. |
| [wholesale/app/routes.js](wholesale/app/routes.js) | Registered the new `/api/admin/customers/:id/block` route. The `/decline` route + endpoint stay in place for now but the UI no longer references them (effectively dead — safe to remove later). |
| [wholesale/app/routes/app.customers.$id.jsx](wholesale/app/routes/app.customers.$id.jsx) | Detail-page button "Decline" → "Block customer". Removed delete icon. Modal heading + body + primary-action label updated. Toast → "Customer blocked." Renamed `onConfirmDecline` → `onConfirmBlock`. **User-added refinement:** Block button is hidden when `status === "blocked"` (no double-block). Status badge tone goes `critical` for blocked. |
| [wholesale/app/routes/app.customers._index.jsx](wholesale/app/routes/app.customers._index.jsx) | List per-row button: delete-icon trash → "Block" text button (still red, still secondary variant). Modal + toast + fetcher URL updated. **NEW "Blocked" badge** renders for rows where `status === "blocked"` (renders before the `Approved` badge so blocked rows visually flag themselves). |

**Decision context (recorded):** Trace asked for soft archive everything, no hard deletes. Block is reversible (admin re-tags `Approved` and removes `Blocked` if needed — no unblock button yet, but the data model supports it).

**Open follow-up:** Add an "Unblock customer" button on the detail page when `status === "blocked"`. Same endpoint pattern (`/api/admin/customers/:id/unblock`), flips tags the other way + sets `status: "approved"`. Not built yet because the trigger hasn't come up.

#### Change 5 — This file renamed `CLAUDE.md` → `PROGRAM.md`

User requested. Trade-off accepted: Claude Code's tooling **no longer auto-loads** this file at session start (the auto-load lives in `<system-reminder>` at session boot, keyed on the `CLAUDE.md` filename).

**Consequence for future sessions:** the session protocol (rule 1: "read this file at session start") becomes MANUAL. Every Claude that opens a conversation about this repo must remember to:

```
Read c:\Apps\Natural-solutions\PROGRAM.md
```

…**at the very top of their work**, before anything else. The memory note (`feedback_maintain_claude_md.md`) was updated to say "read PROGRAM.md" instead of "read CLAUDE.md" so the reminder still fires.

**If auto-loading stops working** — i.e., a future session forgets — the workaround is to rename back to CLAUDE.md. Nothing inside the file has hardcoded the name (uses "this file" everywhere), so the rename is reversible.

### 2026-06-03 — CDO Phase 1 + Phase 2 implementation (practitioner codes + checkout flow)

Built the entire CDO Phase 1 (practitioner code auto-generation + cdo_applications save at signup) and Phase 2 (checkout extension Verify+Apply+auto-apply + orders/create webhook tag+save) end-to-end across this session. The planning entry from 2026-06-01 below described the design; this entry records what actually shipped.

#### Phase 1 — Practitioner code auto-generation

When a practitioner submits the wholesale registration form and is auto-approved, a code is now generated and persisted automatically. Format `<firstname-lowercased>_<8-char-hex>` (e.g. `john_a3f1c8e2`).

**Files changed:**

| File | Change |
|---|---|
| [ns-retail/app/models/cdoPractitionerCode.server.js](ns-retail/app/models/cdoPractitionerCode.server.js) | Removed `uppercase: true` from the `code` field, replaced with `lowercase: true`. Locked format is lowercase — the schema was auto-uppercasing values on save before, which would have broken the format. |
| NEW: [wholesale/app/models/cdoPractitionerCode.server.js](wholesale/app/models/cdoPractitionerCode.server.js) | Mirror schema. Both apps now write to the same `cdo_practitioner_codes` collection. Mongoose requires the model in each app where it's used. **MAINTENANCE RULE: when changing the shape, update BOTH files — Mongoose `strict: true` will silently drop unknown $set fields in whichever app has the stale schema.** |
| [wholesale/app/models/wholesaleApplication.server.js](wholesale/app/models/wholesaleApplication.server.js) | Added `cdoPractitionerCodeId` (ObjectId ref) + `cdoPractitionerCode` (string, denormalized). Back-link from application → code. |
| NEW: [wholesale/app/services/cdo/cdo.service.js](wholesale/app/services/cdo/cdo.service.js) | Exports `generatePractitionerCode({applicationId, firstName, lastName, email, shop})`. Sanitizes firstName (strips non-`[a-z]`, falls back to `practitioner`), generates 8 hex chars via `crypto.randomBytes(4).toString('hex')`, retries on E11000 up to 5 times, back-links on the WholesaleApplication. **Idempotent** — if `cdoPractitionerCodeId` already exists, returns the existing one without creating a duplicate. |
| [wholesale/app/api/registration-form.js](wholesale/app/api/registration-form.js) | Calls `generatePractitionerCode()` immediately after Shopify customer creation + `status: "approved"` update. Wrapped in its own try/catch — **failures are log-only and never block the rest of the flow**. NMI vault + Mongo doc + Shopify customer already exist by that point; an admin can re-generate manually from the ns-retail CDO admin if needed. |

**Phase 1b — `cdo_applications` save at patient signup:**

| File | Change |
|---|---|
| [ns-retail/app/api/signup-form.js](ns-retail/app/api/signup-form.js) | After Shopify customer creation, also saves a row to `cdo_applications` with `applicantType: 'patient'`, `status: 'approved'`, and a `referral` snapshot if a practitioner code was used. Snapshot is **immutable** — even if the practitioner later archives the code, this patient's referral linkage stays fixed. Failure is log-only. Reads the `shop` from `auth.session?.shop` or `auth.liquid?.shop` from the app-proxy auth response. |

**Sticky validation errors fix on signup form** (separate but in the same session):

| File | Change |
|---|---|
| [ns-retail/signup-form/src/SignupForm.jsx](ns-retail/signup-form/src/SignupForm.jsx) | Three behavior fixes: (a) Empty field on blur clears its RHF error via `clearErrors(fieldName)` — added blur handlers for firstName, lastName. (b) Email field: `onEmailBlur` clears RHF errors when email is empty; `onEmailChange` clears the server-side "Already registered" error when user starts editing. (c) Code field: when status was `'invalid'` and user clears the input, state resets to `'idle'` automatically (was only resetting on edit-after-verified before, leaving "Code not found" stuck after clearing). RULE: **empty field on blur = no error shown** (RHF still runs full validation on submit, this is purely a display fix). |

#### Phase 2 — Checkout flow (Verify + Apply + auto-apply + webhook)

The checkout-ui-code extension lets retail patients enter a practitioner code at checkout, verifies it against MongoDB, applies the matching Shopify discount, and triggers post-checkout customer tagging + cdo_applications save via the orders/create webhook. Auto-apply for logged-in customers who already have a `code:*` tag (from signup form or previous order webhook) — they never have to type anything on repeat orders.

**Files changed:**

| File | Change |
|---|---|
| NEW: [ns-retail/app/api/cdo/checkout-validate-code.js](ns-retail/app/api/cdo/checkout-validate-code.js) | Separate validate endpoint for checkout context. **CORS-enabled** (checkout extensions are NOT served from the app's domain — direct fetch needs CORS headers + OPTIONS preflight handler). NO app-proxy auth (checkout fetch doesn't go through the proxy). Rate-limited at 10/min/IP. Returns `{valid, code, practitionerName, discountPercent}`. |
| [ns-retail/app/routes.js](ns-retail/app/routes.js) | Migrated all API endpoints from `app/routes/api.*.jsx` (file-based) to `app/api/*.js` (manual registration via `route()` calls) — matching the wholesale workspace's convention. Used `flatRoutes({ignoredRouteFiles: ["**/api.*"]})` so flatRoutes ignores the legacy files. Added per-boot diagnostic logging of registered routes (same pattern as wholesale). |
| NEW: [ns-retail/extensions/checkout-ui-code/src/services/ApiService.js](ns-retail/extensions/checkout-ui-code/src/services/ApiService.js) | Wraps fetch from the checkout extension. Reads the app URL from `shopify.appMetafields.value` (matches by key + namespace ending in `:cdo`). Throws a descriptive error if the metafield is missing ("Ask the store admin to open the app once in Shopify admin"). Exposes `ApiService.verifyCode(code)`. NO hardcoded URL. |
| [ns-retail/extensions/checkout-ui-code/src/Checkout.jsx](ns-retail/extensions/checkout-ui-code/src/Checkout.jsx) | The full extension. State machine: idle → verifying → verified → applying → applied (or error). Uses `s-grid gridTemplateColumns="1fr auto" alignItems="end"` for the input + Verify button row (input fills width, button hugs right, button aligns to bottom edge of the input). On Apply: writes the verified code to cart attribute `cdo_practitioner_code` first (so the orders/create webhook can read it cleanly even if the discount is later removed), then calls `shopify.applyDiscountCodeChange({type: 'addDiscountCode', code})`. **Auto-apply**: useEffect with `[customer?.id]` dep — when a logged-in customer with a `code:*` tag enters checkout, verifies + applies in one go. One-shot guard via `autoApplyAttempted` signal. Detects pre-applied codes on page reload via `shopify.discountCodes.value`. Renders a warning banner when `shopify.instructions.value.discounts.canUpdateDiscountCodes === false` (Apple Pay / accelerated checkout blocks discount changes). |
| [ns-retail/extensions/checkout-ui-code/shopify.extension.toml](ns-retail/extensions/checkout-ui-code/shopify.extension.toml) | `network_access = true` for the fetch. Subscribed to `[[extensions.metafields]] namespace = "$app:cdo" key = "app_url"`. **No `allowed_domains` array** — that's not the toml format; Shopify reviews called domains during app submission. |
| [ns-retail/app/routes/app.jsx](ns-retail/app/routes/app.jsx) | **App URL bridge**: on every admin page load, queries shop ID + writes the current app URL (`process.env.SHOPIFY_APP_URL` or `new URL(request.url).origin`) to the shop's `$app:cdo / app_url` metafield via `metafieldsSet`. Best-effort, errors are logged not thrown. Idempotent (upsert). This is how the checkout extension knows where to fetch — Shopify gives checkout extensions NO automatic access to the app URL. |
| NEW: [ns-retail/app/routes/webhooks.orders.create.jsx](ns-retail/app/routes/webhooks.orders.create.jsx) | Order webhook handler. HMAC verify via `authenticate.webhook` → in-memory dedup by `x-shopify-webhook-id` (5-min TTL) → returns 200 immediately, fire-and-forget the actual work. Extracts code from `order.note_attributes['cdo_practitioner_code']` (primary, set by our extension) or `order.discount_codes[]` (fallback, regex-matched against `<word>_<8hex>`). Validates against `cdo_practitioner_codes` (active only). Tags the customer via `customerUpdate` GraphQL with `[...existingTags, "code:<code>"]`. Upserts `cdo_applications` by email — **first-touch wins** (only sets `referral` if currently null). Falls back to creating a new patient row if no existing application exists. Uses `unauthenticated.admin(shop)` to get an offline admin client for the GraphQL calls. |
| [ns-retail/shopify.app.toml](ns-retail/shopify.app.toml) | Subscribed to `orders/create` webhook. Added `read_orders` to scopes (needed to receive the topic). **NOTE: orders/create is a PROTECTED customer data topic** — Partners-dashboard approval required before `shopify app deploy` succeeds. Until approved, register programmatically (same pattern as wholesale's `ensureProtectedWebhooks`). |

#### Architectural patterns established this session

**1. ns-retail API endpoints now follow wholesale's convention:**
- Storefront/admin endpoints in `app/api/<subdir>/<name>.js`
- Manually registered in `app/routes.js` via `route("/api/...", "api/.../...")` 
- File-based routes in `app/routes/` reserved for: `app.*` (admin UI), `webhooks.*` (webhook handlers), `auth.*` (auth flow)
- `flatRoutes({ignoredRouteFiles: ["**/api.*"]})` skips any legacy `routes/api.*.jsx` files

**2. App URL bridge for checkout extensions:**
The pattern for letting a checkout UI extension know where to fetch:
```
Admin app load → metafieldsSet($app:cdo / app_url) → shop metafield
                                                          ↓
Checkout extension toml [[extensions.metafields]] subscribes
                                                          ↓
shopify.appMetafields.value exposes it → ApiService.getAppBaseUrl()
```
This works because Shopify resolves `$app:cdo` to `app--<your-app-id>--cdo` at runtime, the metafield is shop-scoped so it persists across customer sessions, and the admin only needs to open the app ONCE per shop to populate it. **Caveat**: tunnel URL changes during dev require re-opening the admin app to refresh the metafield.

**3. Cart attribute → orders/create webhook signal:**
The extension stamps `cdo_practitioner_code` on the cart via `applyAttributeChange` BEFORE applying the discount. Reason: `applyAttributeChange` writes durably to `order.note_attributes` which the webhook can read in one field even if Shopify removes the discount later (e.g. customer applies a different code). The webhook's secondary fallback is regex-matching `<word>_<8hex>` against `order.discount_codes[]` — works without the cart attribute but is less reliable.

#### Gotchas discovered (and how they were resolved)

| Gotcha | Resolution |
|---|---|
| `applyAttributeChange` is deprecated in 2026-04 in favor of cart metafields | Kept the deprecated API anyway — it works, the webhook reads `note_attributes` cleanly, migration to cart metafields requires an Admin API query post-order to read them. Re-evaluate when Shopify actually removes the old API. |
| Relative URLs in checkout extension fetch resolve to **shopify.com**, not your app | Use absolute URL only. The metafield bridge pattern (above) makes this automatic. |
| `useContext` returns null in admin app after cloudflare tunnel URL changes | Stale Vite cache. Fix: kill dev, `Remove-Item -Recurse node_modules\.vite, .react-router`, restart, open admin in **incognito window** (browser cache holds chunks from old tunnel URL). Two React versions across `ns-retail` (18.3) and `signup-form` (19.2) make this worse — long-term fix is aligning versions OR moving signup-form out of the ns-retail tree. |
| `useSignal(null)` infers signal type as `null` only — assigning a string later errors in TS | Use JSDoc cast: `useSignal(/** @type {string \| null} */ (null))`. Same for state-string signals: `useSignal(/** @type {'idle' \| 'verified' \| ...} */ ('idle'))`. |
| Shopify discount codes are CASE-INSENSITIVE per docs (`SAVE10` === `save10`) | Our MongoDB lookup uses `$regex: ^code$ /i` to match either case. Storage is lowercase (per the schema fix). |
| `orders/create` is PROTECTED customer data | Won't deploy until Partners approves. Workaround during dev: register programmatically on app boot OR use `shopify app webhook trigger` for synthetic webhook delivery to the local handler. |
| Checkout UI extension layout: `s-stack direction="inline"` doesn't stretch children | Use `s-grid gridTemplateColumns="1fr auto" alignItems="end"` instead — `1fr` makes the input fill remaining width, `auto` sizes the button to its content, `alignItems="end"` aligns the button to the BOTTOM of the input (the input has a label above the field that adds vertical space). |

#### Open follow-ups

- **Partners approval for `orders/create`** — request it; until approved, webhook deploy won't work in production. Dev still works via programmatic registration / synthetic triggers.
- **Network access review for production** — when ready to submit the app for production, Shopify reviews the URLs the checkout extension calls. The single domain to declare: the app's production URL.
- **Migrate from `applyAttributeChange` to cart metafields** — when Shopify actually starts breaking the deprecated API. Webhook handler would need to switch from `order.note_attributes` to `order.metafields(namespace: "$app:cdo")` via Admin API.
- **Admin auto-creates matching Shopify discount when generating a practitioner code** — currently the admin must manually create a Shopify discount with the same code string. Could call `discountCodeBasicCreate` GraphQL mutation from `generatePractitionerCode()` to automate. User chose manual for v1.
- **Manual-approval gate for wholesale registration** — once added, move the `generatePractitionerCode` call from registration submit to the approve endpoint. The function is already idempotent (skip if `cdoPractitionerCodeId` is set) so moving it later won't double-generate.
- **app_proxy.url is sometimes stale in `ns-retail/shopify.app.toml`** — when cloudflare tunnel URL changes for `application_url`, the `app_proxy.url` field doesn't always auto-update. Keep them in sync manually OR script it.
- **Two React versions (18 + 19) coexist in ns-retail tree** — root cause of recurring `useContext` null errors. Move `signup-form/` out OR upgrade both apps to React 19. Tracked but not addressed.
- **The `extensions/cdo-discount/` Shopify Function scaffold** — still empty. Not needed for the current flow (admin manually creates matching Shopify discount codes). Could be wired up later for fully programmatic discounts via metaobjects.
- **CDO Phase 3 (commission attribution)** — when an order is placed with a code, the existing code creates a `cdo_application.referral` snapshot but does NOT create `cdo_commissions` rows yet. Next phase: read order line totals + commission rate from the code, write `cdo_commissions` with `payoutStatus: code.commissionApproved ? 'eligible' : 'pending_w9'`.
- **CDO Phase 4 (W-9 + commission approval gate)** — practitioner uploads W-9 via the wholesale practitioner portal (not built); admin approves → flips `cdoPractitionerCode.commissionApproved = true` + bulk-updates pending commissions.
- **CDO Phase 5 (payout execution)** — deferred. Mechanism TBD (manual, Stripe Connect, store credit).

### 2026-06-01 — CDO Practitioner Program planning + Phase 1 kickoff

Started the CDO (Customer Development Officer) referral + commission system spanning both apps. This is the cross-store program where wholesale-approved practitioners refer retail patients and earn commissions on their orders. The user activated Plan mode, exploration agents mapped both codebases, then a Plan agent designed the full roadmap. No code changed yet — this entry records the planning + the locked decisions so future sessions know where to pick up.

**Discovery — ns-retail already had a substantial CDO scaffold that was unwired:**

- 8 MongoDB models under `ns-retail/app/models/cdo*.js`: `cdoPractitionerCode`, `cdoReferral`, `cdoCommission`, `cdoOrder`, `cdoPayout`, `cdoTransaction`, `cdoSetting`, plus a read-only mirror of `wholesaleApplication`. All real schemas, none populated. Connect to the shared MongoDB.
- 29 routes including `/app/cdo-program/*` admin pages (dashboard, customers, commissions, orders, payouts, referrals, transactions, reports, settings) — mostly empty UI shells.
- Service layer `ns-retail/app/services/cdo/cdo.service.js` with list helpers only, no mutations.
- `ns-retail/extensions/cdo-discount/` is a Shopify Function (checkout extension) for applying referral-code discounts — scaffolded but not wired to actual codes.
- ns-retail webhook subscriptions: ONLY `app/uninstalled` + `app/scopes_update`. No `orders/create` yet.

The wholesale app had ZERO CDO code. `WholesaleApplication.referrals` + `referredBy` exist but are informational (just captures "who told you about us"). Auto-approval at [wholesale/app/api/registration-form.js:378](wholesale/app/api/registration-form.js#L378) is the natural hook point for practitioner-code generation.

**Locked architectural decisions (from user Q&A):**

| Decision | Value |
|---|---|
| Practitioner portal location | Wholesale storefront `/pages/practitioner-portal` (theme app extension block, app-proxy auth, tag-gated on `Approved`) |
| Code format | `<firstname-lowercased>_<8-char-random-hex>` — e.g. `john_xysnke25` |
| Code generation timing | Auto on wholesale registration approval |
| Patient identity | Retail-store-only Shopify customer (NO wholesale account) |
| Commission rate | Single global default in `cdoSetting.defaultCommissionRate`, admin-configurable |
| Discount on code | Wired via existing `cdo-discount` checkout extension |
| Commissions pre-W-9 | Tracked with `payoutStatus: 'pending_w9'`, flipped to `'eligible'` after admin approves W-9 |
| Payout execution | Out of scope for v1 — track now, decide mechanism later |
| Starting flow | Flow 4 (Practitioner creates patient) |

**Roadmap docs created:**

- [ns-retail/CDO-ARCHITECTURE.md](ns-retail/CDO-ARCHITECTURE.md) — client-facing overview with diagrams, the 4 flows, practitioner/patient lifecycles, glossary
- [ns-retail/CDO-ROADMAP.md](ns-retail/CDO-ROADMAP.md) — dev implementation plan with file paths, schema bumps, API contracts, verification checklist

**Phase 1 (Flow 4 — Practitioner creates patient) — kickoff:**

- 8–10 days estimated, single-dev
- Cross-store HTTPS hop with shared secret: wholesale storefront POSTs to wholesale `/api/cdo/create-patient` (app-proxy auth, verifies `Approved` tag) → wholesale POSTs to ns-retail `/api/cdo-internal/create-customer` (shared-secret auth) → ns-retail's offline Shopify session calls `customerCreate` GraphQL with tags + metafield → `cdo_referrals` row written
- Mirror Mongoose schema file in wholesale for `cdo_practitioner_codes` (same collection, both apps write to it)
- Theme app extension block reuses the existing `react-app-bundle.js`; `main.jsx` switches between `<App />` (registration) and `<PractitionerPortal />` based on which root div is in the DOM
- New env vars: `CDO_INTERNAL_SECRET` (both apps), `NS_RETAIL_API_BASE` (wholesale), `NS_RETAIL_SHOP_DOMAIN` (ns-retail)

**Risks already identified (and how they'll be handled):**

- `cdoPractitionerCode.code` has `uppercase: true` which conflicts with the locked lowercase format — must be removed before code-gen runs.
- Mongoose mirror schema drift (two definitions of same model, one per app) — document as a maintenance rule until extracted to a shared package.
- Duplicate email on retail store — Phase 1 rejects with 409. Silent attach to an existing customer is risky (could overwrite another practitioner's code) — deferred to later.
- W-9 storage — use Shopify Files (`uploadFileToShopify` already exists in `wholesale/app/services/shopify/shopify.service.js`).

**Open follow-ups for future sessions:**

- Manual-approval gate (replace auto-approve at registration submit) — `generatePractitionerCode` hook moves there. Idempotent — skip if `cdoPractitionerCodeId` already set.
- Commission attribution webhook on retail (Phase 2) needs Partners-dashboard approval for `orders/create` topic (protected customer data) — same gate the wholesale app went through.
- Anti-fraud measures (manual approval gate, email verification, CAPTCHA on registration) — flagged in an earlier discussion this session but explicitly deferred.

### 2026-05-28 — Duplicate-phone exception removed: always full rollback on ShopifyUserError

Reversed the duplicate-phone exception we locked in earlier today (see [the orphan-NMI-vault changelog entry](#2026-05-28--registration-flow-orphan-nmi-vault-rollback--mongo-retry)). New rule: **any ShopifyUserError on customerCreate → delete BOTH the Mongo doc AND the NMI vault, no exceptions.**

**Why the reversal:** the previous behavior kept the NMI vault + Mongo doc when Shopify rejected with "phone already taken" — the idea was that the card-on-file was still valid for the customer's eventual resubmit. The project owner decided this leaves residue in BOTH systems that's hard to reason about and easy to confuse on retry. Simpler rule wins: if Shopify said no, we clean up everywhere.

**Cleanup matrix (updated):**

| Failure point | NMI vault | Mongo doc | Shopify customer |
|---|---|---|---|
| Step 1 (NMI create) | doesn't exist | not attempted | not attempted |
| Step 2 (Mongo, after retries) | **deleted** | doesn't exist | not attempted |
| Step 3 — any ShopifyUserError (including duplicate phone) | **deleted** | **deleted** | failed |
| Step 3 — non-userError (network/5xx) | KEPT | KEPT (`shopifyCreateFailed=true`) | failed |

Branch B (non-userError errors like network/5xx) is unchanged — admin retry from the dashboard still uses the existing NMI vault + Mongo doc.

**Files changed:**

| File | Change |
|---|---|
| `wholesale/app/api/registration-form.js` | Removed the `isOnlyDuplicatePhoneError` helper (no longer referenced). Simplified the `ShopifyUserError` catch branch — `await deleteNmiVaultWithRetry(...)` + `await WholesaleApplication.deleteOne(...)` always run, no conditional. Cleaned up the comment explaining why. |

**No theme rebuild needed** — server-side change only.

**Open follow-ups:** none. The "accepted trade-off" about duplicate-phone keeping records (called out in the earlier 2026-05-28 NMI-rollback changelog) no longer applies.

### 2026-05-28 — NMI second-billing action: `update_customer` → `add_billing` (the documented one)

Live-tested on the project owner's NMI account today: `customer_vault=update_customer` with an unknown billing_id does NOT create a new billing record. NMI rejected the request with `response=3, "Invalid Billing Id", response_code=300`. This contradicts our earlier (verbally-confirmed) belief that NMI auto-creates new billings in that case, and reverses the design decision logged in [the 2026-05-28 multi-billing changelog entry](#2026-05-28--nmi-multi-billing-per-vault-card--ach-side-by-side).

**Empirical evidence captured from server logs:**

```
Step 1a — add_customer (ACH) → response=1 ✅ vault 1180411647 created
Step 1b — update_customer (card, new billing_id) → response=3 ❌ "Invalid Billing Id"
Step 2  — delete_customer (rollback) → response=1 ✅ vault cleaned up
```

The rollback path worked as designed — the failing second-billing call did NOT leave a half-configured vault — but the registration submit returned `502 Could not save your card on file` to the user, which is a real failure on the happy path for ACH-preferred customers.

**Fix:** switched the second-billing call to NMI's documented `customer_vault=add_billing` action. Same payload shape (customer_vault_id + billing_id + payment details + optional profile fields) — only the value of the `customer_vault` param changed.

**Files changed:**

| File | Change |
|---|---|
| `wholesale/app/services/nmi/nmi.service.js` | Renamed `addBillingViaUpdateCustomer` → `addBillingToCustomerVault`. Changed `customer_vault` param from `'update_customer'` to `'add_billing'`. Cleaned up the doc comment + error message that referenced the old action name. Log keys (`vault.add_billing.request` / `.success`) were already named for the operation, so they remain accurate. |
| `wholesale/app/api/registration-form.js` | Updated the import + call site to use the renamed function. |

**Rule learned (recording for future):**

> NMI's API has historically been described as "permissive — `update_customer` with unknown billing_id creates new billing." That was either wrong, or it changed at some point in NMI's deployment. **Going forward: when adding a NEW billing record to an existing vault, use `customer_vault=add_billing`. When updating an EXISTING billing record, use `customer_vault=update_customer` (or `customer_vault=update_billing`) with a known billing_id.**

**No theme rebuild needed** — server-side change only.

**Open follow-ups:** none. The multi-billing flow should now work end-to-end for ACH customers after the next server restart.

### 2026-05-28 — Frontend ABA routing-number checksum validation

Caught NMI returning `Invalid ABA number` (response_code=300) when a registration form submission included a routing number that passed our regex (`^\d{9}$`) but failed NMI's checksum check. Result: the registration flow created the customer-vault request, NMI rejected it, the user saw a generic "Could not save your payment method" error — wasted round trip + a slightly confusing error.

Added client-side ABA checksum validation in `step3.schema.js`:

```js
function isValidABA(routing) {
  if (!/^\d{9}$/.test(String(routing || ''))) return false
  const d = String(routing).split('').map(Number)
  const sum = 3*d[0] + 7*d[1] + d[2] + 3*d[3] + 7*d[4] + d[5] + 3*d[6] + 7*d[7] + d[8]
  return sum % 10 === 0
}
```

The achRoutingNumber Yup validator now chains `.test('aba-checksum', ...)` after the existing `.matches(/^\d{9}$/)`. Invalid checksums show "Invalid routing number" inline at the form before submission.

**Testing knowledge worth keeping:** real-bank ABAs that pass checksum and work for dev/QA — `021000021` (Chase NYC), `026009593` (BoA), `121000248` (Wells Fargo), `044002161` (PNC), `111000038` (Fed Reserve test). The frontend regex `^\d{9}$` won't catch made-up numbers like `123456789`; the checksum will. NMI is the final authority — if the routing format passes our checksum but is for a non-existent bank, NMI still rejects.

**File changed:** `wholesale/registration-form/src/schema/step3.schema.js` (added `isValidABA` helper and chained `.test()` to achRoutingNumber).

**Storefront rebuild required:** `npm run build:theme` from `wholesale/` so the new validator reaches the live form bundle.

**Open follow-ups:** none.

### 2026-05-28 — NMI multi-billing per vault: card + ACH side-by-side

Before this change, the registration flow created an NMI vault with exactly ONE billing record — whichever payment method the customer chose at Step 3. ACH-preferred customers had only ACH stored; if the admin then tried "Charge card on file" as a fallback, there was no card on file to charge. This broke the existing cheque/ACH → card override workflow for ACH customers.

After this change: every customer has a **card billing** in their NMI vault (always — card on file is required for all wholesale accounts per the Step 3 form copy). ACH-preferred customers ALSO get an ACH billing in the same vault. We follow [NMI's intended design](https://support.nmi.com/hc/en-gb/articles/14171691659665-Customer-Vault-Billing-IDs) of **one `customer_vault_id` with multiple `billing_id`s inside it**, not two separate vaults per customer.

**Final vault structure per customer:**

| Customer's preferred method | NMI vault contents |
|---|---|
| `card` | 1 billing: `card_<uuid>` (priority 1) |
| `check` | 1 billing: `card_<uuid>` (priority 1) — used as backup if check doesn't arrive |
| `ach` | 2 billings: `ach_<uuid>` (priority 1, default charge target) + `card_<uuid>` (priority 2, fallback target) |

**API actions used:**

| Action | NMI param | Purpose |
|---|---|---|
| Create vault + 1st billing | `customer_vault=add_customer` with `billing_id=<our_id>` | First billing record (always) |
| Add 2nd billing (ACH customers) | `customer_vault=update_customer` with a NEW `billing_id` | Confirmed by project owner via NMI sandbox test that `update_customer` with an unknown `billing_id` creates a new billing record. (NMI's documented action for this is `add_billing`; behavior is functionally identical.) |
| Charge | `type=sale` with `customer_vault_id` + optional `billing_id` | When `billing_id` omitted → NMI charges priority-1. We pass `billing_id` explicitly so ACH customers' card-on-file fallback hits the card billing, not the priority-1 ACH billing. |

**Files changed:**

| File | Change |
|---|---|
| `wholesale/app/services/nmi/nmi.service.js` | (a) `createCustomerVault` now accepts an optional `billingId` arg that's passed as the `billing_id` param to NMI's `add_customer` mutation. (b) New `addBillingViaUpdateCustomer({ customerVaultId, billingId, profile, paymentDetails })` — uses `customer_vault=update_customer` to add a second billing record (per project owner's tested behavior). (c) `chargeCustomerVault` now accepts an optional `billingId` arg passed to the `type=sale` request — when omitted, NMI charges priority-1. |
| `wholesale/registration-form/src/RegistrationForm.jsx` (frontend) | `onValid` now sends the FULL `achAccountNumber` (not just last 4) to the backend when `method=='ach'`. The backend uses it once to create the ACH billing in NMI; Mongo still stores only the last 4. Bank account numbers are not in PCI scope (PCI is card-only); ACH passthrough is the standard pattern. |
| `wholesale/app/api/registration-form.js` (backend) | (a) New `generateBillingId(kind)` helper produces stable readable IDs like `card_a3f1c8e2d4b9` / `ach_b8d2e5f7c109`. (b) Step 1 (NMI vault create) branches on `payment.method`: `card`/`check` → single `createCustomerVault` call with card billing; `ach` → `createCustomerVault` with ACH billing then `addBillingViaUpdateCustomer` for card backup. (c) Payment payload restructure now embeds `nmi_billing_id` under both `payment.card` and (when ACH) `payment.ach`. (d) Full `achAccountNumber` is used for NMI and then NOT stored in the Mongo payload (only `achAccountLast4` is kept). (e) If the second billing (card backup for ACH customer) fails after the vault is created, the vault is rolled back to avoid a half-configured state. |
| `wholesale/app/models/customerMap.server.js` | Added `nmiCardBillingId` and `nmiAchBillingId` fields (both `String`, `default: null`). These are mirrors of the billing_ids stored on `WholesaleApplication.payment.card.nmi_billing_id` / `payment.ach.nmi_billing_id`. Schema is `strict: true` so the fields MUST be declared (Mongoose silently strips unknown `$set` fields — the project's documented gotcha). |
| `wholesale/app/services/customer/customer.service.js` | `ensureCustomerForOrder` now mirrors the billing_ids from `WholesaleApplication` onto `CustomerMap` alongside the existing `nmiCustomerVaultId` mirror. `.select()` projection extended to include `payment.card` and `payment.ach`. |
| `wholesale/app/services/payment/payment.service.js` | `chargeInvoice` resolves a `targetBillingId` from `customerMap` based on `invoice.paymentMethod`: ACH invoices → `nmiAchBillingId`, everything else → `nmiCardBillingId`. Passed to `chargeCustomerVault`. When `customerMap` has no matching billing_id (e.g., legacy customers created before this change), `undefined` is passed and NMI falls back to priority-1 — the existing behavior. |

**Form UI — no changes needed:**

The Step 3 form was already structured correctly for this flow:
- "Card on file" section is **always rendered** (PaymentCardForm component, not conditional on method) — the form copy already said "A card on file is required for all accounts".
- ACH section appears **only when** `paymentMethod === 'ach'`.
- Card data via Collect.js is tokenized on every submit, regardless of preferred method.

So check/card/ach users all already entered card data through the same Step 3 UI. The only frontend code change was sending the full ACH account number instead of just the last 4.

**Storage shape (final):**

```js
// WholesaleApplication.payment
{
  method: 'ach',  // or 'card' / 'check'
  card: {                                  // ALWAYS present (every customer has card on file)
    cardholderName: '...',
    cardBrand: 'visa',
    cardLast4: '4242',
    paymentToken: '...',                   // Collect.js token used at NMI vault create
    nmi_billing_id: 'card_a3f1c8e2d4b9',  // handle to charge this billing
  },
  ach: {                                   // ONLY for ACH-preferred customers
    achAccountName: '...',
    achRoutingNumber: '021000021',         // OK to store (less sensitive)
    achAccountLast4: '6789',               // only last 4 — full account NEVER persisted
    achAccountType: 'Checking',
    nmi_billing_id: 'ach_b8d2e5f7c109',
  },
}

// CustomerMap (mirrors for fast charge lookup)
{
  nmiCustomerVaultId: '12345678',
  nmiCardBillingId: 'card_a3f1c8e2d4b9',
  nmiAchBillingId: 'ach_b8d2e5f7c109',  // null for card/check customers
  paymentMethod: 'ach',  // customer-level preference
}

// Invoice
{
  paymentMethod: 'ach',  // can be flipped per-invoice by admin (cheque→card fallback)
  customerPaymentPreference: 'ach',  // immutable original at creation
}
```

**Charge resolution at runtime:**

```
chargeInvoice picks billing_id from CustomerMap:
  invoice.paymentMethod === 'ach' → customerMap.nmiAchBillingId
  invoice.paymentMethod !== 'ach' → customerMap.nmiCardBillingId
  missing → undefined → NMI charges priority-1

Example flows:
  Card customer, normal monthly charge:
    invoice.paymentMethod = 'card' → uses card billing ✓
  ACH customer, normal monthly charge:
    invoice.paymentMethod = 'ach' → uses ACH billing ✓
  ACH customer, admin clicks "Charge card on file" (cheque/ACH→card override):
    invoice.paymentMethod flipped to 'card' → uses card billing ✓ (was broken before this change)
  Check customer, admin clicks "Charge card on file":
    invoice.paymentMethod = 'card' → uses card billing ✓
```

**Validation question resolved during this session:**

The project owner specifically chose `customer_vault=update_customer` (with a new billing_id) over NMI's documented `customer_vault=add_billing` for the second billing. They confirmed via direct testing in the NMI sandbox that `update_customer` with an unknown billing_id creates a new billing rather than overwriting priority-1. NMI's official docs only describe `update_customer` as for updating existing records, but functionally both actions produce the same end state. If we ever see Shopify-sandbox-style behavior changes from NMI, the switch to `add_billing` is trivial — `addBillingViaUpdateCustomer` becomes `addBillingViaAddBilling` with the only diff being the `customer_vault` param value.

**Gotchas worth knowing:**

- **ACH account number passthrough.** The frontend now sends the full ACH account number to our backend (not just the last 4). It's used once to create the NMI ACH billing, then dropped before Mongo persistence. The full number is never stored in our DB. Bank account numbers are NOT subject to PCI DSS (PCI is card-only); ACH is governed by NACHA, which NMI handles as the gateway. Standard pattern — but worth documenting in case of audit.
- **Backwards compatibility.** Customers created BEFORE this change have NMI vaults with no billing_id assigned (NMI auto-generated one). Their `CustomerMap.nmiCardBillingId` / `nmiAchBillingId` will be `null`. `chargeInvoice` passes `undefined` in that case → NMI charges priority-1 → works correctly because they only had one billing anyway.
- **NMI vault rollback on partial failure.** If the ACH billing succeeds but the card-backup billing fails, we now delete the whole vault (`deleteNmiVaultWithRetry`) so the customer can resubmit without leaving a "ACH-only, no card backup" vault in NMI.
- **Mongoose strict mode (still).** `CustomerMap` is `strict: true`. The new `nmiCardBillingId` / `nmiAchBillingId` fields MUST be declared on the schema — silent stripping would have made this a multi-hour debug if missed.
- **`payment.card` / `payment.ach` are Mixed.** `WholesaleApplication.payment` uses Mixed sub-fields, so adding `nmi_billing_id` to them didn't require a schema change. The full object shape lives in the application code.

**Open follow-ups:**

- No backfill needed for existing customers — they continue to work via priority-1 charge fallback. If you ever add a NEW billing to an existing legacy customer's vault (e.g., admin adds card-on-file later for an ACH customer registered before this fix), update `CustomerMap.nmiCardBillingId` at the same time.
- Future enhancement: an admin "Add bank account" / "Update card" action that uses `addBillingViaUpdateCustomer` for new methods + `update_billing` for in-place changes. Not built in this round.
- Consider tokenizing ACH via Collect.js too (instead of passing raw account number through our backend). Cleaner architecturally, more form-side work. Not blocking — current pattern is industry standard.
- The function name `toE164US` is still misleading (handles international too) — flagged in earlier phone changelog, no fix in this round.

### 2026-05-28 — Registration flow: orphan NMI vault rollback + Mongo retry

The registration submit handler used to leak orphan NMI vaults whenever Shopify's `customerCreate` failed with a `ShopifyUserError` (invalid phone, duplicate email, etc.) — the old code deleted the Mongo doc but left the NMI vault in place, creating ghost cards in NMI that the customer would never use. On resubmit, a fresh vault was created, growing the orphan pile. The Mongo write path also had no retry, so a single transient blip would return 500.

**Final flow (locked with user via Q&A):**

```
Step 1 — Create NMI vault
   fail → return error (nothing to clean up)
Step 2 — Create Mongo WholesaleApplication doc (3 retries)
   final fail → delete NMI vault + return error
Step 3 — Create Shopify customer
   success → update Mongo with customerId + status='approved', send invite
   fail (ShopifyUserError):
      "phone already taken" ONLY → keep NMI + keep Mongo (let customer fix phone)
      anything else → delete NMI + delete Mongo
   fail (non-userError): keep both with shopifyCreateFailed=true (admin retries from dashboard)
```

**Files changed:**

| File | Change |
|---|---|
| `wholesale/app/services/nmi/nmi.service.js` | Added `deleteCustomerVault(customerVaultId)` — POSTs `customer_vault=delete_customer` to NMI via the existing `nmiTransact` helper. Idempotent on NMI's side (deleting an already-deleted id returns success). Throws on transport failure or non-1 response; callers handle retry. |
| `wholesale/app/api/registration-form.js` | Added three helpers: `deleteNmiVaultWithRetry` (3 attempts, linear backoff, never throws — logs orphan warning if all fail), `createMongoDocWithRetry` (same retry shape for Mongo writes), and `isOnlyDuplicatePhoneError` (predicate that returns true iff every ShopifyUserError userError is field=phone + message contains 'taken'/'already'). Step 2 (Mongo create) now uses the retry helper and rolls back NMI on final failure. The ShopifyUserError catch branch now checks the duplicate-phone predicate; on match keeps both records, otherwise deletes NMI vault AND Mongo doc. Branch B (non-userError) unchanged. |

**Cleanup matrix (cheat sheet):**

| Failure point | NMI vault | Mongo doc | Shopify customer |
|---|---|---|---|
| Step 1 (NMI create) | doesn't exist | not attempted | not attempted |
| Step 2 (Mongo create, after retries) | **deleted** | doesn't exist | not attempted |
| Step 3 — `phone already taken` only | KEPT | KEPT | failed |
| Step 3 — any other ShopifyUserError | **deleted** | **deleted** | failed |
| Step 3 — non-userError (network/5xx) | KEPT | KEPT (`shopifyCreateFailed=true`) | failed |

**Accepted trade-off — duplicate-phone case:**

When Shopify rejects with `phone already taken` (the only error), we keep both NMI vault and Mongo doc so the customer's card-on-file is preserved for resubmission. The pending Mongo doc remains with `customerId: null` and `status: 'pending'`. On resubmit:
- `findCustomerVaultByEmail` will find the existing NMI vault and reuse it (no new vault created) ✅
- `WholesaleApplication.create()` will create a **second** Mongo doc with the same email ⚠️ — currently no email-uniqueness check at create time
- Once Shopify customerCreate succeeds with the corrected phone, the customer ends up with 1 Shopify customer + 1 NMI vault + 2 Mongo docs (the pending stub + the approved doc). Admin sees this on the Customers admin page; cleanup is manual.

User explicitly accepted this trade-off. The alternative (delete Mongo doc, keep NMI vault) was offered and declined — they preferred to keep an audit trail of the failed-phone attempt.

**Gotchas worth knowing:**

- `deleteNmiVaultWithRetry` **never throws**. If all 3 attempts fail, it logs a structured warning + returns false, and the original error (Shopify-create error, or the Mongo retry error) is still returned to the user. We don't want cleanup failure to clobber the actual error message.
- The Mongo retry uses 500ms / 1s / 1.5s linear backoff — short enough to feel responsive, long enough to absorb a replica-set election. If you start seeing failures past 3 retries, the underlying Mongo health is the issue, not the retry count.
- NMI's `customer_vault=delete_customer` returns `response=1` for both real deletes and "already deleted" — idempotent, so the retry loop is safe even if a previous attempt actually succeeded but timed out before our code saw the response.
- The function name `toE164US` is still misleading (handles international too) — flagged in the earlier phone-validation changelog. This change didn't fix it; would touch three call sites.

**Open follow-ups:**

- Add an email-uniqueness check at `WholesaleApplication.create()` to prevent the dup-Mongo-doc edge case described above. Either schema-level `unique: true` on `email` or a `findOne` check + update-existing semantics.
- The orphan NMI vaults that already exist (from before this fix) will sit in NMI forever unless cleaned up. Consider a one-off admin endpoint to scan NMI vaults and reconcile against `WholesaleApplication.nmiCustomerVaultId` — delete any vault not referenced by an application doc.

### 2026-05-28 — Registration form SuccessScreen: fixed crash + added "Go to login" CTA

The SuccessScreen briefly had a broken button that crashed the entire registration form with `Cannot read properties of null (reading 'useContext')`. Root cause: `import { useNavigation } from "react-router"` + a call to `useNavigation()` at module top level (outside any component body) + using the wrong hook (the navigation **state** object) as if it were a `navigate(path)` function. Four cascading bugs in one ~15-line addition. The registration form is a standalone Vite SPA with NO React Router setup — react-router hooks can never work there.

**Files changed:**

| File | Change |
|---|---|
| `wholesale/registration-form/src/RegistrationForm.jsx` | Removed the `useNavigation` import and the module-level `const navigation = useNavigation();`. Replaced the broken button (empty body, `onClick={navigation("/account/logout")}` — would fire on render, then crash) with a working CTA: arrow-wrapped `onClick={() => { window.location.href = "/pages/login"; }}` + visible "Go to login" label + `marginTop: 16`. |

**Why `/pages/login` and not `/account/logout`:** the user submitting the registration form isn't logged in (they're a brand-new applicant). Sending them to `/pages/login` aligns with the rest of the custom-login flow — once admin approves their `Approved` tag, they enter their email there and get the Shopify OTP login.

**Rule going forward:** the registration form (`registration-form/src/**`) is a standalone Vite SPA bundled into the theme extension as a single `react-app-bundle.js`. It does NOT have React Router context. **Never import or call `useNavigate`, `useNavigation`, `useLoaderData`, `useFetcher`, or any other react-router hook from anywhere in `registration-form/src/**`** — they all read from a context that doesn't exist there. For navigation use `window.location.href = "/..."` (plain browser nav). The admin embedded app under `wholesale/app/routes/**` IS a React Router app and can use those hooks normally — don't confuse the two.

**Storefront rebuild required:** `npm run build:theme` from `wholesale/` to pick up the SuccessScreen change.

### 2026-05-28 — Removed broken `emailSend` admin notification block

The registration form submit handler had a block that tried to email the store admin via a Shopify Admin GraphQL mutation called `emailSend`. **That mutation does not exist.** Shopify Admin GraphQL has no generic send-email mutation — only narrow ones like `customerSendAccountInviteEmail` (customer-targeted). The block was silently failing on every registration with `Field 'emailSend' doesn't exist on type 'Mutation'` in the logs.

**File changed:**

| File | Change |
|---|---|
| `wholesale/app/api/registration-form.js` | Deleted lines 281–327 (the `// Notify store admin of the new application` try/catch block). Replaced with a 5-line comment explaining what was removed and what to do if admin notifications become important again. |

**Why deleted, not fixed:**

- Admin already sees new applications on the `app/customers` admin page — the email was convenience, not critical.
- Fixing it properly requires a real email service (Resend / SendGrid / nodemailer + SMTP) which means new dependency, env var, domain verification, monthly account. Not worth it until admin notification becomes load-bearing.
- The original code returned no value and never blocked the request — so deleting it has zero functional impact, just stops the log noise.

**No new dependency installed.** The wholesale app's `package.json` still has zero email-sending libraries.

**Open follow-ups:**

- If admin notification becomes important (e.g., applications coming in off-hours that the admin doesn't see for hours), wire up Resend — ~30 min: install `resend`, verify a sending domain, replace the comment block with 5 lines that call `resend.emails.send({...})`. API key from resend.com goes into `.env` as `RESEND_API_KEY`.
- Alternative: nodemailer + Gmail SMTP or Office 365 SMTP — works but Gmail rate-limits at 500/day, deliverability less reliable than Resend.

### 2026-05-28 — Phone validation finalized: country code required (3rd iteration today)

After three iterations on phone validation today, the final shape is **"country code required, always"** at both the frontend and backend. Earlier iterations (US-only regex → permissive 7–15 digits → strict 10-digit only → optional `+` prefix) are superseded by this entry.

**Why this iteration:** Shopify's `customerCreate` mutation uses libphonenumber under the hood and validates against real telecom numbering plans. A bare 10-digit input like `9887484997` was being auto-prefixed with `+1` by our backend `toE164US`, which made Shopify interpret it as a US number with area code `988` — but `988` is a reserved service code (US Suicide & Crisis Lifeline), not a real area code, so Shopify rejected. Same trap with `0917484997` (area code `091` can't start with `0` in NANP) and `5551234567` (555 reserved for fictional use). The fix that survives: **never guess the country; always require the user to provide it**.

**Files changed today (final state):**

| File | Final state |
|---|---|
| `wholesale/registration-form/src/schema/step1.schema.js` | `PHONE_REGEX = /^\+?[0-9]+$/` (digits + optional leading `+`). The validator is a Yup `.test('needs-country-code', ...)` that requires 11–15 digits total (strips non-digits before counting). Bare 10-digit inputs fail with: *"Phone must include country code (e.g., +15146669999 for US, +919887484997 for India)"*. `.min(10).max(10)` from earlier iteration removed. |
| `wholesale/registration-form/src/components/Step1AboutYou.jsx` | `PHONE_INPUT_FILTER = /[^0-9+]/g` (strips everything except digits and `+`). Phone Controller's `onChange` does an extra pass to keep `+` only at position 0 — pasted strings like `5+5+5` get the mid-string `+`s stripped. Placeholder: `+15146669999`. |
| `wholesale/app/services/shopify/shopify.utils.js` | `toE164US` (legacy name, now misleading) updated to **throw** when given a bare 10-digit number with no `+`: `Error('Phone number must include country code (e.g., +1 for US, +91 for India)')`. Branches: `+` prefix → pass through; 11 digits starting with `1` → `+1XXXXXXXXXX`; ≥11 digits without `+` → `+${digits}`; 10 digits → throw; else null. |

**Validation timing — what the user sees:**

- `mode: "onTouched"` + `reValidateMode: "onChange"` (already in [RegistrationForm.jsx:170-171](wholesale/registration-form/src/RegistrationForm.jsx#L170-L171)) means the error appears live while typing **after the first blur**, before submission. This was specifically requested — earlier iterations had users hitting submit, getting a backend error, having to scroll back to fix.
- Backend error `Phone number must include country code` should now be unreachable because frontend catches it first. It still exists as a defense-in-depth backstop for the API path (`/api/registration-form`) in case the form is submitted programmatically.

**Test inputs (manual QA reference):**

| Input | Frontend | After backend `toE164US` | Shopify result |
|---|---|---|---|
| `+15146669999` | ✅ pass | `+15146669999` | ✅ accepted (Montreal real number) |
| `15146669999` | ✅ pass | `+15146669999` | ✅ |
| `+919887484997` | ✅ pass | `+919887484997` | ✅ |
| `919887484997` | ✅ pass | `+919887484997` | ✅ |
| `9887484997` (bare 10 digit) | ❌ blocked | (never reached) | n/a |
| `5551234567` (bare 10 digit) | ❌ blocked | (never reached) | n/a |
| `+10917484997` (bad area code) | ✅ pass (count valid) | `+10917484997` | ❌ rejected by Shopify (091 not real) |
| `174849971456455` (15 digits) | ✅ pass | `+174849971456455` | ❌ rejected by Shopify (too long for `+1`) |

The last two cases show the frontend's limit: it counts digits but doesn't know which area codes are valid. Shopify catches those — the customer's NMI vault is still created (NMI doesn't care about phone-number validity), but `WholesaleApplication.shopifyCreateFailed` flips to `true` and the admin sees the row with a "Sync failed" badge on the Customers page. If you want true area-code-aware validation client-side, the only realistic option is `libphonenumber-js` (~15kb bundle hit) — currently considered out of scope.

**Gotcha — function name `toE164US` is now misleading.** It throws on US-without-country-code now and accepts international through the fallback branch. Renaming would touch three call sites (`shopify.service.js`, `shopifyCustomer.js`, plus the `customer.service.js` mirror in the order flow). Left as-is to keep the change footprint small; future cleanup if anyone touches that area.

**Storefront rebuild required.** After this change, `npm run build:theme` from `wholesale/` was needed so the storefront's bundled `react-app-bundle.js` picks up the new schema + filter. Already done by the user.

**Open follow-ups:**

- If international applicants are a significant audience, consider a country-code dropdown UI for better discoverability (~30 min work).
- If you want library-grade validation that catches `988` / `091` / `555` at the frontend, add `libphonenumber-js`. Bundle cost vs. UX value tradeoff.
- The two earlier 2026-05-28 phone changelog entries below this one are NOT individually accurate anymore — they're left in place as historical record (showing the evolution) but the final state of phone validation is the entry you're reading. If you want to clean up the Changelog, collapse the three phone entries into one and keep this as the canonical one.

### 2026-05-28 — Phone field accepts international numbers (frontend only)

The registration form's phone validation was US-only — the regex `^\+?1?[-.\s]?\(?([2-9][0-9]{2})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})$` rejected anything that didn't match the 10-digit NANP pattern. Indian / EU / other international applicants couldn't get past Step 1.

**Files changed:**

| File | Change |
|---|---|
| `wholesale/registration-form/src/schema/step1.schema.js` | Replaced the US-only regex `.matches(...)` rule with a `.test('is-phone', ...)` that strips non-digits and accepts 7–15 digits (E.164 spec range). Error message now mentions both US and international examples. |

**What was NOT changed (intentional):**

- Backend `toE164US` ([wholesale/app/services/shopify/shopify.utils.js](wholesale/app/services/shopify/shopify.utils.js)) — already had a fallback branch `if (digits.length > 0) return \`+${digits}\`` that handles non-US numbers. `+91 98765 43210` typed in the form → digits `919876543210` (12) → falls through → Shopify gets `+919876543210` correctly. No backend update needed.
- The function name `toE164US` — slightly misleading now (it handles international too), but renaming would touch three call sites. Left alone to keep this change minimal.
- The phone input placeholder `+1 (555) 123-4567` in [Step1AboutYou.jsx](wholesale/registration-form/src/components/Step1AboutYou.jsx) — kept US-first hint since most applicants are US. The error message guides international users.

**Edge case worth knowing:**

A bare 10-digit number with no `+` prefix is treated as US (gets `+1` prepended). So `9876543210` typed by an Indian user → Shopify gets `+19876543210` (wrong). To get the right country code, international users **must include the `+CC` prefix** when typing. Validation accepts both bare 10-digit US AND `+CC...` international formats.

**Unrelated to this fix — a debugging tangent from this session:**

The actual error log the user shared (`[phone] Phone is invalid`) was triggered by the test number `5551234567` → `+15551234567`. Shopify rejects `555-XXXX` numbers because the `555` area code is reserved for fictional use (movies, TV, demos). This rejection is correct Shopify behavior, not a code bug. For local testing, use a real-looking number from a different area code, e.g. `+12027651100`.

**Gotcha:** Storefront bundle must be rebuilt for the new validation to take effect — `npm run build:theme` from `wholesale/`. Without it, the live storefront keeps using the old US-only regex.

**Open follow-ups:** None.

### 2026-05-28 — Tax section always-required (no more "resells products" toggle)

The registration form's Step 2 "Will you resell our products?" Yes/No toggle was removed. Tax fields (Tax ID Type, Tax ID, Sales Permit, Exempt State, Items to Resell, Business Activity) are now always visible and required for every applicant.

**Files changed:**

| File | Change |
|---|---|
| `wholesale/registration-form/src/components/Step2AddressTax.jsx` | Removed `resells` `useWatch` (line 220), removed the `useEffect` that depended on it, removed the toggle UI block, swapped the conditional `<div className={`rf-conditional ${resells ? "open" : ""}`}>` for a static `<div className="rf-conditional open">`, and updated the section helper text from "Only applies if you're reselling products to customers." to "Required for all wholesale applicants." |
| `wholesale/registration-form/src/schema/step2.schema.js` | Removed the `yup.object().when('resellsProducts', { is: true, then: ..., otherwise: s => s.notRequired() })` wrapper. Tax fields are now unconditionally required. The `resellsProducts: yup.boolean().required()` line was kept so the field still validates correctly with its hardcoded default. |
| `wholesale/registration-form/src/RegistrationForm.jsx` | Default value for `resellsProducts` flipped from `false` → `true`. The field stays in form state + MongoDB payload, just always `true`. |

**Why hardcode `resellsProducts: true` instead of deleting the field:**

User chose this explicitly to keep changes minimal. Deleting the field would have required updates to: Yup schema, default values, Mongoose `WholesaleApplication` model, `buildShopifyNote` (which writes "Will you resell" to the customer note), and the admin detail page rendering. Keeping the field with a hardcoded `true` avoids touching the backend at all — applications submitted after this change will all show `resellsProducts: true` in MongoDB / Shopify notes, matching the new UI reality.

**Gotcha:** Storefront bundle is not updated until the theme is rebuilt — run `npm run build:theme` from `wholesale/` (or `npm run build` from `wholesale/registration-form/`). Changes are otherwise invisible on the live storefront.

**Open follow-ups:** None. The subtitle on Step 2 ("plus tax info if you resell") was left as-is to honor the user's "only remove this thing" instruction — flag if you want it updated to drop "if you resell".

### 2026-05-28 — Session protocol added

Added the "Session protocol — MUST FOLLOW" section at the top of this file. From now on, every Claude session must read CLAUDE.md at the start and append a Changelog entry at the end. The user's intent is to make CLAUDE.md the canonical, never-forgotten record of every decision and every meaningful piece of work on this repo. The protocol was also saved into the per-user memory store (`feedback_maintain_claude_md`) so behavior survives even if this file is moved or rewritten.

**Why this matters:** Prior sessions ended with significant context (decisions, gotchas, follow-ups) sitting only in the chat transcript — which Claude doesn't carry forward to the next conversation. The Changelog closes that gap.

**Open follow-ups:** None. Going forward, every meaningful session must end with a Changelog entry.

### 2026-05-27 / 2026-05-28 — Custom login, tag-based auth, reverse inventory sync

Major features built and decisions locked in across these two days.

#### Features shipped

| Feature | Status |
|---|---|
| Custom passwordless login page (`/pages/login`) with backend email verification | ✅ |
| Email pre-fill on Shopify hosted login via OAuth `login_hint` | ✅ |
| Tag-based customer authorization (existing `Approved` tag) replacing MongoDB lookup in `check-email` | ✅ |
| `customers/create` webhook handler that deletes unauthorized 0-order customers and flags has-order ones | ✅ |
| One-time backfill admin endpoint + button ("Backfill customer tags") to apply `Approved` to pre-existing customers | ✅ |
| Retail → wholesale reverse inventory sync (refunds, manual adjustments on retail flow back to wholesale) | ✅ |
| Loop prevention across both sync directions via dual-update of `available` + `retailAvailable` | ✅ |
| Bug fix: missing dedup on `/api/sync/retail-order` (double retail webhook delivery would double-deduct wholesale) | ✅ |

#### Files created

| File | Purpose |
|---|---|
| `wholesale/app/api/auth/check-email.js` | Storefront-proxied tag-based lookup endpoint |
| `wholesale/app/api/admin/backfill-customer-tags.js` | Paginated admin endpoint to tag existing customers `Approved` |
| `wholesale/app/api/sync/retail-inventory-update.js` | Receives retail's `inventory_levels/update` webhook, drives reverse sync |
| `wholesale/app/routes/webhooks.customers.create.jsx` | Enforces `Approved`-tag rule on every new customer |
| `wholesale/extensions/theme-extension/blocks/login_email_check.liquid` | Vanilla-JS theme block — email form, fetch + redirect |

#### Files modified (notable)

| File | Change |
|---|---|
| `wholesale/app/services/sync/idMap.model.js` | Added `retailAvailable: Number` field |
| `wholesale/app/services/sync/inventory.sync.js` | `syncInventoryRestockToRetail` now writes `retailAvailable` after retail SET; new `syncWholesaleRestockFromRetail` mirrors the forward function in reverse |
| `wholesale/app/services/sync/index.js` | Exports `syncWholesaleRestockFromRetail` |
| `wholesale/app/api/sync/retail-order.js` | Added module-level Set dedup against duplicate retail order webhooks |
| `wholesale/app/services/shopify/shopify.queries.js` | Extended `QUERY_CUSTOMER_TAGS` with `numberOfOrders`; added `QUERY_CUSTOMER_BY_EMAIL` |
| `wholesale/shopify.app.toml` | Registered `customers/create` topic |
| `wholesale/app/routes.js` | Registered `/api/auth/check-email`, `/api/admin/backfill-customer-tags`, `/api/sync/retail-inventory-update` |
| `wholesale/app/routes/app.customers._index.jsx` | Added "Backfill customer tags" admin button (third button in primary actions) |

#### Key decisions

| Topic | Decision | Why |
|---|---|---|
| Tag scheme | Reuse existing `Approved` tag, do **not** add `registered_customer` | Registration form already auto-approves and tags `Approved` at customer creation; a second tag would be redundant |
| Login form stack | Vanilla JS in Liquid block, **not** a sibling Vite/React project | Email-check is trivial; React boilerplate not worth it. The registration form remains the only React SPA in theme assets |
| Pre-fill URL param | `?login_hint=` on `{{ routes.storefront_login_url }}` | Shopify's OAuth-standard param; `?email=` is silently ignored. Hardcoding `/account/login` strips other required params during the OAuth redirect chain |
| Auth verification path | Shopify customer lookup + tag check only (no MongoDB step) | User-requested: tags are the single source of truth |
| Customer cleanup policy | Auto-delete 0-order customers without `Approved` tag; flag with `unauthorized_signup` (do **not** auto-cancel) when orders exist | Auto-cancelling real orders would refund customers and corrupt QBO/NMI/inventory state |
| Admin-created customers | Strict — admin must add `Approved` tag at creation, or webhook deletes them | Single enforcement rule; no exemption tag |
| Pre-existing customer migration | Backfill button (idempotent) instead of one-off CLI script | Discoverable in the admin UI; safe to re-run |
| Retail refund sync mechanism | Subscribe retail's `inventory_levels/update` (Approach 2), not `refunds/create` (Approach 1) | Catches manual adjustments + returns + refunds in one webhook; symmetric with the existing wholesale-side `inventory_levels/update` flow |
| Post-delete UX (customer mid-OTP-flow) | Solution 3 — leave them on Shopify's error page | Webhook cannot push redirects to a different-origin browser; building a custom OTP system to fix this is multi-week work for a 1-click UX improvement |
| DOM auto-click on Shopify login | Confirmed impossible after exhaustive research | Cross-origin SOP + Shopify's new accounts replace theme's `/account/login` + Customer Account UI Extensions run in Web Worker. Officially documented restrictions |

#### Auth flow (final state)

```
Customer visits /pages/login (theme app extension block)
  → enters email → POST /apps/wholesale-application/api/auth/check-email
  → admin.graphql customers(query:"email:...") with tags + numberOfOrders
  → if exists && tags.includes("Approved"):
       redirect → {{ routes.storefront_login_url }}?login_hint=<email>
       (Shopify OAuth handles redirect_uri, etc.; OTP page pre-fills via login_hint)
     else:
       redirect → /pages/contact (registration form)
       (the customers/create webhook will reap any stale Shopify-side record)
```

#### Customer-create enforcement

```
Any customer created (any source) → POST /webhooks/customers/create (HMAC-verified)
  → module-level Set dedup (5-min window)
  → payload.tags.includes("Approved")?
       yes → 200 OK, no further action (fast path; registration-form customers exit here)
       no  → fire-and-forget cleanup:
             live re-fetch tags via QUERY_CUSTOMER_TAGS (race-safety)
             → still no Approved tag?
                 numberOfOrders === 0 → customerDelete
                 numberOfOrders > 0  → tag "unauthorized_signup", log warn (do NOT cancel orders)
  → 200 returned to Shopify immediately
```

#### Reverse inventory sync (retail → wholesale)

Loop prevention principle: every sync handler updates **both** `available` (wholesale) and `retailAvailable` (retail) in `sync_id_maps`, so the webhook that fires back from the other store sees `delta === 0` and skips.

```
RETAIL refund / manual adjustment / restock
  → retail Shopify fires inventory_levels/update
  → POST /api/sync/retail-inventory-update?secret=...&shop=<wholesale>
      → shared-secret auth + composite-key dedup (30s window)
      → syncWholesaleRestockFromRetail:
          reverse lookup retailId → wholesale inventoryItem
          delta = new available - itemMap.retailAvailable
          delta <= 0  → store retailAvailable, skip (orders/create handles deductions)
          delta  > 0  → inventoryAdjustQuantities (+delta) on wholesale,
                        update BOTH retailAvailable and available in sync_id_maps
```

The wholesale `inventory_levels/update` webhook then fires from the GraphQL adjust; `syncInventoryRestockToRetail` sees the pre-updated `available` and skips. No loop.

#### Manual setup checklist (one-time per environment)

- [ ] Run `shopify app deploy` (deploys new routes + webhook subscription + theme block)
- [ ] Click "Backfill customer tags" in the admin Customers page (tags every existing customer `Approved`)
- [ ] Create the `/pages/login` Shopify page; add the "Login (Email Check)" block via theme customizer
- [ ] (Optional) Replace `routes.account_login_url` with `/pages/login` in theme header(s)
- [ ] In the **retail** Shopify admin, subscribe these webhooks (URLs use the wholesale app's tunnel/prod URL — refresh after every `shopify app dev` restart if using cloudflare quick tunnels):
  - `orders/create` → `/api/sync/retail-order?secret=<RETAIL_SYNC_SECRET>&shop=<wholesale-domain>`
  - `inventory_levels/update` → `/api/sync/retail-inventory-update?secret=<RETAIL_SYNC_SECRET>&shop=<wholesale-domain>`

#### Gotchas discovered this session

- **Shopify pre-fill param is `login_hint`, not `email`.** Officially documented OAuth-standard. First attempt at pre-fill silently failed because `?email=` is ignored.
- **`/account/login` is fine to redirect to; `https://shopify.com/authentication/{shop_id}/login` is NOT.** Hitting the auth endpoint directly produces "Invalid redirect_uri" because OAuth params (`client_id`, `redirect_uri`) aren't attached. The storefront route does the OAuth handshake for you.
- **Cloudflare quick tunnels are ephemeral.** Every `shopify app dev` restart mints a new `*.trycloudflare.com` URL. Retail-side webhooks pinned to the old URL silently fail. Use ngrok with a reserved subdomain (or a persistent custom tunnel) when actively testing cross-store sync.
- **Customer Account UI Extensions cannot help us.** Per Shopify docs, they execute in a Web Worker with no DOM access, and the login/register pages are completely replaced by Shopify and cannot be modified by themes or apps. Multiple research passes confirmed this.
- **`<shopify-account>` web component is not a customization escape hatch.** Per the official API docs it exposes only `menu` and `sign-in-url` attributes plus `open`/`close` events — no programmatic submit, no `login_hint` attribute, no auto-open method.
- **Mongoose strict mode silently drops unknown `$set` fields.** Already documented, but bit us again when introducing `retailAvailable` — add the field to the schema before any code path writes it.
- **Shopify webhook payload `tags` is a comma-separated STRING, not an array.** `parseTagsField` in `webhooks.customers.create.jsx` handles both shapes defensively.

#### Open follow-ups

- Resolve the merge conflict markers in `wholesale/CLAUDE.md` (lines around 96 / 104 / 151).
- Backfill `retailAvailable` for existing `inventoryItem` rows (otherwise the first retail `inventory_levels/update` event per item just establishes the baseline and skips — only an issue for the very first event per item; self-heals from the second event onward).
- Optional polish: theme edit to override `routes.account_login_url` → `/pages/login` so customers cannot bypass the custom flow by going directly to `/account/login`.
- Optional polish: post-registration "Application received — awaiting approval" page in the registration form's success state.
- Optional polish: email notification on `customers/create` webhook deletion so the affected customer learns where to register.
