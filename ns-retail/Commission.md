# Commission Payout — Complete Feature & Production Picture

**Workspace:** `ns-retail/` (CDO Program)
**Status:** Accounting pipeline LIVE • Disbursement + settlement lifecycle IMPLEMENTED (provider-agnostic) • **Dwolla** ACH adapter implemented (sandbox-ready; needs Dwolla credentials + verified funding source) • `sandbox` simulator is the default
**Last updated:** 2026-06-10
**Canonical technical spec:** [`docs/payout.md`](docs/payout.md) — this file is the production-readiness / money-flow summary.

> ✅ **Update (2026-06-10):** the two critical gaps below (8.1 no fund movement, 8.2 settlement lifecycle) are now **implemented**. Payouts initiate a real bank→bank transfer through a provider-agnostic disbursement layer, move to **`awaiting_settlement`**, and only become **`paid`** once a settlement poll confirms funds (ACH returns flip them to `failed`). Money moves **only after an admin Approve + Execute** (`CDO_PAYOUT_REQUIRE_APPROVAL=true`).
>
> ⚠️ **But you still cannot send REAL money yet:** the active provider is the **`sandbox`** simulator (no real funds). Going live needs a contracted ACH provider adapter + the remaining items in §9 (bank-account verification, encryption of stored account numbers, funding-balance checks, 1099/W-9, NACHA agreement). Sections 5 and 8 are updated to reflect what's now real.

---

## 1. What the feature does

CDO ("Clinical Dispensing Optimization") practitioners refer patients using a referral/discount code. When a referred order is **paid**, the practitioner earns a commission. On a schedule, the system aggregates each practitioner's eligible commissions into a single payout, records it in QBO as a Vendor **Bill + BillPayment**, validates the practitioner's bank details, and marks the commissions paid.

```
Patient buys with practitioner's code
        │  (orders/create → orders/paid webhooks)
        ▼
cdo_orders  ──attributed──▶  cdo_commission (earned, per paid order)
        │
        ▼   monthly CRON (or manual)
Aggregate eligible commissions per practitioner
        │
        ▼
Validate practitioner banking  ◀── wholesale_applications.commission  (§4)
        │
        ▼
QBO Vendor Bill  +  QBO BillPayment   (records the expense + disbursement)
        │
        ▼
Commissions → paid · ledger debit · audit trail
```

---

## 2. Roles & systems

| System | Role in payout |
|---|---|
| **Shopify** | Source of orders; webhooks (`orders/create`, `orders/paid`, `orders/updated`, `orders/cancelled`) drive commission accrual/reversal. |
| **MongoDB (`cdo_*` collections)** | System of record for commissions, payouts, batches, the practitioner ledger, and audit. |
| **`wholesale_applications` collection** | **Source of truth for the practitioner's payout bank details** (`commission` object). Written by the wholesale workspace; read here. |
| **QuickBooks Online (CDO realm)** | Accounting system of record — Vendor, Bill (expense), BillPayment (disbursement record). **Does the bookkeeping, not the bank transfer.** |
| **Agenda scheduler** | Runs the automated monthly payout job (`process-commission-payouts`). |
| **ACH / payout provider** | **NOT YET INTEGRATED.** Required to actually move money (see §8/§9). |

---

## 3. Commission lifecycle (data)

```
cdo_commissions.status:    pending → approved → paid
                                         └→ reversed (refund/cancel before payment)
cdo_commissions.payoutStatus: pending → processing → paid
                                            └→ failed / skipped / paused / cancelled
cdo_payouts.status:  draft → awaiting_approval → approved → processing → paid
                                                     └→ failed / rejected / cancelled
```

