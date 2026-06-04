# Practitioner Commission Payout — QuickBooks Online (QBO) Integration

**Status:** Phases 1–4 implemented (manual approve-then-execute); Phase 5 (CRON) and ACH money-movement deferred.
**Workspace:** `ns-retail`
**Owner module:** CDO Program (`app/services/cdo`, `app/services/qbo`)

---

## 1. Overview

The CDO Program pays practitioners a commission on referral-attributed orders. This document describes the **end-to-end payout pipeline**: how commissions are calculated from orders, aggregated into payout batches, approved by an admin, and recorded in **QuickBooks Online as Vendor Bills (Vendor → Bill → BillPayment)** with full audit + reconciliation.

Two principles drive the design:

1. **The CDO QBO account is fully independent.** It uses its own credentials (`CDO_QBO_*`), its own OAuth token store (`cdo_qbo_tokens`), and its own client (`app/services/qbo`). It shares nothing with the wholesale workspace's QBO integration.
2. **Money movement is gated.** Payouts follow an **approve-then-auto-execute** model — a human approves each batch before any QBO posting happens.

> **Scope note on "payment":** QBO `BillPayment` *records* a disbursement in the ledger; it does **not** itself move money over ACH. The actual funds transfer (QBO Bill Pay or an external ACH provider) is a deferred decision — see §8.

---

## 2. Business Requirements

| # | Requirement |
|---|---|
| BR-1 | Commissions are calculated from referral-attributed orders at the rate captured on the order/code. |
| BR-2 | Eligible commissions are aggregated per practitioner into a payout, respecting a configurable **minimum payout amount**. |
| BR-3 | Each payout is recorded in QBO as a **Vendor Bill** against the practitioner (Vendor), then settled with a **BillPayment**. |
| BR-4 | An admin must **approve** a payout before it posts to QBO. |
| BR-5 | The system supports **scheduled** payout runs (15th + month-end) with minimal manual intervention. |
| BR-6 | Every state change is **audit-logged**; balances are reconcilable per practitioner. |
| BR-7 | Commission **reversals/refunds** are supported before payment. |
| BR-8 | All QBO writes are **idempotent** and safely retryable. |

---

## 3. System Architecture

```
                          ns-retail (Shopify embedded admin)
┌──────────────────────────────────────────────────────────────────────────┐
│  Admin UI (React Router routes)                                            │
│   app.cdo-program.payouts.jsx        ── Generate / Approve / Reject /       │
│   app.cdo-program.customers.$id.       Execute (per-practitioner, re-       │
│     payments.jsx                       exports the payouts action)          │
│                         │ fetcher.submit({ _action, payoutId })             │
│                         ▼                                                   │
│  Route action() ─────────────────────────────────────────────────────────┐│
│                         │                                                  ││
│                         ▼                                                  ││
│  services/cdo/cdo.service.js   (orchestration + DB)                        ││
│   accrueCommissionsForOrders · getEligibleCommissions · buildPayoutBatch · ││
│   approvePayout · rejectPayout · executeApprovedPayout · getPayoutDetail   ││
│                 │                              │                            │
│                 ▼                              ▼                            │
│  MongoDB (shared)                  services/qbo/qbo.service.js              │
│   cdo_orders        cdo_payouts      findOrCreateVendor · createBill ·      │
│   cdo_commissions   cdo_transactions createBillPayment · getBill            │
│   cdo_settings      cdo_qbo_vendors            │                            │
│   cdo_qbo_tokens                               ▼                            │
└────────────────────────────────────  services/qbo/qbo.apis.js  ───────────┘
                                         (OAuth2, token rotation, retry,
                                          requestid idempotency)
                                                 │  HTTPS
                                                 ▼
                                   QuickBooks Online  (CDO realm)
                                   Vendor · Bill · BillPayment · Account
```

**Layering rules**

- All QBO HTTP goes through `qbo.apis.js`; domain shapes live in `qbo.service.js`. No QBO calls anywhere else.
- `cdo.service.js` is the only writer of `cdo_*` collections in the payout flow.
- Route render code never imports services (server-only; keeps `process.env`-reading config out of the client bundle).

---

## 4. Commission Lifecycle

```
   order attributed                approve              batched into payout
   (cdo_orders)                    (manual or                 (reserved:
        │                          auto per settings)         payoutId set)
        ▼                               │                          │
   ┌─────────┐   accrue          ┌──────────┐   buildPayoutBatch ┌──────────┐
   │ (order) │ ───────────────▶  │ pending  │ ─────────────────▶ │ approved │
   └─────────┘                   └──────────┘                    └──────────┘
                                      │  ▲                             │
                          reverseCommission│ approveCommission         │ payout executed
                                      ▼  │                             ▼
                                 ┌──────────┐                     ┌────────┐
                                 │ reversed │                     │  paid  │
                                 └──────────┘                     └────────┘
```

