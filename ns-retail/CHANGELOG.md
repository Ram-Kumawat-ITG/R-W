# @shopify/shopify-app-template-react-router

## 2026.06.04
- CDO Program: **fixed the Payout Batch Details page not rendering** — the list route was named `app.cdo-program.batches.jsx`, which made it the (Outlet-less) parent layout of `app.cdo-program.batches.$id.jsx`, so clicking "View" just re-rendered the list. Renamed the list to `app.cdo-program.batches._index.jsx` (matching the `customers._index` pattern) so the detail route nests under the `cdo-program` layout and renders. The detail page already shows practitioner-wise payouts (total, commission count, vendor-bill deep link, payout status/date, txn refs, failure reasons) + the per-commission detail + the payout-audit log.
- CDO Program: made the **practitioner-level payout pause status clearly visible** in the portal (the pause feature itself already existed — `cdo_practitioner_holds` + the Settings-tab toggle + hold-aware CRON). Added an Active/Paused **Payouts** badge column to the CDO Practitioners list and a "Payouts paused/active" badge (+ who/when/why line) to the practitioner detail header across all tabs. `listPractitioners` now joins `getHeldPractitionerIds`. Pausing a practitioner keeps commissions accruing/tracked but excludes them from the `process-commission-payouts` CRON until resumed; resume returns all eligible unpaid commissions to the next cycle. Audit (action/date/admin/reason) is recorded on `cdo_practitioner_holds`.
- CDO Program: **reporting + Orders module**. (1) **Fixed dashboard analytics** — "Pending Payouts" filtered on `status: "pending"` which is not a valid payout status (silently matched nothing); now counts `awaiting_approval|approved|processing`. Same fix in per-practitioner KPIs. Added **Total Commission Earned** (excl. reversed), **Total Commission Paid**, **Outstanding Liability**, **Failed Payouts**, avg order value. (2) **Upcoming payouts** preview (`getUpcomingPayouts`) — no-write dry-run of the batch grouping showing next-cycle total, practitioners, commissions, estimated date (next 25th), and practitioner-wise breakdown, surfaced on the dashboard. (3) **Practitioner detail** expanded to earned/paid/pending/upcoming/referred-customers/referral-orders/lifetime-revenue/last-payout/next-expected + a payout-history table. (4) **Batch detail** now shows vendor-bill deep links + the payout `remarks[]` audit log per practitioner. (5) **New top-level Orders module** (`/app/orders`, nav item above CDO Program) over the entire `cdo_orders` collection with server-side pagination/filtering (order #, customer, practitioner, referral code, order status, payment status, date range, commission status)/sorting + a full Order Details page (customer, referral, practitioner, products, pricing, discounts, commission, payment, timeline, audit). New service fns `getUpcomingPayouts`/`listCdoOrders`/`getCdoOrderDetail`. See `docs/payout.md` §16–17.
- CDO Program: payout batches now carry an explicit **per-practitioner rollup** (`cdo_payout_batches.practitionerPayouts[]`) — one entry per practitioner (practitioner, commission count, aggregated total, payout status, txn ref), reflecting that the pipeline already creates **one aggregated payout per practitioner** (`buildPayoutBatch` groups eligible commissions by practitioner → a single `cdo_payouts` for the summed total with all `commissionIds` linked), not one payout per commission. The Payout Batches detail view now leads with a "Practitioner payouts" table (one row per practitioner) above the per-commission detail. No change to the payout/money logic — additive tracking + UI.
- CDO Program: **commission payout batch tracking + per-commission payout status + admin view**. Every `process-commission-payouts` run (CRON or manual reprocess) now persists a durable **`cdo_payout_batches`** record — batch reference, execution/started/completed times, status (`running`/`completed`/`completed_with_errors`/`failed`), totals + success/failed/skipped counts, `payoutIds[]`, and an `items[]` snapshot of every commission it processed (status, attempt, failure reason, QBO txn ref, payout date). `cdo_commissions` gains a payout-dimension rollup (`payoutStatus` ∈ pending/processing/paid/failed/skipped/paused/cancelled, `payoutAttemptCount`, `lastPayoutAttemptAt`, `payoutDate`, `payoutFailureReason`, `payoutTxnRef`, `lastBatchId`), set throughout the run and at pause/resume/reverse. New service fns `listPayoutBatches`/`getPayoutBatch`/`getCommissionPayoutHistory`/`reprocessBatch`; `runAutomatedPayouts` rewrapped in the batch lifecycle (money path unchanged — still idempotent via `payoutId` reservation + resumable `executeApprovedPayout`, so reprocess never double-pays). New **Payout Batches** admin tab: list runs → batch detail (rollup + per-commission items table) → **Reprocess failed**. See `docs/payout.md` §7.2.
- CDO Program: **fully automated commission payout workflow**. New **Agenda** scheduler (`app/services/scheduler/*`, ported from the wholesale workspace, booted fire-and-forget from `app/entry.server.jsx`) runs `process-commission-payouts` — **monthly on the 25th in production** (`CDO_PAYOUT_CRON`, default `30 0 25 * *`) and **every 3 minutes in dev** (`CDO_PAYOUT_INTERVAL`). The job's `runAutomatedPayouts()` chains the existing engine with **no manual approval**: accrue → auto-approve eligible commissions → batch → approve → execute (QBO Bill + BillPayment) → settle, fully idempotent (orderId/payoutId guards + partial-unique payout index + QBO `requestid`s) so re-runs never duplicate. Failed payouts raise a structured `cdo.payout.alert` log + console banner + optional webhook (`CDO_PAYOUT_ALERT_WEBHOOK_URL`). New env: `CDO_PAYOUT_CRON/INTERVAL/TZ`, `CDO_SCHEDULER_DISABLED`. **Admin pause/resume controls:** pause an individual commission (`cdo_commissions.paused`, per-row toggle on the Commissions page) or all of a practitioner's payouts (new `cdo_practitioner_holds` collection, toggle on the practitioner Settings tab); both are honored by `getEligibleCommissions` (so `buildPayoutBatch` is pause/hold-aware) with full who/when/why audit. See `docs/payout.md` §7 + §7.1.
- CDO Program: order-ingestion pipeline. The `orders/create` webhook now syncs **every** Shopify order into `cdo_orders` with a complete snapshot (line items, pricing, discounts, taxes, shipping, payment, fulfillment). Orders carrying an eligible practitioner referral code are attributed: they auto-create + link `cdo_referrals` (converted), `cdo_commissions`, the `cdo_transactions` ledger credit, and the first-touch `cdo_applications` customer→practitioner mapping. Added an `orders/cancelled` webhook that reverses unpaid/unbatched commissions. All `cdo_*` writes are centralized in `cdo.service.js` (`ingestShopifyOrder` / `cancelShopifyOrder`); subscribed `orders/create` + `orders/cancelled` and added `read_orders` scope in `shopify.app.toml`. See `docs/payout.md` §15.
- CDO Program: referral codes are now also resolved from **Shopify customer tags** (`CODE:<code>` / `REFERRAL:<code>`) when the order payload carries no code — the order webhook fetches the customer's tags via the Admin API as a fallback after the note-attribute and discount-code sources. Recorded as `attribution.source = "customer_tag"`.
- CDO Program: `cdo_applications` is now the **primary source of truth** for order referral validation + practitioner mapping (`resolveOrderReferral`). The order flow first honors the buyer's existing (non-rejected) `cdo_applications` referral mapping; only when none exists does it fall back to validating the discovered code against the `cdo_practitioner_codes` catalogue (first-touch), creating the mapping. Orders that resolve to neither are treated as standard retail (no referral/commission records).

## 2026.02.09
- Add declarative product metafield definition and demonstrate metafield usage in the product creation flow
- Add declarative metaobject definition and demonstrate metaobject upsert in the product creation flow

## 2026.01.08
- [#170](https://github.com/Shopify/shopify-app-template-react-router/pull/170) - Update React Router minimum version to v7.12.0

## 2025.12.11

- [#151](https://github.com/Shopify/shopify-app-template-react-router/pull/151) Update `@shopify/shopify-app-react-router` to v1.1.0 and `@shopify/shopify-app-session-storage-prisma` to v8.0.0, add refresh token fields (`refreshToken` and `refreshTokenExpires`) to Session model in Prisma schema, and adopt the `expiringOfflineAccessTokens` flag for enhanced security through token rotation. See [expiring vs non-expiring offline tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens#expiring-vs-non-expiring-offline-tokens) for more information.

## 2025.10.10

- [#95](https://github.com/Shopify/shopify-app-template-react-router/pull/95) Swap the product link for [admin intents](https://shopify.dev/docs/apps/build/admin/admin-intents).

## 2025.10.02

- [#81](https://github.com/Shopify/shopify-app-template-react-router/pull/81) Add shopify global to eslint for ui extensions

## 2025.10.01

- [#79](https://github.com/Shopify/shopify-app-template-react-router/pull/78) Update API version to 2025-10.
- [#77](https://github.com/Shopify/shopify-app-template-react-router/pull/77) Update `@shopify/shopify-app-react-router` to V1.
- [#73](https://github.com/Shopify/shopify-app-template-react-router/pull/73/files) Rename @shopify/app-bridge-ui-types to @shopify/polaris-types

## 2025.08.30

- [#70](https://github.com/Shopify/shopify-app-template-react-router/pull/70/files) Upgrade `@shopify/app-bridge-ui-types` from 0.2.1 to 0.3.1.

## 2025.08.17

- [#58](https://github.com/Shopify/shopify-app-template-react-router/pull/58) Update Shopify & React Router dependencies.  Use Shopify React Router in graphqlrc, not shopify-api
- [#57](https://github.com/Shopify/shopify-app-template-react-router/pull/57) Update Webhook API version in `shopify.app.toml` to `2025-07`
- [#56](https://github.com/Shopify/shopify-app-template-react-router/pull/56) Remove local CLI from package.json in favor of global CLI installation
- [#53](https://github.com/Shopify/shopify-app-template-react-router/pull/53) Add the Shopify Dev MCP to the template

## 2025.08.16

- [#52](https://github.com/Shopify/shopify-app-template-react-router/pull/52) Use `ApiVersion.July25` rather than `LATEST_API_VERSION` in `.graphqlrc`.

## 2025.07.24

- [14](https://github.com/Shopify/shopify-app-template-react-router/pull/14/files) Add [App Bridge web components](https://shopify.dev/docs/api/app-home/app-bridge-web-components) to the template.

## July 2025

Forked the [shopify-app-template repo](https://github.com/Shopify/shopify-app-template-remix)

# @shopify/shopify-app-template-remix

## 2025.03.18

-[#998](https://github.com/Shopify/shopify-app-template-remix/pull/998) Update to Vite 6

## 2025.03.01

- [#982](https://github.com/Shopify/shopify-app-template-remix/pull/982) Add Shopify Dev Assistant extension to the VSCode extension recommendations

## 2025.01.31

- [#952](https://github.com/Shopify/shopify-app-template-remix/pull/952) Update to Shopify App API v2025-01

## 2025.01.23

- [#923](https://github.com/Shopify/shopify-app-template-remix/pull/923) Update `@shopify/shopify-app-session-storage-prisma` to v6.0.0

## 2025.01.8

- [#923](https://github.com/Shopify/shopify-app-template-remix/pull/923) Enable GraphQL autocomplete for Javascript

## 2024.12.19

- [#904](https://github.com/Shopify/shopify-app-template-remix/pull/904) bump `@shopify/app-bridge-react` to latest
-
## 2024.12.18

- [875](https://github.com/Shopify/shopify-app-template-remix/pull/875) Add Scopes Update Webhook
## 2024.12.05

- [#910](https://github.com/Shopify/shopify-app-template-remix/pull/910) Install `openssl` in Docker image to fix Prisma (see [#25817](https://github.com/prisma/prisma/issues/25817#issuecomment-2538544254))
- [#907](https://github.com/Shopify/shopify-app-template-remix/pull/907) Move `@remix-run/fs-routes` to `dependencies` to fix Docker image build
- [#899](https://github.com/Shopify/shopify-app-template-remix/pull/899) Disable v3_singleFetch flag
- [#898](https://github.com/Shopify/shopify-app-template-remix/pull/898) Enable the `removeRest` future flag so new apps aren't tempted to use the REST Admin API.

## 2024.12.04

- [#891](https://github.com/Shopify/shopify-app-template-remix/pull/891) Enable remix future flags.

## 2024.11.26

- [888](https://github.com/Shopify/shopify-app-template-remix/pull/888) Update restResources version to 2024-10

## 2024.11.06

- [881](https://github.com/Shopify/shopify-app-template-remix/pull/881) Update to the productCreate mutation to use the new ProductCreateInput type

## 2024.10.29

- [876](https://github.com/Shopify/shopify-app-template-remix/pull/876) Update shopify-app-remix to v3.4.0 and shopify-app-session-storage-prisma to v5.1.5

## 2024.10.02

- [863](https://github.com/Shopify/shopify-app-template-remix/pull/863) Update to Shopify App API v2024-10 and shopify-app-remix v3.3.2

## 2024.09.18

- [850](https://github.com/Shopify/shopify-app-template-remix/pull/850) Removed "~" import alias

## 2024.09.17

- [842](https://github.com/Shopify/shopify-app-template-remix/pull/842) Move webhook processing to individual routes

## 2024.08.19

Replaced deprecated `productVariantUpdate` with `productVariantsBulkUpdate`

## v2024.08.06

Allow `SHOP_REDACT` webhook to process without admin context

## v2024.07.16

Started tracking changes and releases using calver