- A commission is created **only for PAID orders** (gated on Shopify `financial_status = paid`).
- Refund/void/cancel **before** payment reverses the commission (ledger debit). Posted/batched commissions are never silently clawed back.
- One **aggregated** payout per practitioner per period (all that period's eligible commissions → a single `cdo_payouts` row).

---

## 4. Practitioner banking — source of truth & validation (implemented 2026-06-10)

The practitioner's payout destination bank details are **not** stored in any `cdo_*` collection. They live on the canonical **`wholesale_applications.commission`** object:

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

At execution time (`executeApprovedPayout`), the payout:

1. **Fetches** the banking **fresh** via `resolvePractitionerBanking(practitionerId)` — never cached, so it always uses the **latest** details on file.
2. **Validates** before any QBO write or disbursement:

   | Field | Rule |
   |---|---|
   | `enabled` | must not be `false` |
   | `bankAccountName` | non-empty |
   | `bankRoutingNumber` | 9 digits, valid **ABA mod-10 checksum** |
   | `bankAccountNumber` | 4–17 digits |
   | `bankAccountType` | `Checking` or `Savings` |

3. **Invalid/missing → flag & abort:** `status=failed`, `bankingError` set, `bank_invalid` remark with reasons, `log.warn` (reasons only). Admin sees a toast (manual) or a failed batch item + `cdo.payout.alert` (CRON). Fixing the details and re-running proceeds.
4. **Valid → snapshot (masked):** `bankSnapshot { accountName, routingNumber, accountLast4, accountType, sourcedFromPaymentAch, bankingUpdatedAt, capturedAt }` + a `bank_validated` remark, and the destination (`name · type ••••last4 · routing`) is written to the QBO Bill `PrivateNote`.

**Security:** the full account number is **transient only** — never persisted to `cdo_payouts` (only last4 + routing) and **never logged**.

---

## 5. Money flow — "from which bank to which bank" (the honest version)

### 5.1 The intended flow

```
  Natural Solutions' BUSINESS BANK ACCOUNT
  (linked in QBO as CDO_QBO_PAYMENT_ACCOUNT_ID)
                │
                │   ACH credit  ── of the commission amount ──▶
                ▼
  PRACTITIONER'S BANK ACCOUNT
  (routing + account + type from wholesale_applications.commission)
```

- **FROM (debit / funding source):** the company's operating/clearing **bank account**, represented in QBO by `CDO_QBO_PAYMENT_ACCOUNT_ID`.
- **TO (credit / destination):** the **practitioner's bank account** — routing + account number + type from `wholesale_applications.commission`.

### 5.2 What happens now (post-2026-06-10)

```
admin Approve + Execute
executeApprovedPayout()
  ├─ validate practitioner banking            ✅  (fresh from wholesale_applications.commission)
  ├─ QBO: findOrCreateVendor(practitioner)     ✅
  ├─ QBO: createBill (expense lines)           ✅  ← books the LIABILITY (we owe it)
  ├─ provider.initiateTransfer({destination})  ✅  ← initiates the bank→bank ACH credit
  └─ status = awaiting_settlement                  (NO "paid" yet, NO BillPayment yet)

process-payout-settlements CRON  (or admin "Sync settlement")
checkPayoutSettlement()
  ├─ provider.getTransferStatus(transferId)
  ├─ settled  → QBO: createBillPayment ✅ + commissions paid + ledger debit + status=paid
  ├─ returned → status=failed (+ R-code); commissions kept reserved → retry re-disburses
  └─ pending  → stay awaiting_settlement (1–3 business-day ACH window)
```

**The actual fund movement is the `provider.initiateTransfer` step.** Today `CDO_PAYOUT_PROVIDER=sandbox`, an in-process simulator — so no *real* money moves, but the **entire lifecycle is exercised end-to-end** (initiate → poll → settle/return → retry). The QBO `BillPayment` now records the disbursement **only at confirmed settlement**, so the books only claim "paid" once funds actually move.

> **Bottom line:** the bank→bank flow in 5.1 is **implemented and wired**, gated behind human approval, with a settlement lifecycle. To send **real** money, swap the sandbox adapter for a contracted provider (§9.1) and complete the remaining §9 items.

---

## 6. How QBO helps

QBO is the **accounting system of record** for the payout. It provides:

| QBO object | Purpose | Code |
|---|---|---|
| **Vendor** | Each practitioner is a QBO Vendor (find-or-create, cached in `cdo_qbo_vendors`). Enables 1099 tracking. | `findOrCreateVendor` |
| **Bill** | Records the commission **expense** — one line per commission, against `CDO_QBO_COMMISSION_EXPENSE_ACCOUNT_ID`. `DocNumber` = payout reference. | `createBill` |
| **BillPayment** | Records the **disbursement** against the bill, drawn from `CDO_QBO_PAYMENT_ACCOUNT_ID` (a bank account). Reduces A/P. | `createBillPayment` |
| **Deep links** | `billWebUrl` / `vendorWebUrl` let operators open the exact QBO record. | `qbo.service.js` |

What QBO gives you: accurate books (expenses + A/P + bank register), a vendor ledger per practitioner, 1099 groundwork, and an audit trail cross-referenced to `qboBillId` / `qboBillPaymentId`.

What QBO does **not** give you (via the API used here): **actual ACH fund movement** to a third-party bank account. QBO's own "Bill Pay" (powered by Melio) *can* move money, but it is a **separate product/integration** that is not wired in.

---

## 7. Automation, idempotency & audit

- **Schedule:** Agenda job `process-commission-payouts` — prod cron `30 0 25 * *` (00:30 on the 25th, `CDO_PAYOUT_TZ`); dev `CDO_PAYOUT_INTERVAL`.
- **End-to-end auto-run** (`runAutomatedPayouts`): accrue → **auto-approve** → batch → approve → execute → settle. **No human approval in the automated path.**
- **Idempotency (no duplicate books):** accrual guarded by `orderId`; `buildPayoutBatch` reserves commissions via `payoutId` + a partial-unique `(practitionerId, periodEnd)` index; `executeApprovedPayout` resumes-not-duplicates via per-step QBO id guards + stable QBO `requestid`s.
- **Audit:** `cdo_payouts.remarks[]` (per transition incl. `bank_validated`/`bank_invalid`), `cdo_transactions` running-balance ledger, `cdo_payout_batches` (per-run record + per-commission items).
- **Failure alerts:** failed payout → `log.error("cdo.payout.alert")` + console banner + optional webhook (`CDO_PAYOUT_ALERT_WEBHOOK_URL`, excludes bank details).

---

## 8. Flaws & gaps (production blockers)

> These are the reasons this **cannot** be used for real money as-is.

### 8.1 ✅ RESOLVED — fund movement via a provider; **Dwolla** ACH implemented
`executeApprovedPayout` initiates a real bank→bank transfer via the provider-agnostic disbursement layer (`app/services/payout/`) after recording the QBO Bill. A **Dwolla** ACH adapter is implemented (`provider/dwollaProvider.js`). **To send real money:** set `CDO_PAYOUT_PROVIDER=dwolla` + `DWOLLA_*` credentials + a verified `DWOLLA_FUNDING_SOURCE` (§9.1). The default `sandbox` provider simulates everything with no real money.

### 8.2 ✅ RESOLVED — `paid` now means funds settled
Execution moves the payout to **`awaiting_settlement`** (not `paid`); the QBO BillPayment + commissions-paid + ledger debit are recorded **only when the settlement poll confirms funds**. A new `process-payout-settlements` CRON (+ admin "Sync settlement" button) polls the provider and handles **ACH returns** (R01/R02/R03…) by flipping the payout to `failed` with the return code, keeping commissions reserved for a retry. See `docs/payout.md` §8.

### 8.3 🔴 No bank-account ownership verification
Bank details are only **format-validated** (ABA checksum + length). A wrong-but-valid account number sends money to the wrong person with no recourse. No micro-deposit or instant (Plaid-style) verification exists.

### 8.4 🟠 Bank account numbers appear to be stored in plaintext
`wholesale_applications.commission.bankAccountNumber` is a full account number in plaintext (see §4 example). For production this should be **encrypted at rest or tokenized** in a provider vault. (Our payout code never persists/logs it, but the source collection holds it.)

### 8.5 ✅ RESOLVED (single approval) — human approval before money moves
`CDO_PAYOUT_REQUIRE_APPROVAL=true` (default): the CRON builds payouts that wait in `awaiting_approval`; an admin must **Approve + Execute** before any transfer initiates. **Remaining (optional):** a *second*-approver/dual-control above a configurable amount threshold.

### 8.6 🟠 No funding-balance pre-check
Nothing verifies the source bank/clearing account has sufficient funds before initiating payouts. A batch could overdraw.

### 8.7 🟠 No payout cap / anomaly detection
A commission-accrual bug could produce an abnormally large payout; there is no max-amount guard or anomaly alert before money would move.

### 8.8 🟠 1099 / tax compliance not enforced
US contractors paid ≥ $600/yr need a **1099-NEC** and a collected **W-9**. Vendors are created but **not verified as 1099-eligible**, and W-9 collection is not enforced.

### 8.9 🟡 USD / US-ACH only
ACH is US-domestic. International practitioners need a different rail (wire / PayPal / Wise). The pipeline assumes USD.

### 8.10 ✅ RESOLVED — provider-level idempotency
The disbursement layer passes a per-attempt `idempotencyKey` (`cdo-payout-<id>-<attempt>`) to `initiateTransfer`; the adapter contract requires dedupe on it so a retried initiation never double-sends. (The real adapter must honor it.)

### 8.11 🟡 Alerting is log + optional webhook only
No escalation (email/PagerDuty/Slack) by default. A failed real-money payout could go unnoticed.

### 8.12 🟡 Operational caveats (documented)
Each app process boots its own scheduler — run a single scheduler owner or set `CDO_SCHEDULER_DISABLED=true` on the others. QBO is in **sandbox** unless `CDO_QBO_ENVIRONMENT=production` with a real refresh token + production account IDs.

---

## 9. Changes required for production with real money

Ordered by priority. **9.1 is the remaining hard blocker** (9.2 is now ✅ done; 9.3/9.4 remain blockers).

### 9.1 ✅ DONE (Dwolla) — real disbursement rail
The provider-agnostic layer + `awaiting_settlement` lifecycle + settlement poll are built (`app/services/payout/`), and a **Dwolla ACH adapter is implemented** (`provider/dwollaProvider.js`). To go live on Dwolla: set `CDO_PAYOUT_PROVIDER=dwolla`, `DWOLLA_ENVIRONMENT`, `DWOLLA_KEY`, `DWOLLA_SECRET`, and `DWOLLA_FUNDING_SOURCE` (a **verified** business funding source on the Dwolla account). Per payout the adapter find-or-creates a receive-only Customer + their bank funding source, then creates an idempotent Transfer; the settlement poll maps Dwolla `processed→settled`, `failed→returned` (with the ACH R-code). Other rails (Stripe / Modern Treasury) remain a single new adapter file against the same contract:
```js
initiateTransfer({ amount, currency, destination, idempotencyKey, reference, metadata })
  → { transferId, status: "pending"|"settled"|"failed", returnCode?, returnReason? }
getTransferStatus(transferId)
  → { status: "pending"|"settled"|"returned"|"failed", returnCode?, returnReason?, settledAt? }
```
Must be idempotent on `idempotencyKey` (`cdo-payout-<id>-<attempt>`). No changes to the payout logic are needed — it talks only to this interface.

**Remaining for Dwolla go-live:** verify the business funding source; prefer **webhooks** (`customer_bank_transfer_completed/_failed`) over polling for faster settlement; and complete §9.3 (bank verification) / §9.4 (encrypt stored account numbers) / §9.6–§9.10.

### 9.2 ✅ DONE — settlement lifecycle
- `cdo_payouts.status = "awaiting_settlement"` added (execute → awaiting_settlement; settle → paid; return → failed).
- `paid` (+ the QBO BillPayment + commissions-paid + ledger debit) now happens **only on confirmed settlement**.
- New `process-payout-settlements` CRON + admin **Sync settlement** button poll the provider and transition the payout; returns flip to `failed` with the return code, commissions kept reserved for retry.
- Return-code fields (`returnCode`, `returnReason`, `returnedAt`) + `providerName`/`providerTransferId`/`providerStatus`/`transferInitiatedAt`/`transferAttemptCount`/`settledAt`/`settlementLastCheckedAt` added to `cdo_payouts`.
- **Remaining:** prefer provider **webhooks** over polling for faster/cheaper settlement notification once a real provider is chosen.

### 9.3 Bank-account verification (BLOCKER)
Before a practitioner's first payout, verify ownership (micro-deposits or Plaid). Gate disbursement on a `bankVerified` flag.

### 9.4 Protect bank data at rest (BLOCKER)
Encrypt/tokenize `bankAccountNumber` in `wholesale_applications.commission` (coordinate with the wholesale workspace), or move to a provider vault token. Audit any logs/exports for leakage.

### 9.5 ✅ DONE (single approval) — human approval / dual control
`CDO_PAYOUT_REQUIRE_APPROVAL=true` gates disbursement behind an admin Approve + Execute. **Remaining (optional):** a second-approver above a configurable amount threshold.

### 9.6 Funding-balance pre-check + payout caps
Check source-account balance (or provider balance) before a run; add a per-payout max + batch-total max + anomaly alert that **pauses** rather than sends when exceeded.

### 9.7 Tax compliance
Mark practitioner QBO Vendors **1099-eligible**, enforce W-9 collection at onboarding, and confirm year-end 1099-NEC generation (QBO can do this once vendors are flagged).

### 9.8 Production config & cutover
- `CDO_QBO_ENVIRONMENT=production` + production refresh token + production `CDO_QBO_COMMISSION_EXPENSE_ACCOUNT_ID` / `CDO_QBO_PAYMENT_ACCOUNT_ID` / `CDO_QBO_AP_ACCOUNT_ID` (discover via `npm run cdo:qbo-accounts`).
- Single scheduler owner (or `CDO_SCHEDULER_DISABLED=true` elsewhere).
- Real funding bank account linked + funded.

### 9.9 Monitoring & escalation
Wire `CDO_PAYOUT_ALERT_WEBHOOK_URL` to a real channel; add settlement-failure + return alerts; dashboard for `awaiting_settlement` / `failed` payouts.

### 9.10 Compliance / legal (non-code)
NACHA originator agreement with the banking partner/provider, authorization records from practitioners to debit/credit, data-retention policy for bank details, and a reconciliation SOP.

---

## 10. Go-live checklist

- [x] Provider-agnostic disbursement abstraction + sandbox adapter (§8.2, §9.1)
- [x] `awaiting_settlement` + settlement-poll CRON + return handling shipped (§9.2)
- [x] Human approval gate before money moves (§9.5)
- [x] Provider-level idempotency key per attempt (§8.10)
- [x] End-to-end **sandbox** test: send → settle → return → retry reconciles correctly
- [x] Real disbursement adapter implemented — **Dwolla** (`provider/dwollaProvider.js`); set `CDO_PAYOUT_PROVIDER=dwolla` + `DWOLLA_*` to activate (§9.1)
- [ ] Dwolla account configured: verified business `DWOLLA_FUNDING_SOURCE` + sandbox→production cutover (§9.1)
- [ ] Bank-account verification live; `bankVerified` gate enforced (§9.3)
- [ ] Bank numbers encrypted/tokenized at rest (§9.4)
- [ ] (Optional) dual-control second approver above a threshold (§9.5)
- [ ] Funding-balance check + payout caps + anomaly pause (§9.6)
- [ ] 1099-eligible vendors + W-9 collection enforced (§9.7)
- [ ] QBO production realm + accounts + funded bank account (§9.8)
- [ ] Single scheduler owner; alerting wired to a real channel (§9.9); prefer provider webhooks over polling
- [ ] NACHA agreement + authorizations + reconciliation SOP (§9.10)

---

## 11. Quick reference

| Concern | File |
|---|---|
| Payout orchestration / lifecycle | `app/services/cdo/cdo.service.js` (`runAutomatedPayouts`, `executeApprovedPayout`, `checkPayoutSettlement`, `finalizeSettledPayout`, `resolvePractitionerBanking`) |
| Disbursement provider abstraction | `app/services/payout/provider/index.js` (factory + contract) |
| Sandbox provider (active) | `app/services/payout/provider/sandboxProvider.js` |
| Disbursement config | `app/services/payout/payout.config.js` |
| QBO Vendor / Bill / BillPayment | `app/services/qbo/qbo.service.js` |
| Payout schema | `app/models/cdoPayout.server.js` |
| Payout CRON | `app/services/scheduler/jobs/processCommissionPayouts.job.js` |
| Settlement CRON | `app/services/scheduler/jobs/processPayoutSettlements.job.js` |
| Banking source of truth | `wholesale_applications.commission` (read-only here) |
| Canonical technical spec | `docs/payout.md` (§6.5 banking, §8 disbursement+settlement) |
