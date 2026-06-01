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

## 7. Payout Automation (CRON) — Phase 5 (designed, not yet wired)

The orchestration services are CRON-ready; automation is a thin scheduling layer to add later (mirroring the wholesale Agenda scheduler).

```
Agenda job  process-cdo-payouts        cron: 30 0 15 * *  +  30 0 L * *
   │                                    (15th & last day, America/Los_Angeles)
   ▼
 1. accrueCommissionsForOrders()        // calculate new commissions
 2. buildPayoutBatch({ periodEnd })     // aggregate eligible → awaiting_approval
 3. (policy) auto-approve OR notify     // honor approve-then-execute
 4. executeApprovedPayout() for each approved
 5. reconcile: re-check QBO bill/payment status
```

**Planned wiring:** port `services/scheduler/*` (Agenda singleton + config) + boot it fire-and-forget from `app/entry.server.jsx`; dev override `CDO_PAYOUT_INTERVAL`. Today the same steps run via the **"Generate payout batch"** admin action (which already does accrue → batch) + per-row Approve/Execute.

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

**`cdo_commissions`** — one per attributed order.
`practitionerId, practitionerEmail, practitionerName, orderId, orderName, currency, amount, rate, status[pending|approved|paid|reversed], payoutId, earnedAt`

**`cdo_payouts`** — a disbursement batch.
`practitionerId, practitionerSource, practitionerEmail, practitionerName, currency, amount, method[ach|bank|paypal|check|manual], status[draft|awaiting_approval|approved|processing|paid|failed|rejected|cancelled], commissionIds[], qboVendorId, qboBillId, qboBillPaymentId, billCreatedAt, paymentRecordedAt, approvedBy/At, rejectedBy/At, rejectionReason, lastError, remarks[], periodStart, periodEnd, reference, paidAt`
*Indexes:* `(practitionerId, periodEnd)` partial-unique on open statuses (idempotent batching).

**`cdo_transactions`** — append-only practitioner ledger.
`practitionerId, type[commission|payout|adjustment|reversal], amount (+credit/−debit), balanceAfter, relatedType, relatedId, description, occurredAt`

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
```
