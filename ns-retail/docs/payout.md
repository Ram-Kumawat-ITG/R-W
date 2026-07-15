# Practitioner Commission Payout — QuickBooks Online (QBO) Integration

**Status:** Phases 1–4 implemented (manual approve-then-execute); Phase 5 (CRON) and ACH money-movement deferred.
**Workspace:** `ns-retail`
**Owner module:** CDO Program (`app/services/cdo`, `app/services/qbo`)

---

## 1. Overview

The CDO Program pays practitioners a commission on referral-attributed orders. This document describes the **end-to-end payout pipeline**: how commissions are calculated from orders, aggregated into payout batches, approved by an admin, and recorded in **QuickBooks Online as Vendor Bills (Vendor → Bill → BillPayment)** with full audit + reconciliation.

Two principles drive the design:

1. **The QBO integration is independent from wholesale.** It uses its own Intuit app (shared `QBO_*` app credentials + the `QBO_RETAIL_*` company), its own OAuth token store (`cdo_qbo_tokens`), and its own clients (`app/services/qbo` for payout Bills, `app/services/retailQbo` for A/R invoices). It shares nothing with the wholesale workspace's QBO integration.
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

### 4.1 Commission amount — per-vendor, per-line (versioned + snapshotted)

Commission is **vendor-driven**, configured per Shopify **product vendor** on the
Settings → **Commission Configuration** tab and stored on
`cdo_settings.vendorCommissions[] = { vendor, commissionPercent (fraction), updatedAt, updatedBy }`.

- **Calc** (`computeOrderCommission`): for each order line,
  `lineRevenue = price×qty − totalDiscount` and `lineCommission = lineRevenue × vendorRate`,
  where `vendorRate` is the configured fraction for the line's `vendor` (matched
  case-insensitively) — **0% when that vendor isn't configured** (commission is purely
  vendor-driven; the practitioner code rate / `defaultCommissionRate` no longer set the amount).
  `order.commissionAmount = Σ lineCommission`. The order's line items capture
  `lineItems[].vendor` (from the Shopify `orders/create` payload) at ingest.
- **Snapshot + immutability** (the core guarantee): commission is computed and snapshotted
  **exactly once, at first ingest** (order creation) into `cdo_orders.commissionSnapshot =
  { configVersion, vendorRates[], lines[{vendor,revenue,rate,amount}], effectiveRate, computedAt }`.
  `ingestShopifyOrder` skips recomputation when the order already exists, so re-ingests
  (`orders/updated`, `orders/paid`, replays) **never** alter an existing order's commission.
  Config edits bump `cdo_settings.commissionConfigVersion` and apply **only to future orders**;
  existing orders + their `cdo_commissions` are unaffected. The `cdo_commission` record's `rate`
  is the snapshot's blended `effectiveRate` (= commissionAmount ÷ Σ line revenue).
- **Referral-rate snapshot is authoritative** (no live re-read): a returning customer's
  order uses the `commissionRate` / `discountPercent` frozen in their
  `cdo_applications.referral` snapshot at signup. `resolveOrderReferral` does **not**
  re-read the practitioner's current catalogue rate (which would silently re-rate future
  orders with no audit trail); it only fills a *missing* rate from the live code / program
  default. The snapshot is the audit trail of the terms in effect at signup.
- **Legacy fallback (compute-on-read)**: orders ingested before snapshots existed have
  `commissionSnapshot: null`. `projectCommissionSnapshot(order)` reconstructs a best-effort
  single blended line (`commissionAmount ÷ subtotal`, flagged `reconstructed`) so the Order
  Details "Commission breakdown" still explains the math; `scripts/backfill-cdo-commission-snapshots.js`
  persists those reconstructed snapshots.
- **Audit**: every vendor-rate change (set/remove) appends a row to
  **`cdo_commission_config_history`** (`vendor, action, previousPercent, newPercent, version,
  changedBy, changedAt`), surfaced as "Recent changes" on the Commission Configuration tab.