| Status | Meaning | Set by |
|---|---|---|
| `pending` | Accrued but not yet approved | `accrueCommissionsForOrders` (when `autoApproveCommissions = false`) |
| `approved` | Eligible to be batched + paid | `accrueCommissionsForOrders` (auto) or `approveCommission` |
| `paid` | Settled by an executed payout | `executeApprovedPayout` |
| `reversed` | Voided before payment (refund/clawback) | `reverseCommission` |

**Eligibility for a payout** (`getEligibleCommissions`): `status = "approved"` **AND** `payoutId = null` **AND** `earnedAt <= periodEnd`. The per-practitioner sum must be `>= cdo_settings.minimumPayoutAmount`.

---

## 5. QBO Integration Flow

```
executeApprovedPayout(payoutId)
        │
        ├─(1) Vendor  ── findOrCreateVendor() ──────────────────────────────┐
        │      cache hit?  cdo_qbo_vendors → reuse qboVendorId               │
        │      else: QBO query by email → by DisplayName → POST /vendor      │
        │      (duplicate-name 6240 → adopt existing) → cache mapping        │
        │                                                                    ▼
        ├─(2) Bill   ── createBill() ── POST /bill                    QBO Vendor.Id
        │      one AccountBasedExpenseLine per commission                    │
        │      → AccountRef = CDO_QBO_COMMISSION_EXPENSE_ACCOUNT_ID          │
        │      requestid = cdo-bill-<payoutId>  (idempotent)                 ▼
        │                                                              QBO Bill.Id
        ├─(3) BillPayment ── createBillPayment() ── POST /billpayment        │
        │      PayType "Check", BankAccountRef = CDO_QBO_PAYMENT_ACCOUNT_ID  │
        │      LinkedTxn → Bill   requestid = cdo-pay-<payoutId>             ▼
        │                                                         QBO BillPayment.Id
        └─(4) Settle: commissions → paid · ledger debit · payout → paid
```

Each step is **guarded by the presence of its result id** on the payout (`qboVendorId` / `qboBillId` / `qboBillPaymentId`), so a re-run after a mid-way failure **resumes** rather than duplicating. See §11.

**Token handling** (`qbo.apis.js`): access tokens are refreshed ~1 min before expiry (`ACCESS_TOKEN_SAFETY_MS`); refresh tokens **rotate** on every refresh and are persisted atomically to `cdo_qbo_tokens`; concurrent refreshes are coalesced; a `401` triggers one forced refresh + retry.

---

## 6. Vendor Bill Workflow

### 6.1 Practitioner → Vendor mapping

Practitioners live in `wholesale_applications` (read-only mirror). We can't stamp a QBO id there, so the mapping is cached in **`cdo_qbo_vendors`** keyed by `(practitionerId, practitionerSource)`.

Resolution order in `findOrCreateVendor`:
1. Cached mapping (`cdo_qbo_vendors`).
2. QBO lookup by `PrimaryEmailAddr`, then `DisplayName` (adopt an existing vendor).
3. `POST /vendor`; on `6240 Duplicate Name` re-query and adopt.

### 6.2 Bill payload (per payout)

```jsonc
POST /v3/company/{realmId}/bill?minorversion=73&requestid=cdo-bill-<payoutId>
{
  "VendorRef": { "value": "<qboVendorId>" },
  "APAccountRef": { "value": "<CDO_QBO_AP_ACCOUNT_ID>" },   // optional
  "DocNumber": "CDO-202606-1b3760",                         // payout.reference
  "PrivateNote": "CDO commission payout … (period ending YYYY-MM-DD)",
  "Line": [
    {
      "DetailType": "AccountBasedExpenseLineDetail",
      "Amount": 20.00,
      "Description": "Commission — #CDO-AARAV-1001 (rate 10.0%)",
      "AccountBasedExpenseLineDetail": {
        "AccountRef": { "value": "<CDO_QBO_COMMISSION_EXPENSE_ACCOUNT_ID>" }
      }
    }
    // … one line per commission in the payout
  ]
}
```

### 6.3 BillPayment payload (settlement)

```jsonc
POST /v3/company/{realmId}/billpayment?minorversion=73&requestid=cdo-pay-<payoutId>
{
  "VendorRef": { "value": "<qboVendorId>" },
  "TotalAmt": 20.00,
  "PayType": "Check",
  "CheckPayment": { "BankAccountRef": { "value": "<CDO_QBO_PAYMENT_ACCOUNT_ID>" } },
  "Line": [
    { "Amount": 20.00, "LinkedTxn": [ { "TxnId": "<qboBillId>", "TxnType": "Bill" } ] }
  ]
}
```

