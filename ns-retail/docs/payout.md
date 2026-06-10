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

- **FROM** the business bank account (QBO `CDO_QBO_PAYMENT_ACCOUNT_ID`); **TO** the practitioner's account (`wholesale_applications.commission`, §6.5).
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
- **`dwolla`** (`CDO_PAYOUT_PROVIDER=dwolla`) — **implemented** real ACH rail (`provider/dwollaProvider.js`, raw REST, no SDK). Per payout it: find-or-creates a **receive-only Customer** for the practitioner (by email), find-or-creates their bank **Funding Source** (routing/account/type — Dwolla dedupes via its duplicate-resource link), then creates a **Transfer** from the business funding source (`DWOLLA_FUNDING_SOURCE`) → the practitioner, with the `idempotencyKey` as Dwolla's `Idempotency-Key`. `getTransferStatus` maps Dwolla `processed → settled`, `failed/cancelled/reclaimed → returned` (with the ACH R-code from `/transfers/{id}/failure`), else `pending`. OAuth2 client-credentials token cached + auto-refreshed. Config: `DWOLLA_ENVIRONMENT` (sandbox|production), `DWOLLA_KEY`, `DWOLLA_SECRET`, `DWOLLA_FUNDING_SOURCE`. *Note: receive-only customers + transfers need a verified business funding source on the Dwolla account; polling is used today — a webhook handler (`customer_bank_transfer_completed/_failed`) would settle faster (future).* 
- **`stripe` / `modern_treasury`** — not yet implemented; the factory throws a clear error until the adapter file + credentials are added. Dropping one in is a single new file + registering it in the factory; no changes to the payout logic.

### 8.3 Human-approval gate

`CDO_PAYOUT_REQUIRE_APPROVAL` (default **true**): the automated CRON accrues + auto-approves commissions + builds payouts that **wait in `awaiting_approval`** — an admin must **Approve + Execute** to move money. Set to `false` only for the legacy end-to-end auto-disburse path (discouraged with real money).

### 8.4 Settlement reconciliation CRON

`process-payout-settlements` (Agenda) sweeps every `awaiting_settlement` payout and calls `checkPayoutSettlement`. Cadence: `CDO_SETTLEMENT_CRON` (prod, default every 6h) / `CDO_SETTLEMENT_INTERVAL` (dev). The admin **Sync settlement** button runs the same check for one payout on demand.

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

## 18. Practitioner Portal (Customer Account UI extension)

Self-service dashboard for CDO practitioners, rendered **inside the Shopify
customer account** as a full-page UI extension. Read-only over the `cdo_*`
collections this app owns. Moved here from the wholesale workspace on
**2026-06-08** (single-owner architecture — the data and the portal now live in
the same app).

**Pieces:**

| Piece | Path |
|---|---|
| Extension (Preact + Polaris web components, full page) | `extensions/practitioner-portal-account/` (`customer-account.page.render` target, `network_access = true`, api_version `2025-10`) |
| Backend service (all read-only aggregations) | `app/services/cdo/cdo.portal.service.js` |
| API handlers (thin) + shared guard | `app/api/portal/{_guard,me,summary,revenue,customers,commissions,payouts,referrals,discounts}.js`, registered in `app/routes.js` |
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
fetch non-simple, so `portalAction` answers the CORS `OPTIONS` preflight and the
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

**Endpoints** (all GET, served at `${api_base_url}/api/portal/*`): `me`,
`summary`, `revenue` (month/last/year/lifetime + range), `customers` (referred
patients), `commissions` (+ `pendingOnly`), `payouts` (with per-payout
commission breakdown), `referrals` (codes + usage), `discounts` (derived from
codes). Pagination + search + date-range filters where applicable.

**Prerequisites (Partner dashboard, ns-retail app):** customer accounts
enabled + protected customer data access (for the `sub` claim) + the
`read_customers` scope (for the cross-store email bridge above). The
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
engine, §4/§7), live Shopify Discount API objects, charts, and CSV export (the
sandboxed Web Worker has no DOM/Blob).

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