- **Settings UI**: `/app/cdo-program/settings` is a layout with sub-tabs (extensible via
  `SettingsTabs`). The only tab is **Commission Configuration** (lists Shopify product vendors
  via the `productVendors` Admin GraphQL query + a per-vendor "Commission Setup" modal); the
  settings index redirects there. ⚠️ Until vendors are configured, attributed orders accrue $0 —
  the tab warns about this. (A read-only Global Configuration tab over the `cdo_settings`
  singleton was removed; the singleton is still tuned directly per §14.)

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
        │      → AccountRef = QBO_RETAIL_COMMISSION_EXPENSE_ACCOUNT_ID          │
        │      requestid = cdo-bill-<payoutId>  (idempotent)                 ▼
        │                                                              QBO Bill.Id
        ├─(3) BillPayment ── createBillPayment() ── POST /billpayment        │
        │      PayType "Check", BankAccountRef = QBO_RETAIL_PAYMENT_ACCOUNT_ID  │
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
  "APAccountRef": { "value": "<QBO_RETAIL_AP_ACCOUNT_ID>" },   // optional
  "DocNumber": "CDO-202606-1b3760",                         // payout.reference
  "PrivateNote": "CDO commission payout … (period ending YYYY-MM-DD)",
  "Line": [
    {
      "DetailType": "AccountBasedExpenseLineDetail",
      "Amount": 20.00,
      "Description": "Commission — #CDO-AARAV-1001 (rate 10.0%)",
      "AccountBasedExpenseLineDetail": {
        "AccountRef": { "value": "<QBO_RETAIL_COMMISSION_EXPENSE_ACCOUNT_ID>" }
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
  "CheckPayment": { "BankAccountRef": { "value": "<QBO_RETAIL_PAYMENT_ACCOUNT_ID>" } },
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
| `QBO_RETAIL_COMMISSION_EXPENSE_ACCOUNT_ID` | Expense | Bill expense line |
| `QBO_RETAIL_PAYMENT_ACCOUNT_ID` | Bank | BillPayment source |
| `QBO_RETAIL_AP_ACCOUNT_ID` | Accounts Payable | (optional) Bill A/P account |

### 6.5 Commission banking — source of truth + validation gate

The practitioner's payout **destination** bank details are NOT stored in any
`cdo_*` collection. They live on the canonical **`wholesale_applications.commission`**
object (written by the wholesale workspace), e.g.:

```jsonc
"commission": {
  "enabled": true,
  "bankAccountName": "Durgesh",
  "bankRoutingNumber": "490000018",
  "bankAccountNumber": "24413815",
  "bankAccountLast4": "3815",
  "bankAccountType": "Checking",
  "sourcedFromPaymentAch": false,
  "updatedAt": "2026-06-10T07:30:08.800Z"
}
```

`executeApprovedPayout` reads this **fresh at execution time** (never cached — so
a payout always uses the LATEST banking on file) via
`resolvePractitionerBanking(practitionerId)` and **validates before any QBO write
or disbursement**:

| Field | Rule |
|---|---|
| `enabled` | must not be `false` |
| `bankAccountName` | non-empty |
| `bankRoutingNumber` | 9 digits, valid ABA mod-10 checksum |
| `bankAccountNumber` | 4–17 digits |
| `bankAccountType` | `Checking` or `Savings` (case-insensitive) |

- **Invalid / missing** → the payout is **flagged and aborted**: `status → failed`,
  `bankingError` set, a `bank_invalid` remark with the specific reasons, a
  `log.warn("payout.bank_invalid", …)` (reasons only — never the account number).
  On the manual path the admin sees the reason as a toast; on the CRON the payout
  becomes a failed batch item + `cdo.payout.alert`. A re-run after the practitioner
  fixes their details proceeds.
- **Valid** → a **masked** snapshot is recorded on the payout for audit /
  reconciliation (`bankSnapshot{ accountName, routingNumber, accountLast4,
  accountType, sourcedFromPaymentAch, bankingUpdatedAt, capturedAt }`) + a
  `bank_validated` remark, and the destination (`name · type ••••last4 · routing`)
  is written to the QBO Bill `PrivateNote`.

**Security:** the full `bankAccountNumber` is used only transiently by the
execution step — it is **never persisted** (only `accountLast4` + `routingNumber`
are stored) and **never logged**. `bankingUpdatedAt` records exactly which version
of the practitioner's banking (`commission.updatedAt`) a payout used.

> This is the validated banking-data foundation the future ACH provider (§8) will
> consume. QBO `BillPayment` still only records the accounting; it does not move
> funds to the practitioner's bank.

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
 4. IF CDO_PAYOUT_REQUIRE_APPROVAL (default true):
      STOP — payouts wait in awaiting_approval for an admin to Approve + Execute.
      The CRON moves NO money. (§8.3)
    ELSE (legacy auto-disburse):
      for each batched payout: approvePayout → executeApprovedPayout
        ├─ resolvePractitionerBanking()   // §6.5 — validate banking BEFORE any QBO write
        │    └─ invalid → status=failed + bank_invalid (no QBO write)
        ├─ QBO Vendor + Bill              // records the liability
        └─ provider.initiateTransfer()    // → awaiting_settlement (NOT paid)
 5. summary { accrued, approved, batched, awaitingApproval, paid, failed[] }  + alerts

Settlement (separate CRON — §8.4):
 process-payout-settlements → checkPayoutSettlement(payout):
   settled → QBO BillPayment + commissions paid + ledger debit → paid
   returned → failed (R-code captured); commissions kept reserved for retry
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

## 8. Real-money disbursement + settlement — IMPLEMENTED (provider-agnostic)

QBO records the accounting; its `BillPayment` API does **not** move funds to a practitioner's bank. The actual bank→bank transfer now flows through a **provider-agnostic disbursement layer** (`app/services/payout/`), and `paid` means **funds settled**, not "recorded in QBO".

### 8.1 Money flow + lifecycle

```
 approved ──(admin Execute)──▶ executeApprovedPayout
   │  banking gate (§6.5)
   │  QBO Vendor + Bill            ← records the LIABILITY (we owe the commission)
   │  provider.initiateTransfer()  ← initiates the bank→bank ACH credit
   ▼
 awaiting_settlement   (providerTransferId stored; NO "paid" yet)
   │
   │  process-payout-settlements CRON (or admin "Sync settlement")
   │     → provider.getTransferStatus(transferId)
   ▼
 ┌── settled  → QBO BillPayment + commissions paid + ledger debit → paid
 ├── returned → failed (capture R-code); commissions kept reserved → retry re-disburses
 └── pending  → stay awaiting_settlement (normal 1–3 business-day ACH window)
```

- **FROM** the business bank account (QBO `QBO_RETAIL_PAYMENT_ACCOUNT_ID`); **TO** the practitioner's account (`wholesale_applications.commission`, §6.5).
- **`paid` is set only on confirmed settlement.** The QBO BillPayment is recorded at settlement (not at execution), so the books only claim "paid" once money has actually moved.
- **Returns** (R01 NSF, R02 closed, R03 no account…) flip the payout to `failed` with `returnCode`/`returnReason`/`returnedAt`; the commissions stay reserved to the payout so **Execute** re-disburses the same payout (fresh idempotency key) once banking is fixed — no re-batching, no double-pay.

### 8.2 Provider abstraction

`getPayoutProvider()` (`app/services/payout/provider/`) returns an adapter implementing:

```
initiateTransfer({ amount, currency, destination, idempotencyKey, reference, metadata })
  → { transferId, status: pending|settled|failed, returnCode?, returnReason? }
getTransferStatus(transferId)
  → { status: pending|settled|returned|failed, returnCode?, returnReason?, settledAt? }
```

Adapters MUST be idempotent on `idempotencyKey` (`cdo-payout-<payoutId>-<attempt>`) so a retried initiation never double-sends.

- **`sandbox`** (default, `CDO_PAYOUT_PROVIDER=sandbox`) — in-process simulator; no real money. Encodes outcome + initiation time into the transfer id. **Magic test values:** account ending `9999` → rejected at initiation (R03); `0000` → returns (R01) after the settle delay; anything else → settles after `CDO_PAYOUT_SANDBOX_SETTLE_SECONDS`.
- **`dwolla`** (`CDO_PAYOUT_PROVIDER=dwolla`) — **implemented** real ACH rail (`provider/dwollaProvider.js`, raw REST, no SDK). Per payout it: find-or-creates a **receive-only Customer** for the practitioner (by email), find-or-creates their bank **Funding Source** (routing/account/type — Dwolla dedupes via its duplicate-resource link), then creates a **Transfer** from the business funding source (`DWOLLA_FUNDING_SOURCE`) → the practitioner, with the `idempotencyKey` as Dwolla's `Idempotency-Key`. `getTransferStatus` maps Dwolla `processed → settled`, `failed/cancelled/reclaimed → returned` (with the ACH R-code from `/transfers/{id}/failure`), else `pending`. OAuth2 client-credentials token cached + auto-refreshed. Config: `DWOLLA_ENVIRONMENT` (sandbox|production), `DWOLLA_KEY`, `DWOLLA_SECRET`, `DWOLLA_FUNDING_SOURCE`. **Automated sandbox settlement (no dashboard step):** Dwolla Sandbox holds bank transfers in `pending` until "processed" — normally the dashboard's *Process Bank Transfers* button. The adapter implements the optional `processPendingTransfers()` contract method over that action's API (`POST /sandbox-simulations`, body `{}` → 202, processes/fails the last 500 pending transfers), and the settlement CRON calls it each tick **before** polling (no-op in production, where real ACH settles on its own), so transfers move pending → processed → settled fully automatically with zero Dwolla-dashboard interaction. (A bank→bank transfer has two legs, so the per-tick CRON may take two ticks to fully clear one — it converges automatically.) *Note: receive-only customers + transfers need a verified business funding source on the Dwolla account; settlement is polled today — a webhook handler (`customer_bank_transfer_completed/_failed`) would settle faster (future).* 
- **`stripe` / `modern_treasury`** — not yet implemented; the factory throws a clear error until the adapter file + credentials are added. Dropping one in is a single new file + registering it in the factory; no changes to the payout logic.

### 8.3 Human-approval gate

`CDO_PAYOUT_REQUIRE_APPROVAL` (default **true**): the automated CRON accrues + auto-approves commissions + builds payouts that **wait in `awaiting_approval`** — an admin must **Approve + Execute** to move money. Set to `false` only for the legacy end-to-end auto-disburse path (discouraged with real money).

### 8.4 Settlement reconciliation CRON

`process-payout-settlements` (Agenda) first calls `advancePendingPayoutTransfers()` (provider-optional, best-effort — triggers Dwolla Sandbox's batch processing via API; no-op on production ACH), then sweeps every `awaiting_settlement` payout and calls `checkPayoutSettlement`. Cadence: `CDO_SETTLEMENT_CRON` (prod, default every 6h) / `CDO_SETTLEMENT_INTERVAL` (dev). The admin **Sync settlement** button runs the same check for one payout on demand. Net effect: from the monthly payout CRON through final settlement, the loop is fully automated end-to-end — no Dwolla-dashboard interaction in sandbox or production.

On settle/return, `finalizeSettledPayout` / the return branch also call `reflectPayoutOnBatches` to update the **batch snapshot** that processed the payout — its run-time items were recorded as `processing` (ACH is async, settled later by this CRON), so without this the Payout Batches view (Paid/Failed/Skipped/**Processing**) would stay frozen on `processing` after the payout actually settled. The reflect updates the matching `items[]` + recomputes the stored counts, so the batch reflects the final outcome.

> **Still to lock before real go-live** (see Commission.md §9): choose + contract a real provider, bank-account ownership verification (micro-deposit/Plaid), encrypt/tokenize stored account numbers, funding-balance pre-check + payout caps, 1099/W-9 enforcement, and the NACHA originator agreement.

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
`practitionerId, practitionerSource, practitionerEmail, practitionerName, currency, amount, method[ach|bank|paypal|check|manual], status[draft|awaiting_approval|approved|processing|awaiting_settlement|paid|failed|rejected|cancelled], commissionIds[], qboVendorId, qboBillId, qboBillPaymentId, billCreatedAt, paymentRecordedAt, approvedBy/At, rejectedBy/At, rejectionReason, lastError, remarks[] (kinds incl. bank_validated / bank_invalid / transfer_initiated / settled / returned), bankSnapshot{accountName, routingNumber, accountLast4, accountType, sourcedFromPaymentAch, bankingUpdatedAt, capturedAt} (MASKED destination banking captured at execution from wholesale_applications.commission — §6.5; full account number never stored), bankingError, providerName, providerTransferId, providerStatus[pending|settled|returned|failed], transferInitiatedAt, transferAttemptCount, settledAt, settlementLastCheckedAt, returnCode, returnReason, returnedAt, periodStart, periodEnd, reference, paidAt`
*Settlement lifecycle (§8): execute → `awaiting_settlement` (transfer initiated, QBO Bill recorded) → settlement poll → `paid` (QBO BillPayment recorded, funds settled) or `failed` (ACH return; commissions kept reserved for retry).*
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
`defaultCommissionRate, currency, payoutSchedule, minimumPayoutAmount, autoApproveCommissions, cookieWindowDays, vendorCommissions[] (per-vendor rates), commissionConfigVersion`

**`cdo_commission_config_history`** — append-only audit of per-vendor commission-rate changes
(`vendor, action: set|remove, previousPercent, newPercent, version, changedBy, changedAt`). See §4.1.

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

- `qbo.apis.js` classifies failures: `TransientError` (5xx / 429 / network) → retried with exponential backoff + jitter (`QBO_HTTP_RETRY_*`); `PermanentError` (4xx auth/validation, QBO `Fault`) → no retry.
- `401` → one forced token refresh + retry.

### 11.2 Idempotency (no duplicate money)

| Risk | Guard |
|---|---|
| **Two commissions for one order** (concurrent webhooks) | **UNIQUE partial index on `cdo_commissions.orderId`** + `createCommissionForOrder` E11000 catch → loser treated as "already created", no second ledger entry. (Pre-existing dupes must be cleared via `scripts/dedupe-cdo-commissions.js` before the index can build.) |
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

- **Credential isolation:** CDO uses dedicated QBO secrets (`QBO_*` / `QBO_RETAIL_*`) + a dedicated token collection; no overlap with the wholesale QBO realm.
- **Secrets in env only:** all credentials read via config (`qbo.config.js`); never logged. `.env` is gitignored; `.env.example` documents the keys.
- **Token rotation persisted atomically** to survive crash-after-refresh.
- **Approval gate:** no QBO posting without an admin `approve`; the actor is recorded.
- **Least privilege:** the CDO QBO app needs only `com.intuit.quickbooks.accounting`.
- **Accounting hygiene:** consistent expense + A/P accounts; Bill `DocNumber` = payout reference for traceability; amounts rounded to 2 decimals; reversals before payment (never silent edits to posted QBO docs).
- **Practitioner bank details (§6.5):** read fresh from `wholesale_applications.commission` at execution time, validated before any disbursement. The full `bankAccountNumber` is **transient only** — never persisted to `cdo_payouts` (only `accountLast4` + `routingNumber` are snapshotted) and **never logged** (failure logs carry validation reasons, not the number); the alert webhook already excludes bank details.

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

1. **Provision the QBO app** (Intuit Developer): set `QBO_CLIENT_ID/SECRET`, `QBO_RETAIL_REALM_ID`, `QBO_ENVIRONMENT=production`, and seed `QBO_RETAIL_REFRESH_TOKEN`.
2. **Set Chart-of-Accounts ids:** run `npm run cdo:qbo-accounts`, copy `QBO_RETAIL_COMMISSION_EXPENSE_ACCOUNT_ID`, `QBO_RETAIL_PAYMENT_ACCOUNT_ID`, (`QBO_RETAIL_AP_ACCOUNT_ID`).
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
orders/create | orders/paid | orders/updated ─▶ ingestShopifyOrder(...)
   │  resolveOrderReferral()   // cdo_applications mapping → else catalogue (rawCode)
   ▼
   upsert cdo_orders (by shop+shopifyOrderId, full snapshot)   ← EVERY order
        │  attributed? (eligible code resolved)
        ├─ no  ─▶ done (attributed:false, commissionAmount:0)
        └─ yes ─▶ upsert cdo_referrals (converted, links orderId)
                  first-touch cdo_applications mapping (customer → practitioner)
                  ── commission gated on PAYMENT ──
                    PAID            → createCommissionForOrder → cdo_commissions + ledger credit
                    refunded/void/cancel → reverseOrderCommission (if not paid/batched) → ledger debit
                    unpaid/pending  → deferred (no commission yet)
                  tag Shopify customer `code:<canonical>`
```

**Commissions only for paid orders.** A commission RECORD is created only once
the order is `financial_status = paid` (and not cancelled). Referral mapping +
conversion are captured at any payment state (attribution survives before
payment), but the money record waits for payment:
- `orders/create` with an already-paid order → commission now.
- `orders/create` unpaid → no commission; **`orders/paid`** later → commission created.
- **`orders/updated`** detecting `refunded`/`voided` (or `orders/cancelled`) →
  `reverseOrderCommission` reverses the commission **unless** it's already paid or
  reserved into a payout (posted money is never silently clawed back); a `reversal`
  ledger debit is posted. *Partial refunds are left intact (still a paid sale) —
  proration is a future enhancement.*
- The payout CRON (`accrueCommissionsForOrders` + `getEligibleCommissions`) only
  ever sees commissions, which by construction exist only for paid orders; accrual
  additionally filters orders to `financialStatus = "paid"` as a safety net.

- **Commission base** = order **subtotal** (product revenue, excl. tax + shipping) × the code's `commissionRate`. `amount` on the order = gross `total_price`.
- **Eligibility helpers** (`cdo.service.js`): `isOrderCommissionable` (paid, not cancelled) gates creation; `isOrderClawback` (refunded/voided/cancelled) gates `reverseOrderCommission`.
- **Idempotency**: orders upsert by `(shop, shopifyOrderId)`; commissions are guarded by `orderId` (so the create + paid + updated webhooks all converge without duplicating); referral conversion is one row per `(referralCode, referredEmail)`.
- **Audit**: each order stores `attribution{source,code,matchedAt}` + the `referral` snapshot; commission creation + reversal post `cdo_transactions` ledger entries with running `balanceAfter`.

> **Scopes:** receiving `orders/*` requires `read_orders` and Shopify **protected customer data** approval. `shopify.app.toml` subscribes `orders/create`, `orders/paid`, `orders/updated`, `orders/cancelled`; production stores must be approved before delivery starts.

### 15.1 Permanent patient↔practitioner binding + multi-point enforcement

Once a patient (keyed by **email and/or Shopify customer id**) is attributed to a
practitioner, that relationship is **permanent**: the patient may afterwards only
use referral codes belonging to the **same** practitioner. The binding compares
the **practitioner, not the code**, so a practitioner can rotate / re-issue codes
and the patient may use any of them without breaking the relationship — but a
**different** practitioner's code is always rejected.

**Shared helpers** ([cdo.service.js](../app/services/cdo/cdo.service.js)):
- `resolvePatientPractitioner({ email, customerId })` → the bound practitioner,
  from `cdo_applications.referral.practitionerId` (primary, by email **or**
  customerId) then `cdo_referrals` (fallback — earliest row by `referredEmail`
  wins; the first attribution is the permanent one). `null` if no binding yet.
- `checkPatientBinding({ email, customerId, practitionerId })` → `{ ok }`:
  `ok:true` when there's **no binding yet** (first attribution) or the candidate
  code's practitioner **matches** the bound one; `ok:false reason:"bound_other"`
  when it's a different practitioner.

**Four enforcement points** (every place a code can attach to a patient):
1. **Registration** — `POST /api/signup-form` runs `checkPatientBinding` after
   verifying the code; a different practitioner's code is rejected `409` ("You are
   already associated with another practitioner"). Same-practitioner codes pass.
2. **Order / referral-link attribution (server)** — `resolveOrderReferral`'s
   catalogue-fallback path guards on the binding, so a foreign code carried on an
   order can't re-attribute an already-bound patient (the order is left
   unattributed rather than crediting another practitioner). This is the
   **backstop** that holds even when the checkout extension can't run.
3. **Checkout validation** — `POST /api/cdo/checkout-validate-code`
   (`{ code, email?, customerId? }`) returns a specific `result.message`:
   **"Invalid Referral Code"** (`not_found` — unknown/inactive code),
   **"Practitioner does not exist"** (`practitioner_missing` — code's practitioner
   no longer eligible), or **"You are already associated with another
   practitioner"** (`bound_other`). The binding check is identity-gated and
   skipped for a guest with no identity; code-validity checks always run.
4. **Checkout BLOCK (extension)** — the [`checkout-ui-code`](../extensions/checkout-ui-code/src/Checkout.jsx)
   extension declares the **`block_progress`** capability and registers a
   `useBuyerJourneyIntercept`. While any referral validation is unresolved the
   buyer **cannot advance** — including past the final **Pay** step, so the order
   is never created. The single render-derived gate (`referralBlock`) blocks on:
   an external/applied code still being validated; an invalid applied code that
   couldn't be auto-removed (a known-bad Shopify discount stuck on the order); or
   an invalid manually-entered code. A code that validates as valid clears the
   gate; an invalid code is removed (clearing the `cdo_practitioner_code` cart
   attribute) and, if removal fails, hard-blocks with a **Remove code** action.
   If the merchant disallows `block_progress`, Shopify downgrades block→allow and
   the extension degrades to a visible critical banner (the server backstop, #2,
   still enforces). **Limitation:** a fully guest checkout (no PCD email, not
   logged in) can't have its *binding* enforced at the extension — only validity —
   but order ingest (#2) re-enforces server-side.

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

**Shipping + Delivery status (derived, self-healing).** The list and detail
pages show two distinct, derived statuses (never a single stored field):

- **Shipping status** = fulfillment state — `unfulfilled · partially_fulfilled ·
  fulfilled · restocked · returned · cancelled`.
- **Delivery status** = carrier shipment state — `not_shipped · shipped ·
  label_printed · confirmed · ready_for_pickup · in_transit · out_for_delivery ·
  attempted_delivery · delivered · failure · returned · cancelled`.

`app/utils/orderStatus.js` (pure; safe to import from both the service and the
route badges) derives both from `order.fulfillmentStatus` **+** `order.fulfillments[]`
(`.status` lifecycle and `.shipmentStatus` carrier events). It self-heals a
stale/missing order-level field (a missed/late `orders/updated` no longer leaves
a shipped order reading "unfulfilled"); delivery rolls up across fulfillments
(least-progressed shipment until all delivered; a failed scan surfaces first).
`recordFulfillmentAndSync` also upgrades a blank/"unfulfilled" stored
`fulfillmentStatus` to "fulfilled" once a shipment exists (never clobbering a
Shopify "partial"/"restocked"). Kept in sync automatically by the subscribed
`orders/updated` + `fulfillments/create|update` webhooks. `listCdoOrders` /
`getCdoOrderDetail` return `shippingStatus` + `deliveryStatus`; the list's old
"Order status" column (a duplicate of the program status) was replaced by a
"Delivery status" column. Shared badges: `app/components/cdo/StatusBadges.jsx`.

## 18. Practitioner Portal (Customer Account UI extension)

> **⚠️ SUPERSEDED 2026-07-03 — the canonical Practitioner Portal has moved back
> to `wholesale` as a Theme App Extension** (React + Vite, wholesale storefront,
> App Proxy + `logged_in_customer_id` auth — see `wholesale/CLAUDE.md`'s
> 2026-07-03 changelog entry for the full rationale and file list). This
> section now describes the **legacy** implementation, which is still live in
> this repo pending manual verification of the new one. **Do not build new
> features against this version** — port them to `wholesale/practitioner-portal/`
> + `wholesale/app/services/cdo/cdo.portal.service.js` instead.
>
> **Nothing in this app's data layer changed** — `cdo_orders`/`cdo_commissions`/
> `cdo_payouts`/`cdo_referrals` are still OWNED and WRITTEN here; the wholesale
> portal only reads them via new read-only mirror models. Once the wholesale
> version is verified in production, decommission this section's artifacts:
> `ns-retail/extensions/practitioner-portal-account/`, `ns-retail/app/api/portal/*`,
> `ns-retail/app/services/cdo/cdo.portal.service.js`, and their 8 route
> registrations in `ns-retail/app/routes.js` — but KEEP the owning `cdo_*`
> models and `cdo.service.js` (the CDO admin dashboard + order-ingestion
> pipeline depend on them independently of the portal).

Self-service dashboard for CDO practitioners, rendered **inside the Shopify
customer account** as a full-page UI extension. Read aggregations over the
`cdo_*` collections this app owns, plus the referral self-service **write** path
(see below). Moved here from the wholesale workspace on **2026-06-08**
(single-owner architecture — the data and the portal now live in the same app).

> **Referral self-service (write path) — added 2026-06-18.** Practitioners can
> now **create their own referral codes + links** and **pause/resume** them from
> the Referrals tab (previously the portal was strictly read-only). New endpoint
> `POST /api/portal/referrals` with `{ op: 'create' | 'pause' | 'resume', ... }`,
> guarded by a new `portalMutation` wrapper (same JWT/tenant gate as the GET
> loaders; the CORS preflight now allows `POST`). Rules (enforced server-side in
> `cdo.portal.service.createReferralCode` / `setReferralCodeStatus`):
> - **Code**: 3–40 chars, lowercase `[a-z0-9_-]` (starts alphanumeric), and
>   **unique store-wide** — checked against `cdo_practitioner_codes` AND Shopify
>   (a code that already exists on Shopify → conflict, not silent adoption).
> - **Discount**: one of **10/15/20/25/30/35 %**, stored as a fraction.
> - **One ACTIVE code per discount tier** per practitioner — pausing a code frees
>   its tier for re-creation; resuming into an occupied tier is rejected.
>
> Each created code is backed by a real Shopify **basic code** percentage
> discount (`https://<retail-shop>/discount/<code>`). The DB row is the atomic
> claim (unique `{shop, code}` index); the row is **rolled back** if the Shopify
> discount can't be created, so a code never lingers without a live link. Pausing
> runs `discountCodeDeactivate` (link stops applying) and resuming
> `discountCodeActivate`, before the DB status flips, so the catalogue and the
> storefront never disagree. **Requires the `write_discounts` scope** (added to
> the app's access scopes alongside `read_discounts`). The Shopify discount
> writes live in `app/services/cdo/cdo.discount.service.js`, shared with the
> wholesale-registration `/api/cdo-internal/create-shopify-discount` endpoint.
>
> **Admin CDO page: create + pause/resume (2026-06-18).** The CDO Program admin's
> practitioner detail page (`app.cdo-program.customers.$id._index.jsx`, action in
> `…$id.jsx`) supports **Add referral code** + **Pause/Resume** + Copy; code
> **edit / delete / set-primary were removed**. **Add** (`createPractitionerCode`,
> `_action: "create-code"`) takes a required Code and an **optional** Discount %
> (blank → 0% / attribution-only); when a discount is set it also creates the
> backing Shopify discount on the retail store (best-effort — a discount failure
> logs but doesn't block the code row). There is **no practitioner-level
> commission field** — commission is configured per product vendor (§4.1), so the
> code's commission rate is always null and never drives the amount. **Pause/Resume**
> (`setPractitionerCodeStatus`, `_action: "set-code-status"`), like the portal's
> `setReferralCodeStatus`, calls the shared `cdo.discount.service.setShopifyDiscountActive`
> to **deactivate/reactivate the backing Shopify discount** (not just flip the DB
> status) before saving — so a paused code genuinely stops applying on the
> storefront. Both create + toggle pass the retail `shop` (session.shop) so the
> Admin API targets the store the discount lives on (a code's stored `shop` may
> be the wholesale shop). Referral tracking + earned commissions are untouched
> (immutable history; the status gate only affects NEW attributions). Codes
> without a `shopifyDiscountId` (0%/attribution-only or legacy) skip the Shopify
> call.

**Pieces:**

| Piece | Path |
|---|---|
| Extension (Preact + Polaris web components, full page) | `extensions/practitioner-portal-account/` (`customer-account.page.render` target, `network_access = true`, api_version `2025-10`) |
| Backend service (aggregations + referral self-service writes) | `app/services/cdo/cdo.portal.service.js` |
| Shopify discount writes (create / activate / deactivate) | `app/services/cdo/cdo.discount.service.js` |
| API handlers (thin) + shared guard (`portalLoader` GET / `portalMutation` POST) | `app/api/portal/{_guard,me,summary,revenue,customers,commissions,payouts,referrals,discounts}.js`, registered in `app/routes.js` |
| Response helpers | `app/services/APIService/api.service.js` |
| Models reused (the real ones) | `cdoOrder` · `cdoCommission` · `cdoPayout` · `cdoReferral` · `cdoPractitionerCode` · `wholesaleApplication` |

**Auth / tenant resolution (identity is never trusted from the client):** the
extension obtains a session-token JWT via `shopify.sessionToken.get()` and sends
`Authorization: Bearer`. `portalLoader` (in `_guard.js`) verifies it with
`authenticate.public.customerAccount`, then `resolvePractitionerByCustomerGid`
applies the access policy on **every** request (it wraps every endpoint), in two
gates, before any portal data is read:

1. **Required tags** — the customer must carry BOTH the **`Practitioner`** and
   **`Approved`** tags on the ns-retail store. Tags are read from Shopify (the
   Admin API, trusted) — never the client — and matched **case-insensitively as
   exact whole tags** (so `archived-practitioner` / `wholesale-Practitioner` do
   NOT satisfy `practitioner`). `hasRequiredPortalTags(tags)` is the predicate.
2. **Tenant resolution** — the customer must resolve to an **approved**
   `WholesaleApplication` whose `_id` is the `practitionerId`.

Either gate failing → `403`. Every aggregation in `cdo.portal.service.js` is
scoped by `{ practitionerId }`. Auth failures map to `401` (not signed in / no
`sub`) and `403` (signed in but not authorized — missing tags or not an approved
practitioner). A null-origin Web Worker + the Authorization header make the
fetch non-simple, so the guard wrappers (`portalLoader` GET / `portalMutation`
POST) answer the CORS `OPTIONS` preflight (now allowing `GET, POST`) and the
library `cors` helper stamps success responses. **Frontend:** the extension
calls `me` before rendering and shows a "sign in" (`401`) or "Access restricted"
(`403`) screen instead of the dashboard — but the backend tag gate on every
endpoint is the authoritative boundary (a direct API call without the tags still
`403`s). *Note: the customer-account navigation link to the page is rendered by
Shopify's account shell and can't be conditionally hidden per-customer from the
extension; the page-level gate + backend `403` are what prevent access.*

> **Cross-store identity (post-move fix, 2026-06-09).** `wholesale_applications.customerId`
> is the customer's GID **on the wholesale store** (where they registered), but the
> portal now runs on the **ns-retail store**, where the same person has a *different*
> customer GID (Shopify customer GIDs are per-store). So `resolvePractitionerByCustomerGid(sub, dest)`
> first tries a direct `customerId === sub` match (same-store fast path), and on miss
> **bridges by email**: it reads the logged-in customer's email + tags from the ns-retail
> store via the Admin API (`unauthenticated.admin(dest)` → `customer(id: sub){ email tags }`,
> needs `read_customers`/`write_customers`) and matches an approved application on `email`
> (the stable, store-independent key — read from Shopify, never the client; case-insensitive
> + anchored). The same lookup supplies the `tags` for the access gate above. **The lookup
> is LIVE and UNCACHED — it runs on every portal request**, so access is always decided on
> the customer's CURRENT Shopify tags (adding/removing a tag takes effect on the very next
> request; nothing is read from a MongoDB mirror). Without the email bridge, every ns-retail
> login 403s ("Access restricted") — the regression seen right after the move.

**Endpoints** (served at `${api_base_url}/api/portal/*`): `me`, `summary`,
`revenue` (month/last/year/lifetime + range), `customers` (referred patients),
`commissions` (+ `pendingOnly`), `payouts` (with per-payout commission
breakdown), `referrals` (GET codes + usage; **POST** create / pause / resume —
see the self-service write path above), `discounts` (derived from codes). All
GET except the `referrals` POST. Pagination + search + date-range filters where
applicable.

**Prerequisites (Partner dashboard, ns-retail app):** customer accounts
enabled + protected customer data access (for the `sub` claim) + the
`read_customers` scope (for the cross-store email bridge above) + the
`read_discounts,write_discounts` scopes (for referral self-service — creating /
activating / deactivating the storefront discount). The
practitioner must have a **customer account on the ns-retail store using the
same email** as their approved wholesale application — that email is the bridge
key. **Merchant step after deploy:** add the page to the customer-account
navigation menu and set the extension's `api_base_url` setting to the ns-retail
app URL.

**Dev workflow:** paste the current `shopify app dev` tunnel URL into
`extensions/practitioner-portal-account/src/config.js` `DEV_API_BASE_URL` (it
wins over the merchant-set setting when non-empty); leave it `''` for production
builds.

**Out of scope (here):** commission/payout *generation* (owned by the CDO
engine, §4/§7), charts, and CSV export (the sandboxed Web Worker has no
DOM/Blob). *(Live Shopify Discount API objects were previously out of scope but
are now created/toggled by the referral self-service write path above.)*

## 19. Retail order QBO invoicing (`QBO_RETAIL_*`) — IMPLEMENTED

Retail **customer** orders → QuickBooks **Invoices** (accounts-receivable,
"money in"). This is a SECOND, independent QBO code path, distinct from:

- the **CDO payouts** QBO client (§5–§8 — `services/qbo/*`, Vendor **Bills**
  for practitioner commissions), and
- the **wholesale** workspace's QBO integration (different repo folder).

It posts to the SAME QBO company as the payout client: app-level OAuth creds
come from the shared `QBO_*` vars and the company (realm, token, accounts) from
`QBO_RETAIL_*`. Token state lives in the `cdo_qbo_tokens` collection, unique-keyed
by `realmId`; because both clients use that one realm, they share its token row.

**Module — `app/services/retailQbo/`:**

| File | Role |
|---|---|
| `retailQbo.config.js` | Reads shared app creds from `QBO_*` and company config from `QBO_RETAIL_*`. `isRetailQboConfigured()` lets the feature no-op cleanly when unset. Optional `QBO_RETAIL_ITEM_ID` / `ITEM_NAME` / `INCOME_ACCOUNT_ID`. |
| `retailQbo.apis.js` | A second OAuth2 transport — token rotation, refresh-coalescing, 401-retry-once, `requestid` idempotency, Fault classification. Bound to `retailQboConfig`; tokens stored under the `realmId`. Mirrors `services/qbo/qbo.apis.js`; both target the same company, so they share that realm's token row. |
| `retailQbo.service.js` | Domain ops: `findOrCreateCustomer` (idempotent by DisplayName=email), `resolveSalesItemId` (one generic Sales Service item — override → named item → any Service item → create against a resolved Income account), `createInvoiceForOrder` (product lines + shipping line + discount line + `TxnTaxDetail` tax + a reconciling **adjustment** line so QBO `TotalAmt` == the Shopify order total), `syncInvoiceShipping` (sparse update: ShipDate + TrackingNum + carrier/tracking memo), `createPaymentForInvoice` (a QBO Payment with a `LinkedTxn` to the invoice — marks it Paid), `invoiceWebUrl`, `paymentWebUrl`. |
| `retailOrderInvoice.service.js` | Orchestration: `ensureRetailInvoiceForOrder` (idempotent — atomic claim on `cdo_orders.retailQbo` + QBO `requestid`), `ensureRetailPaymentForOrder` (idempotent payment record-and-apply; atomic claim on `retailQbo.qboPaymentId` + `paymentCreating`), and `recordFulfillmentAndSync` (capture tracking → `cdo_orders.fulfillments[]`/`trackingHistory[]`, then mirror to the invoice). `fetchOrderPaymentDetails` reads the order's transactions from the Shopify Admin API. Best-effort; never throws to the webhook. |

**Triggers:**

- **`orders/create` + `orders/paid` + `orders/updated`** → after
  `ingestShopifyOrder`, each fires `ensureRetailInvoiceFromPayload`
  fire-and-forget. Creation is **gated on payment** — an invoice is created only
  when `financial_status === "paid"`. Unpaid orders are ingested but deferred
  (`auto_invoice.deferred_unpaid`); when payment lands, the paid/updated event
  invoices them. Idempotent across all three (claim + QBO `requestid`).
- **Payment → invoice marked Paid:** right after the invoice is created (and on
  the already-invoiced retry path), `ensureRetailPaymentForOrder` creates a **QBO
  Payment fully applied to the invoice** (`LinkedTxn`) so QBO shows it **Paid**,
  matching the Shopify payment status. Gated on `financialStatus === "paid"`. The
  payment amount is the invoice's freshly re-fetched **Balance** (a 0 balance ⇒
  already settled ⇒ skip). The Shopify transaction reference is captured from the
  Admin API (`fetchOrderPaymentDetails`) and stored. Idempotent — atomic claim on
  `retailQbo.qboPaymentId` (+ `paymentCreating` guard) + a stable QBO `requestid`
  (`retail-pay-<orderId>`). Toggle: `QBO_RETAIL_RECORD_PAYMENT` (default on);
  optional `QBO_RETAIL_DEPOSIT_ACCOUNT_ID` routes the deposit account.
- **Invoice delivery:** immediately after a successful create the invoice is
  **emailed to the customer** via QBO `/invoice/{id}/send` (recipient = order
  email). Idempotent + self-healing — a failed send is retried on the next order
  event (guarded by `retailQbo.invoiceSentAt`). Toggle: `QBO_RETAIL_SEND_INVOICE`.
- **`fulfillments/create` + `fulfillments/update`** → capture carrier / tracking
  number / tracking URL / shipment status / fulfillment date, re-sync them onto
  the QBO invoice, **then notify the customer** by re-sending the invoice (its
  memo now carries order number + carrier + tracking + URL + status). Deduped on
  the tracking string (`retailQbo.lastNotifiedTracking`) so it emails once per
  tracking change. Toggle: `QBO_RETAIL_NOTIFY_ON_SHIP`.

**State on `cdo_orders` (additive, backward-compatible):** snapshot fields
`tags`, `note`, `noteAttributes`, `sourceName`, `transactions`; tracking
`fulfillments[]`, `trackingHistory[]`, `shippedAt`; and the `retailQbo` sub-doc
(`qboCustomerId`, `qboInvoiceId`, `qboInvoiceDocNumber`, `qboInvoiceTotal`,
`qboSyncToken`, `invoiceUrl`, `qboCreatedAt`, `qboSyncStatus`, `qboSyncedAt`,
`qboSyncError`, email-delivery `invoiceSentAt` / `invoiceEmailedTo` /
`invoiceEmailStatus`, shipment-notify `lastShipmentNotifiedAt` /
`lastNotifiedTracking`, payment `qboPaymentId` / `qboPaymentRefNum` /
`qboPaymentUrl` / `qboPaymentTotal` / `shopifyTransactionId` /
`shopifyPaymentGateway` / `paymentAppliedAt` / `paymentSyncStatus` /
`paymentSyncError` / `invoiceStatus`, and an append-only `syncLog[]` whose events
are `invoice_created` / `invoice_create_failed` / `invoice_sent` /
`invoice_send_failed` / `invoice_send_skipped` / `shipping_synced` /
`shipping_sync_failed` / `shipment_notified` / `shipment_notify_failed` /
`payment_created` / `payment_create_failed` / `payment_skipped`).
`mapShopifyOrderToDoc` captures the snapshot fields only — it never writes the
tracking/QBO fields, so order re-ingests (orders/paid, orders/updated) never
clobber them. `retailQbo` has **no `default: null`** (a scalar-null parent
breaks dot-path `$set`); the claim uses an `$ifNull`/`$mergeObjects` pipeline so
legacy null rows still work.

**Retail Order Details page** (`app/routes/app.orders.$id.jsx`): Order info
(+ tags/notes/source), Customer info (+ billing/shipping), Product info
(name/SKU/variant/qty/unit/discount/total), Pricing + Tax & discount details,
Shipping & Fulfillment (**Shipping status + Delivery status badges** (§17) +
method/charges + carrier/tracking #/URL/shipment status/date),
Payment info (method/transaction id/amounts), **QuickBooks information**
(customer id / invoice id+link / number / status / created / last sync /
invoice-sent status / error, plus **payment**: Paid badge / QBO payment id+link /
payment reference # / Shopify transaction id / gateway / amount / recorded date /
payment error), Commission (unchanged), and Audit & Activity
(order timeline + QBO sync history + shipment update history). Action buttons:
**Create QBO invoice** (create/retry), **Preview invoice** (opens the
QBO-rendered invoice PDF — `getRetailInvoicePdf` → QBO `/invoice/{id}/pdf` via
`qboRetailGetBinary`, relayed base64 → browser blob URL), **Send invoice**
(email it), **Re-sync shipping**, **Record payment** (create/apply the QBO
payment for a paid order).

**Idempotency:** one invoice per order — the `cdo_orders.retailQbo` claim plus
the QBO `requestid` (`retail-inv-<orderGid>`) make re-deliveries and concurrent
webhooks safe. **Go-live:** `shopify app deploy` to register the two fulfillment
webhook topics; ensure `QBO_RETAIL_REFRESH_TOKEN` is freshly minted (Intuit
rotates the refresh token on every use — see the §14 token-reset note, which
applies per realm).

---

## 20. Client Portal (Theme App Extension, retail storefront) — IMPLEMENTED (2026-07-07)

Self-service account dashboard for **retail customers** — regular customers,
patients referred by a practitioner, and customers currently attributed to a
practitioner via a CDO referral code. Distinct audience from §18's
Practitioner Portal (practitioners, not their customers); no relation to that
feature beyond sharing the CDO data model.

**Architecture — follows this repo's own proven App-Proxy Theme-App-Extension
pattern** (`signup-form/`, `practitioner-code-form/`), not the wholesale
Practitioner Portal's pattern, since ns-retail owns its data directly (no
cross-store mirroring needed here):
- New Vite+React source workspace `ns-retail/client-portal/` (sibling to
  `signup-form/`, `practitioner-code-form/`), building into
  `extensions/theme-extension/assets/client-portal-bundle.{js,css}`
  (`npm run build:client-portal`, folded into `predeploy`).
- New Liquid block `extensions/theme-extension/blocks/client_portal.liquid` —
  zero merchant-facing settings (same convention as `practitioner_code.liquid`);
  merchant places it on an account/page template.
- Backend reached via the existing single App Proxy
  (`/apps/retail-signup/api/client-portal/*`) — no new app proxy config.
- Auth guard `app/api/client-portal/_guard.js`: verifies
  `authenticate.public.appProxy(request)`, resolves `logged_in_customer_id` →
  a Shopify customer GID, and builds a customer-scoped context via
  `resolveClientContext` in the new service below. **No approval gate** —
  any logged-in retail customer is authorized (contrast with §18's
  practitioner guard, which 403s a non-approved account). Only failure modes
  are 401 (not signed in / bad App Proxy signature) and 500.
- New service `app/services/cdo/cdo.clientPortal.service.js` — every query
  scoped strictly by `customer.shopifyCustomerId` (the trusted GID from the
  guard), never by client-supplied email or order id alone. Exports
  `resolveClientContext`, `getDashboard`, `getOrders`, `getOrderDetail`,
  `getPaymentHistory`, `getCdoInfo`, `getProfile`. Reuses the existing pure
  `utils/orderStatus.js` helpers (`deriveShippingStatus`/`deriveDeliveryStatus`/
  `extractTracking`) rather than re-deriving fulfillment state.
- 7 new read-only API routes registered manually in `app/routes.js` (this
  repo's convention for `/api/*`): `me`, `dashboard`, `orders`, `order`
  (single detail, `?id=`), `payments`, `cdo`, `profile`. All GET-only —
  **no writes in this feature** (Profile is read-only display; contrast with
  §18's referral-code create/pause/resume mutation path).

**Sections (tabs):**
- **Dashboard** — order count, lifetime spend, last order date; a banner
  when the customer is linked to a practitioner.
- **Orders** — paginated list (`getOrders`, filterable by `financialStatus`/
  `fulfillmentStatus`) with click-through to a full order detail view
  (`getOrderDetail`) — line items, pricing breakdown, addresses, tracking.
  "Current vs. history" is a UI filter over one endpoint, not two separate
  endpoints/services.
- **Payment History** — derived from `cdo_orders.retailQbo` (no new payments
  model) — per-order payment status + a link to the QBO-emailed invoice when
  one exists; `invoiceStatus: null` (sync pending/not started) renders as
  "Processing" rather than a blank cell.
- **CDO** — **hidden entirely** (not shown with an empty state) for
  customers with no active practitioner referral. When attributed: current
  practitioner name, discount code + percent, enrollment date, and the
  customer's own discount-code usage history (from `cdo_orders.discountCodes`
  matched against their bound code — never another customer's usage).
- **Profile** — read-only: name, email, enrollment status, and the most
  recent order's billing/shipping address snapshot. `cdo_applications.
  billingAddress`/`shippingAddress` are always null (nothing populates
  them), and a live Shopify Admin address lookup was deliberately avoided
  (no extra latency/failure mode for an informational field) — so Profile
  sources addresses from the customer's latest `cdo_orders` document
  instead, with an explicit "no address on file yet" empty state for a
  zero-order customer.

**Security notes:**
- `getOrderDetail`'s ownership check (`o.customer.shopifyCustomerId !==
  ctx.customerId` → `null`) is enumeration-safe — a guessed/foreign order id
  returns a generic "not found," never a 403 that would confirm the id
  exists but belongs to someone else.
- Orders/payments/dashboard queries are **GID-only** — a customer's
  pre-account guest-checkout orders (placed under the same email before
  creating an account) are intentionally excluded rather than joined by
  email, since email is not an authenticated identity signal.

**Nothing in the CDO data layer changed** — `cdo_orders`/`cdo_applications`
are read-only from this feature's perspective (already owned and written by
the existing order-ingestion pipeline, `cdo.service.ingestShopifyOrder`).

---

### Appendix — Environment variables

```
# ── Shared QBO app credentials (one Intuit app; QBO_*) ──
QBO_ENVIRONMENT=sandbox|production
QBO_CLIENT_ID=               QBO_CLIENT_SECRET=
QBO_MINOR_VERSION=73
# optional retry tuning (shared by both QBO clients)
QBO_HTTP_RETRY_ATTEMPTS=4  QBO_HTTP_RETRY_BASE_MS=500  QBO_HTTP_RETRY_MAX_MS=4000

# ── Retail company (QBO_RETAIL_*) — ONE QBO company for BOTH the retail A/R
#    invoices (§19) AND the commission-payout Bills/BillPayments (§5–§8) ──
QBO_RETAIL_REALM_ID=         QBO_RETAIL_REFRESH_TOKEN=
QBO_RETAIL_COMMISSION_EXPENSE_ACCOUNT_ID=   # Bill expense line
QBO_RETAIL_PAYMENT_ACCOUNT_ID=              # BillPayment bank source
QBO_RETAIL_AP_ACCOUNT_ID=                   # optional — Bill A/P account
QBO_RETAIL_DEFAULT_ITEM_ID=                 # optional — post all invoice lines to this QBO Item (QBO_RETAIL_ITEM_ID also accepted)
QBO_RETAIL_ITEM_NAME=Retail Sales           # optional — name of the auto-resolved Service item
QBO_RETAIL_INCOME_ACCOUNT_ID=               # optional — income account for the auto-created item
QBO_RETAIL_DEPOSIT_ACCOUNT_ID=              # optional — deposit account for recorded payments
QBO_RETAIL_SEND_INVOICE=true                # optional — email the invoice after create (default on)
QBO_RETAIL_NOTIFY_ON_SHIP=true              # optional — re-send the invoice (with tracking) on shipment (default on)
QBO_RETAIL_RECORD_PAYMENT=true              # optional — record a QBO Payment when the Shopify order is paid (default on)

# ── Payout scheduler (§7) ──
# CDO_PAYOUT_CRON=30 0 25 * *               # optional — prod payout cron (defaults to 00:30 on the 25th)
# CDO_PAYOUT_TZ=America/Los_Angeles         # optional — cron timezone (defaults to America/Los_Angeles)
CDO_PAYOUT_INTERVAL=20 minutes              # DEV ONLY — overrides the payout cron; leave unset in prod
CDO_SETTLEMENT_INTERVAL=1 minute            # DEV ONLY — overrides the 6-hourly settlement cron; leave unset in prod
# CDO_SCHEDULER_DISABLED=true               # optional — never boot the scheduler
# CDO_PAYOUT_ALERT_WEBHOOK_URL=             # optional — POSTed on a failed payout

# ── Payout disbursement (§9) ──
CDO_PAYOUT_PROVIDER=sandbox|dwolla          # default "sandbox" (in-process simulator)
# CDO_PAYOUT_REQUIRE_APPROVAL=false         # optional — gate real money behind manual approve+execute
# CDO_PAYOUT_SANDBOX_SETTLE_SECONDS=60      # sandbox provider ONLY — seconds until a sim transfer settles
# CDO_SETTLEMENT_CRON=0 */6 * * *           # optional — prod settlement-poll cadence
# CDO_SETTLEMENT_STUCK_DAYS=5               # optional — flag transfers not settled after N days
DWOLLA_ENVIRONMENT=sandbox|production       # required when CDO_PAYOUT_PROVIDER=dwolla
DWOLLA_KEY=                  DWOLLA_SECRET=
DWOLLA_FUNDING_SOURCE=                      # business funding source (URL or id)
```