> `PayType: "Check"` with a `BankAccountRef` is QBO's representation of a bank-account disbursement. It records the payment against the bill; it does not initiate an ACH transfer (see §8).

### 6.4 Required Chart-of-Accounts ids

Discover with `npm run cdo:qbo-accounts` (lists every account + `Id`).

| Env var | QBO account type | Use |
|---|---|---|
| `CDO_QBO_COMMISSION_EXPENSE_ACCOUNT_ID` | Expense | Bill expense line |
| `CDO_QBO_PAYMENT_ACCOUNT_ID` | Bank | BillPayment source |
| `CDO_QBO_AP_ACCOUNT_ID` | Accounts Payable | (optional) Bill A/P account |

---

## 7. Payout Automation (CRON) — IMPLEMENTED

The full lifecycle is automated on a schedule via **Agenda** (MongoDB-backed,
ported from the wholesale workspace). **No manual approval** — the run
auto-approves eligible commissions, batches, approves, and executes payouts to
QBO end-to-end. The manual buttons on the Payouts page remain for ad-hoc/retry.

```
Agenda job  process-commission-payouts
   prod cron: 30 0 25 * *  (00:30 on the 25th, CDO_PAYOUT_TZ)
   dev:       every CDO_PAYOUT_INTERVAL   (e.g. "3 minutes")
   │
   ▼  cdo.service.runAutomatedPayouts()
 1. accrueCommissionsForOrders()          // safety net (inline accrual already runs)
 2. autoApproveEligibleCommissions()      // pending → approved (skips paused / held)
 3. buildPayoutBatch({ periodEnd })        // aggregate eligible → awaiting_approval
 4. for each batched payout:
      approvePayout(system) → executeApprovedPayout(system)   // QBO Bill + BillPayment
 5. summary { accrued, approved, batched, paid, failed[] }  + failure alerts
```

**Wiring:** `app/services/scheduler/{scheduler.config,scheduler.service}.js` +
`jobs/processCommissionPayouts.job.js`; the Agenda singleton is booted
fire-and-forget from [app/entry.server.jsx](../app/entry.server.jsx) (guarded —
never blocks SSR; skipped in `test` and when `CDO_SCHEDULER_DISABLED=true`).
`agenda.every(interval|cron, name)` is idempotent on (interval, name), so reboots
don't duplicate the recurring job.

**Idempotency / no duplicate payouts:** accrual is guarded by `orderId`;
auto-approve only flips `pending → approved`; `buildPayoutBatch` reserves
commissions via `payoutId` and is partial-unique on `(practitionerId, periodEnd)`;
`executeApprovedPayout` resumes-not-duplicates via per-step QBO id guards + stable
`requestid`s. The whole run is safely re-runnable.

**Status / date / references:** tracked on `cdo_payouts` — `status`, `paidAt`
(payout date), `reference` (`CDO-YYYYMM-…`), `qboBillId`, `qboBillPaymentId`.

**Failure alerts:** any payout that ends `failed` raises a high-visibility
`log.error("cdo.payout.alert", …)` + console banner, and — only when
`CDO_PAYOUT_ALERT_WEBHOOK_URL` is set — an outbound JSON webhook (never includes
bank details). One failed payout never stops the rest of the batch.

> **Production note:** Agenda coordinates job locks in Mongo, but each app
> process boots its own scheduler. Run a single scheduler-owning process (or
> set `CDO_SCHEDULER_DISABLED=true` on the others) to avoid redundant ticks.

### 7.1 Pause / resume controls

Two independent admin switches hold money out of the automated run (mirrors the
wholesale auto-charge pause pattern — a boolean flag + `{ $ne: true }` eligibility
filter + who/when/why audit fields). Neither unwinds already-paid or already-batched
payouts; they only gate future runs.

| Scope | Where | Storage | Effect |
|---|---|---|---|
| One commission | Commissions page (per-row Pause/Resume) | `cdo_commissions.paused` (+ `pausedAt/By`, `pauseNote`, `resumedAt/By`) | Excluded from auto-approve + `getEligibleCommissions` (so never batched) |
| All of a practitioner's payouts | Practitioner → Settings tab toggle (status badge also shown on the CDO Practitioners list + the practitioner detail header) | `cdo_practitioner_holds.paused` (one row per `practitionerId`) | Every one of their commissions excluded from auto-approve + batching; commissions keep accruing and are tracked, and resume returns all eligible unpaid commissions to the next cycle |

Service API: `pauseCommission` / `resumeCommission`,
`pausePractitionerPayouts` / `resumePractitionerPayouts`, `getPractitionerHold`,
`isPractitionerPaused`, `getHeldPractitionerIds` (all idempotent, in
`cdo.service.js`). `getEligibleCommissions` applies `paused: { $ne: true }` +
`practitionerId ∉ heldIds`, so `buildPayoutBatch` is pause/hold-aware for free.

### 7.2 Batch tracking + per-commission status (traceability)

Every run of `runAutomatedPayouts` (CRON or manual reprocess) persists a durable
**`cdo_payout_batches`** record — the audit/reconciliation layer over the
(unchanged, idempotent) money path. Lifecycle: `running → completed |
completed_with_errors | failed`.

The batch captures: `reference` (CDOB-…), `mode` (`cron` | `manual_reprocess`),
`executionTime` / `startedAt` / `completedAt`, totals (`totalCommissions`,
`totalAmount`, `successCount`, `failedCount`, `skippedCount`), `payoutIds[]`, an
`items[]` snapshot — one entry per commission processed: `{ commissionId,
practitionerId, amount, status (processing|paid|failed|skipped|cancelled),
attempt, failureReason, txnRef (QBO BillPayment/Bill id), payoutId, payoutDate }`,
and a `practitionerPayouts[]` rollup — **one entry per practitioner** (not per
commission): `{ practitionerId, practitionerName/Email, payoutId, commissionCount,
totalAmount, status, txnRef }`.

**One aggregated payout per practitioner.** `buildPayoutBatch` groups eligible
commissions by practitioner and creates a SINGLE `cdo_payouts` row per practitioner
for the summed total (`amount`), linking every underlying commission via
`commissionIds[]` (and each commission's `payoutId`). Three commissions of
$10/$15/$25 for Dr. Parker ⇒ one $50 payout, not three. `practitionerPayouts[]`
surfaces that rollup on the batch; `items[]` is the per-commission audit beneath it.

Each commission also carries a latest-state **payout rollup** on
`cdo_commissions`: `payoutStatus` (pending|processing|paid|failed|skipped|
paused|cancelled), `payoutAttemptCount`, `lastPayoutAttemptAt`, `payoutDate`,
`payoutFailureReason`, `payoutTxnRef`, `lastBatchId`. (`payoutStatus` is the
payout dimension — distinct from the accrual `status`.)

Run flow inside a batch: snapshot eligible pool → `buildPayoutBatch` reserves the
batched ones (→ **processing**, attempt++); eligible-but-unreserved (below-minimum
/ open payout) → **skipped**; each payout `approve → execute` → its commissions
**paid** (txnRef + payoutDate) or **failed** (failureReason). Counts + final
status are written on completion.

**Reprocess** — `reprocessBatch(batchId)` spawns a fresh `manual_reprocess` batch
that re-runs only the source batch's **failed** payouts via the resumable
`executeApprovedPayout` (per-step QBO id guards + stable `requestid` ⇒ never
double-pays), incrementing `payoutAttemptCount`. Service API: `listPayoutBatches`,
`getPayoutBatch`, `getCommissionPayoutHistory`, `reprocessBatch`.

**Admin view** — the **Payout Batches** tab lists every run; the detail page shows
the rollup + the per-commission items table (status / attempt / failure reason /
txn ref / payout date) and a **Reprocess failed** action.

---

## 8. ACH Provider Integration (Future Phase)

QBO records the accounting; it does not, via the `BillPayment` API, move funds to a practitioner's bank. Options for the actual disbursement, to be decided:

```
            ┌─────────────────────────────────────────────┐
 approved   │  Path A — QBO Bill Pay (Melio)               │
 payout ───▶│    QBO-native ACH; minimal new integration   │
            ├─────────────────────────────────────────────┤
            │  Path B — External ACH provider              │
            │    (Dwolla / Stripe / Modern Treasury):      │
            │    initiate ACH credit → poll settlement →    │
            │    mark payout.paidAt only after FUNDS settle │
            └─────────────────────────────────────────────┘
```

**Decisions to lock before go-live:** (a) which path; (b) the semantics of `paid` — "recorded in QBO" vs. "funds settled". If an external provider is used, add a `awaiting_settlement` state + a settlement-poll pass (analogous to the wholesale ACH settlement check), and only set `paid` on confirmed settlement.

---

## 9. Database Design

### 9.1 Entity relationships

```
wholesale_applications (practitioner)        cdo_qbo_tokens (singleton/realm)
        │ 1                                   cdo_settings   (singleton)
        │  practitionerId
        ▼ N
   cdo_qbo_vendors ── qboVendorId ──▶ QBO Vendor
        ▲
        │ practitionerId
 cdo_orders ──1:1── cdo_commissions ──N:1── cdo_payouts ──▶ QBO Bill + BillPayment
        │                  │                      │
        │                  │ commissionIds[]      │
        └──────────────────┴──────────────────────┴──▶ cdo_transactions (ledger)
```

### 9.2 Collections

**`cdo_orders`** — every Shopify order, synced by the `orders/create` webhook (see §15). Holds a complete snapshot: order identity, customer, `lineItems[]`, `pricing{subtotal,totalDiscounts,totalTax,totalShipping,total}`, `discountCodes[]`, `taxLines[]`, `shippingLines[]`, billing/shipping addresses, `payment{gateways[],financialStatus}`, `financialStatus`, `fulfillmentStatus`, `status[pending|approved|paid|cancelled]`, `placedAt`.
`attributed:Boolean` flags orders that resolved to an eligible practitioner code; those also carry `practitionerId/Email/Name`, the immutable `referral` snapshot, `referralCode`, `referralId`, `commissionAmount`, and an `attribution{source,code,matchedAt}` audit. *Indexes:* unique `(shop, shopifyOrderId)` (idempotent upsert). **Program-wide order aggregations scope to attributed orders only** (`practitionerId != null`) so dashboards mean "referral revenue".

**`cdo_commissions`** — one per attributed order.
`practitionerId, practitionerEmail, practitionerName, orderId, orderName, currency, amount, rate, status[pending|approved|paid|reversed], paused (+ pausedAt/By, pauseNote, resumedAt/By), payoutStatus[pending|processing|paid|failed|skipped|paused|cancelled] (+ payoutAttemptCount, lastPayoutAttemptAt, payoutDate, payoutFailureReason, payoutTxnRef, lastBatchId), payoutId, earnedAt`

**`cdo_payout_batches`** — one per automated run (CRON) or manual reprocess of the payout pipeline. The audit/reconciliation record. `reference, mode[cron|manual_reprocess], trigger, executionTime, startedAt, completedAt, status[running|completed|completed_with_errors|failed], totalCommissions, totalAmount, successCount, failedCount, skippedCount, payoutIds[], error, practitionerPayouts[{ practitionerId, practitionerName, practitionerEmail, payoutId, commissionCount, totalAmount, status, txnRef }] (one per practitioner — one aggregated payout each), items[{ commissionId, practitionerId, amount, status[processing|paid|failed|skipped|cancelled], attempt, failureReason, txnRef, payoutId, payoutDate }] (per-commission detail)`. *Indexes:* `(shop, createdAt)`, `(items.commissionId)`.

**`cdo_payouts`** — a disbursement batch.
`practitionerId, practitionerSource, practitionerEmail, practitionerName, currency, amount, method[ach|bank|paypal|check|manual], status[draft|awaiting_approval|approved|processing|paid|failed|rejected|cancelled], commissionIds[], qboVendorId, qboBillId, qboBillPaymentId, billCreatedAt, paymentRecordedAt, approvedBy/At, rejectedBy/At, rejectionReason, lastError, remarks[], periodStart, periodEnd, reference, paidAt`
*Indexes:* `(practitionerId, periodEnd)` partial-unique on open statuses (idempotent batching).

**`cdo_transactions`** — append-only practitioner ledger.
`practitionerId, type[commission|payout|adjustment|reversal], amount (+credit/−debit), balanceAfter, relatedType, relatedId, description, occurredAt`

**`cdo_practitioner_holds`** — admin payout hold, one row per practitioner.
`practitionerId (unique), paused, pausedAt, pausedBy, note, resumedAt, resumedBy`. When `paused`, the automated run excludes all of the practitioner's commissions.

**`cdo_qbo_vendors`** — practitioner → QBO vendor cache.
`practitionerId, practitionerSource, qboVendorId, displayName, email, syncedAt` *(unique on `(practitionerId, practitionerSource)`)*

**`cdo_qbo_tokens`** — CDO QBO OAuth state (separate from wholesale `qbo_tokens`).
`realmId (unique), accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt, tokenType`

**`cdo_settings`** — program singleton.
`defaultCommissionRate, currency, payoutSchedule, minimumPayoutAmount, autoApproveCommissions, …`

---

## 10. API Design

Mutations are React Router **route actions** (embedded-admin), dispatched by a shared `fetcher` with an `_action` field. The action lives on the Payouts route and is **re-exported** by the per-practitioner Payments route so both leaf routes can serve it.

**`POST /app/cdo-program/payouts`** (and `/app/cdo-program/customers/:id/payments`)

| `_action` | Body | Service call | Effect |
|---|---|---|---|
| `generate-batch` | `periodEnd?` | `accrueCommissionsForOrders` → `buildPayoutBatch` | Calculate + aggregate → `awaiting_approval` payouts |
| `approve` | `payoutId` | `approvePayout` | `awaiting_approval → approved` |
| `reject` | `payoutId, reason?` | `rejectPayout` | `→ rejected`, release commissions |
| `execute` | `payoutId` | `executeApprovedPayout` | Vendor → Bill → BillPayment → `paid` |

**Service API (server)** — `app/services/cdo/cdo.service.js`:
`accrueCommissionsForOrders` · `approveCommission` · `reverseCommission` · `getEligibleCommissions` · `buildPayoutBatch` · `approvePayout` · `rejectPayout` · `executeApprovedPayout` · `getPayoutDetail` · `listPayouts` · `listPractitionerPayouts`

**QBO API (server)** — `app/services/qbo/qbo.service.js`:
`findOrCreateVendor` · `createBill` · `getBill` · `createBillPayment` · `vendorWebUrl` · `billWebUrl`

**Operational scripts:**
`npm run cdo:qbo-accounts` (list COA ids / verify connection; `-- --reset` clears the stored token) · `npm run seed:cdo-ref` · `npm run seed:cdo-activity`

---

## 11. Error Handling & Reconciliation

### 11.1 Error model

- `qbo.apis.js` classifies failures: `TransientError` (5xx / 429 / network) → retried with exponential backoff + jitter (`CDO_QBO_HTTP_RETRY_*`); `PermanentError` (4xx auth/validation, QBO `Fault`) → no retry.
- `401` → one forced token refresh + retry.

### 11.2 Idempotency (no duplicate money)

| Risk | Guard |
|---|---|
| Same commission batched twice | `payoutId` reservation + eligibility filter `payoutId: null` |
| Two payouts for same practitioner/period | partial-unique index on open statuses + pre-check in `buildPayoutBatch` |
| QBO create re-fired after a lost response | stable `requestid` (`cdo-bill-<id>` / `cdo-pay-<id>`) — QBO dedups |
| Re-running a half-done execution | per-step guards on `qboVendorId` / `qboBillId` / `qboBillPaymentId` |

A failed execution sets `status = failed` + `lastError`; **Retry** re-runs `executeApprovedPayout`, resuming from the first incomplete step.

### 11.3 Reconciliation

- **Audit ledger:** every payout transition appends a `remarks[]` entry (`kind`, `message`, `actor`, `source`, `createdAt`).
- **Balance ledger:** `cdo_transactions` records a commission credit at accrual and a payout debit at execution, each with a running `balanceAfter` — a practitioner's outstanding balance is auditable over time.
- **QBO cross-reference:** `qboVendorId` / `qboBillId` / `qboBillPaymentId` on each payout + deep links (`billWebUrl`) let an operator open the exact QBO record.

---

## 12. Security Considerations

- **Credential isolation:** CDO uses dedicated `CDO_QBO_*` secrets + a dedicated token collection; no overlap with the wholesale QBO realm.
- **Secrets in env only:** all credentials read via config (`qbo.config.js`); never logged. `.env` is gitignored; `.env.example` documents the keys.
- **Token rotation persisted atomically** to survive crash-after-refresh.
- **Approval gate:** no QBO posting without an admin `approve`; the actor is recorded.
- **Least privilege:** the CDO QBO app needs only `com.intuit.quickbooks.accounting`.
- **Accounting hygiene:** consistent expense + A/P accounts; Bill `DocNumber` = payout reference for traceability; amounts rounded to 2 decimals; reversals before payment (never silent edits to posted QBO docs).

---

## 13. Sequence Diagrams

### 13.1 Generate → Approve → Execute

```
Admin        Payouts route        cdo.service             qbo.service        QBO
  │ Generate batch │                   │                       │              │
  ├───────────────▶│ accrue+batch      │                       │              │
  │                ├──────────────────▶│ accrueCommissions     │              │
  │                │                   │ buildPayoutBatch       │              │
  │                │◀──────────────────┤ (awaiting_approval)    │              │
  │◀── toast ──────┤                   │                       │              │
  │ Approve        │                   │                       │              │
  ├───────────────▶│ approvePayout ───▶│ status=approved        │              │
  │ Execute        │                   │                       │              │
  ├───────────────▶│ executeApproved ─▶│ findOrCreateVendor ──▶│ query/POST ─▶│
  │                │                   │                       │◀── Vendor.Id ┤
  │                │                   │ createBill ──────────▶│ POST /bill ─▶│
  │                │                   │                       │◀── Bill.Id ──┤
  │                │                   │ createBillPayment ───▶│ POST /bp ───▶│
  │                │                   │                       │◀── BP.Id ────┤
  │                │                   │ commissions=paid       │              │
  │                │                   │ ledger debit, paid     │              │
  │◀── toast ──────┤◀──────────────────┤                       │              │
```

### 13.2 Failure + retry (idempotent)

```
execute → vendor OK → bill OK (qboBillId saved) → billpayment TIMEOUT
   → status=failed, lastError set
Admin clicks Retry:
execute → qboVendorId present (skip) → qboBillId present (skip)
        → createBillPayment requestid=cdo-pay-<id>  (QBO returns original, no dup)
        → paid
```

---

## 14. Production Deployment Notes

1. **Provision the CDO QBO app** (Intuit Developer): set `CDO_QBO_CLIENT_ID/SECRET`, `CDO_QBO_REALM_ID`, `CDO_QBO_ENVIRONMENT=production`, and seed `CDO_QBO_REFRESH_TOKEN`.
2. **Set Chart-of-Accounts ids:** run `npm run cdo:qbo-accounts`, copy `CDO_QBO_COMMISSION_EXPENSE_ACCOUNT_ID`, `CDO_QBO_PAYMENT_ACCOUNT_ID`, (`CDO_QBO_AP_ACCOUNT_ID`).
3. **Verify connection** with the same helper (lists accounts on success).
4. **Tune program settings** (`cdo_settings`): `minimumPayoutAmount`, `autoApproveCommissions`, `payoutSchedule`, `defaultCommissionRate`, `currency`.
5. **Token lifecycle:** Mongo (`cdo_qbo_tokens`) is the source of truth after first run; production refresh tokens last ~100 days and auto-rotate. Keep a procedure to re-seed (`-- --reset`) if revoked.
6. **Single scheduler instance** (when Phase 5 lands): one process owns Agenda to avoid double-runs; jobs lock via Agenda.
7. **Decide ACH path + `paid` semantics** (§8) before enabling automated execution at scale.
8. **Pre-flight checklist:** sandbox dry-run of generate → approve → execute; confirm Vendor/Bill/BillPayment in QBO; verify `cdo_transactions` balance and `remarks[]` trail; test the retry path.

---

## 15. Order Ingestion (orders/create → cdo_orders)

The upstream of the whole commission pipeline. The `orders/create` webhook
([webhooks.orders.create.jsx](../app/routes/webhooks.orders.create.jsx)) verifies
HMAC, dedups the webhook id, returns `200` immediately, then fire-and-forgets
`cdo.service.ingestShopifyOrder`. Per the §3 layering rule, **all `cdo_*` writes
happen in the service**; the route only resolves the code (incl. Shopify API
reads) + tags the customer.

**Code discovery** (the referral code isn't always on the order). The route
gathers a candidate code, in order: (1) the `cdo_practitioner_code` order/cart
**note attribute**; (2) a practitioner-shaped **discount code** on the order;
(3) a `CODE:<code>` / `REFERRAL:<code>` **tag on the Shopify customer** (fetched
via the Admin API). It passes the candidate + its discovery source into the
pipeline.

**Referral resolution** — `cdo_applications` is the **primary source of truth**;
`cdo_practitioner_codes` is the catalogue fallback (`resolveOrderReferral`):
1. **Existing mapping (primary).** If the buyer already has a non-rejected
   `cdo_applications` record carrying a `referral`, that frozen snapshot *is* the
   customer→practitioner relationship — use it directly (`attribution.source =
   "cdo_application"`). No catalogue lookup needed.
2. **First-touch (fallback).** No mapping yet but a code was discovered: validate
   it case-insensitively against `cdo_practitioner_codes` (active + still-eligible
   practitioner). On success the pipeline attributes the order **and** creates the
   `cdo_applications` mapping, so order #1 is attributed and the relationship is
   established from then on.
3. **Neither** ⇒ the order is stored unattributed — a standard retail order, no
   referral/commission records.

```
orders/create ─▶ ingestShopifyOrder({ shop, payload, rawCode, attributionSource })
   │  resolveOrderReferral()   // cdo_applications mapping → else catalogue (rawCode)
   ▼
   upsert cdo_orders (by shop+shopifyOrderId, full snapshot)   ← EVERY order
        │  attributed? (eligible code resolved)
        ├─ no  ─▶ done (attributed:false, commissionAmount:0)
        └─ yes ─▶ upsert cdo_referrals (converted, links orderId)
                  createCommissionForOrder → cdo_commissions + cdo_transactions credit
                  first-touch cdo_applications mapping (customer → practitioner)
                  tag Shopify customer `code:<canonical>`
```

- **Commission base** = order **subtotal** (product revenue, excl. tax + shipping) × the code's `commissionRate`. `amount` on the order = gross `total_price` (revenue figure read by dashboards).
- **Idempotency**: orders upsert by `(shop, shopifyOrderId)`; commissions are guarded by `orderId`; referral conversion is one row per `(referralCode, referredEmail)`. Shopify's at-least-once delivery + replays don't duplicate. (An in-memory 5-min webhook-id cache is a fast-path on top.)
- **Audit**: each order stores the `attribution{source,code,matchedAt}` and `referral` snapshot; commission accrual + reversal post `cdo_transactions` ledger entries with running `balanceAfter`.

**Cancellation** ([webhooks.orders.cancelled.jsx](../app/routes/webhooks.orders.cancelled.jsx) → `cancelShopifyOrder`): marks the `cdo_order` `cancelled` and reverses its commission **only if** it isn't `paid` or reserved into a payout (`payoutId` set) — posting a `reversal` ledger debit. Posted/batched money is never silently reversed.

> **Scopes:** receiving `orders/*` requires `read_orders` and Shopify **protected customer data** approval. `shopify.app.toml` subscribes both topics; production stores must be approved before delivery starts.

---

## 16. Reporting + analytics

**Analytics definitions** (`getDashboardMetrics` / `getPractitionerKpis`):
- **Total Commission Earned** = Σ commissions with `status ≠ reversed`.
- **Total Commission Paid** = Σ commissions with `status = paid`.
- **Outstanding Liability** = Earned − Paid (the unpaid, non-reversed accrued balance).
- **Pending Payouts** = Σ `cdo_payouts` in `{awaiting_approval, approved, processing}`.
  (There is **no** `pending` payout status — the prior filter `status ∈ {pending,processing}`
  silently matched nothing; fixed.)
- **Failed Payouts** = count + Σ of `cdo_payouts.status = failed`.

**Upcoming payout preview** (`getUpcomingPayouts`) — a no-write dry-run of the batch
grouping: eligible commissions (`getEligibleCommissions` — approved, unpaid, not paused, not
on practitioner hold) grouped by practitioner; practitioners clearing `minimumPayoutAmount`
form the breakdown. Returns `{ estimatedDate (next 25th), totalAmount, practitionerCount,
commissionCount, breakdown[], belowMinimumCount }`. Shown on the Dashboard so admins see
next-cycle spend before the CRON runs. Per-practitioner KPIs (`getPractitionerKpis`) add
earned / paid / pending / upcoming / referred-customers / referral-orders / lifetime-revenue /
last-payout-date / next-expected, plus a payout-history table on the practitioner page.

**Batch detail** enriches each `practitionerPayouts` entry (via `getPayoutBatch`) with the
QBO **vendor-bill** deep link, method, `paidAt`, and the payout `remarks[]` audit trail.

## 17. Orders module (`/app/orders`)

A top-level admin view over the **entire** `cdo_orders` collection (attributed + retail),
distinct from the attributed-only CDO Program → Orders tab. Server-side
pagination/filter/sort via `listCdoOrders({ page, pageSize, sort, dir, filters })` — filters:
orderNumber, customer, practitioner, referralCode, status (order), financialStatus (payment),
commissionStatus (attributed/unattributed), dateFrom/dateTo; sort by placedAt|amount|
commissionAmount. `getCdoOrderDetail(id)` returns the full snapshot (customer, referral,
practitioner, line items, pricing/discounts/taxes/shipping, payment, commission record(s),
timeline + attribution audit) for the detail page.

**Service API additions:** `getUpcomingPayouts` · `listCdoOrders` · `getCdoOrderDetail`
(reporting/reads, in `cdo.service.js`).

---

### Appendix — Environment variables

```
CDO_QBO_ENVIRONMENT=sandbox|production
CDO_QBO_CLIENT_ID=            CDO_QBO_CLIENT_SECRET=
CDO_QBO_REALM_ID=            CDO_QBO_REFRESH_TOKEN=
CDO_QBO_MINOR_VERSION=73
CDO_QBO_COMMISSION_EXPENSE_ACCOUNT_ID=
CDO_QBO_PAYMENT_ACCOUNT_ID=
CDO_QBO_AP_ACCOUNT_ID=                      # optional
# optional retry tuning
CDO_QBO_HTTP_RETRY_ATTEMPTS=4  CDO_QBO_HTTP_RETRY_BASE_MS=500  CDO_QBO_HTTP_RETRY_MAX_MS=4000

# ── Payout scheduler (§7) ──
CDO_PAYOUT_CRON=30 0 25 * *                 # prod: 00:30 on the 25th
CDO_PAYOUT_TZ=America/Los_Angeles
CDO_PAYOUT_INTERVAL=3 minutes               # DEV ONLY — overrides the cron; leave unset in prod
CDO_SCHEDULER_DISABLED=                     # set "true" to never boot the scheduler
CDO_PAYOUT_ALERT_WEBHOOK_URL=               # optional — POSTed on a failed payout
```
