// Payment orchestration — sits between the scheduler and NMI.
//
// Responsible for:
//   - choosing which invoices to charge (caller drives this; we mutate one
//     invoice per call)
//   - guarding against double-charge via the in_progress lock
//   - recording every attempt to the payment_attempts audit ledger
//   - delegating the actual NMI call to api/nmi services
//   - kicking off the post-success sync via invoice.service.propagateSuccessfulPayment
//
// Higher-level "charge all pending invoices" cron logic lives in
// services/scheduler/jobs/processPendingPayments.job.js — that's what
// calls into this service per-invoice.

import PaymentAttempt from '../../models/paymentAttempt.server'
import {
  chargeCustomerVault,
  validateCustomerVault,
  getNmiTransactionStatus,
} from '../nmi/nmi.service'
import { propagateSuccessfulPayment } from '../invoice/invoice.service'
import { invoiceConfig } from '../invoice/invoice.config'
import { computeProcessingFee, applyDerivedPaymentStatus } from '../invoice/invoice.utils'
import { createLogger } from '../../utils/logger.utils'
import { notifyNmiVaultInvalid, notifyNmiDuplicateTransaction } from '../notifications/nmiAlertNotification.service'
import { resolveCustomerCardBillingId, resolveCustomerAchBillingId } from '../customer/customer.service'

const log = createLogger('payment.service')

// Pick the right NMI ids for a given invoice. The CUSTOMER VAULT is
// always sourced from `customerMap.nmiCustomerVaultId` (mirrored from
// `wholesale_applications.nmiCustomerVaultId`) — every customer has at
// most one vault. ACH-method invoices additionally need the ACH
// BILLING id, which targets a specific billing profile inside the
// vault (NMI's customer vault can hold multiple billings — typically
// one card + one ACH); it's mirrored from
// `wholesale_applications.payment.ach.nmi_billing_id`. Card-method
// invoices omit the billing id, so NMI charges the vault's default
// (card) billing.
//
// Returns `{ vaultId, billingId, methodLabel, missingReason }`:
//   - vaultId        — customer_vault_id to pass to NMI (never null on
//                       success; null only when the customer has no
//                       vault at all)
//   - billingId      — billing_id to pass alongside vault for ACH; null
//                       for card invoices (use vault default)
//   - methodLabel    — human-readable "card" / "ACH" for log lines + the
//                       skip messages persisted to PaymentAttempt
//   - missingReason  — populated when EITHER required id is missing; the
//                       audit-ledger string for the skip
function resolveInvoiceVault(invoice, customerMap) {
  const method = invoice.paymentMethod || 'card'
  const vaultId = customerMap?.nmiCustomerVaultId || null
  if (method === 'ach') {
    const billingId = customerMap?.nmiAchBillingId || null
    let missingReason = null
    if (!vaultId) missingReason = 'no NMI customer vault on file'
    else if (!billingId) missingReason = 'no NMI ACH billing id on file'
    return { vaultId, billingId, methodLabel: 'ACH', missingReason }
  }
  // 'card' (and any future card-equivalent path) charges the vault's
  // default billing — no billing_id needed. Cheque-method invoices
  // never call chargeInvoice via CRON (PASS 1 filter excludes them)
  // but if an admin somehow triggers a charge on a cheque invoice we
  // treat the missing method gracefully — same code path as card with
  // no vault.
  return {
    vaultId,
    billingId: null,
    methodLabel: 'card',
    missingReason: vaultId ? null : 'no NMI customer vault on file',
  }
}

// Attempt a single NMI charge against the invoice's outstanding balance.
// Caller is responsible for picking which invoices are eligible — this
// function only mutates the single invoice it's given.
//
// Routes to the right NMI vault id based on `invoice.paymentMethod`:
//   - 'card' → customerMap.nmiCustomerVaultId
//   - 'ach'  → customerMap.nmiAchBillingId (sourced from
//              wholesale_applications.payment.ach.nmi_billing_id at
//              order intake)
//
// Result shape:
//   { skipped: true, reason }                                              ← no work attempted
//   { skipped: false, outcome: 'approved'|'declined'|'error', ... }        ← attempted
export async function chargeInvoice({ invoice, customerMap, requestedAmount }) {
  // Settled / cancelled / fully refunded — nothing to charge.
  if (
    invoice.paymentStatus === 'paid' ||
    invoice.paymentStatus === 'cancelled' ||
    invoice.paymentStatus === 'refunded'
  ) {
    return { skipped: true, reason: `invoice already ${invoice.paymentStatus}` }
  }
  // An ACH transaction is in flight at the NMI / ACH-network level —
  // starting a second sale now would either duplicate the debit (if
  // the first settles) or burn a retry on the same dollar amount.
  // The settlement-check CRON pass (PASS 1.7) is the only path that
  // moves invoices out of this state.
  if (invoice.paymentStatus === 'awaiting_settlement') {
    return {
      skipped: true,
      reason: `awaiting ACH settlement of NMI txn ${invoice.pendingSettlementTxnId || '?'}`,
    }
  }
  if (invoice.attemptCount >= invoice.maxAttempts) {
    return { skipped: true, reason: 'max attempts reached' }
  }

  // The NMI billing_id (card or ACH) is mirrored onto CustomerMap only at
  // ORDER INTAKE, so a practitioner who updated/ADDED their card or bank
  // details via the portal AFTER their last order leaves the cache stale/empty.
  // Re-resolve from the source of truth on a cache MISS (only) so the
  // scheduler/CRON auto-retry — which loads CustomerMap fresh and never
  // re-mirrors — targets what the practitioner just set, matching what the
  // manual retry endpoints already do. Runs BEFORE resolveInvoiceVault so the
  // resolved ACH billing id also satisfies that helper's missing-billing gate
  // (for ACH the billing id is required; without this a legit ACH invoice would
  // be skipped — and eventually auto-failed — purely because the cache was
  // stale). No extra DB read once mirrored (cache hit → skipped). Best-effort:
  // a lookup failure leaves the id as-is and the normal gate/behaviour below
  // applies, so it can never corrupt an otherwise-valid charge.
  if (customerMap && customerMap.shop && customerMap.email) {
    try {
      if (invoice.paymentMethod === 'ach' && !customerMap.nmiAchBillingId) {
        const resolved = await resolveCustomerAchBillingId({
          shop: customerMap.shop,
          email: customerMap.email,
          customerMap,
        })
        if (resolved) customerMap.nmiAchBillingId = resolved
      } else if (invoice.paymentMethod === 'card' && !customerMap.nmiCardBillingId) {
        const resolved = await resolveCustomerCardBillingId({
          shop: customerMap.shop,
          email: customerMap.email,
          customerMap,
        })
        if (resolved) customerMap.nmiCardBillingId = resolved
      }
    } catch (err) {
      log.warn('charge.billing_resolve_failed', {
        invoiceId: invoice._id?.toString(),
        method: invoice.paymentMethod,
        err: err?.message || String(err),
      })
    }
  }

  const { vaultId, billingId, methodLabel, missingReason } = resolveInvoiceVault(invoice, customerMap)
  if (missingReason) {
    const attemptNumber = invoice.attemptCount + 1
    await PaymentAttempt.create({
      invoiceRef: invoice._id,
      qboInvoiceId: invoice.qboInvoiceId,
      attemptNumber,
      amount: invoice.amountDue - invoice.amountPaid,
      currency: invoice.currency,
      outcome: 'skipped',
      errorMessage: missingReason,
    })
    invoice.attemptCount = attemptNumber
    invoice.lastAttemptAt = new Date()
    invoice.lastAttemptError = missingReason
    if (invoice.attemptCount >= invoice.maxAttempts) invoice.paymentStatus = 'failed'
    else applyDerivedPaymentStatus(invoice)
    await invoice.save()
    return { skipped: true, reason: missingReason }
  }

  // Vault-existence pre-flight against NMI. Validates the CUSTOMER VAULT
  // only (not the ACH billing id) — NMI's query.php exposes
  // `report_type=customer_vault` but has no billing-level query, so the
  // billing id can only be confirmed indirectly (it would surface as a
  // child element in the customer_vault response). We trust the stored
  // ACH billing id and let NMI reject the sale with a precise error if
  // it doesn't exist; that error lands on the PaymentAttempt row like
  // any other decline. The vault check catches the common failure mode
  // (vault deleted from NMI dashboard, sandbox↔prod env swap, data
  // import that lost the id).
  const vaultCheck = await validateCustomerVault(vaultId)
  if (!vaultCheck.valid) {
    const attemptNumber = invoice.attemptCount + 1
    const reason = `NMI customer vault ${vaultId} invalid: ${vaultCheck.reason}`
    await PaymentAttempt.create({
      invoiceRef: invoice._id,
      qboInvoiceId: invoice.qboInvoiceId,
      attemptNumber,
      amount: invoice.amountDue - invoice.amountPaid,
      currency: invoice.currency,
      outcome: 'skipped',
      errorMessage: reason,
    })
    invoice.attemptCount = attemptNumber
    invoice.lastAttemptAt = new Date()
    invoice.lastAttemptError = reason
    if (invoice.attemptCount >= invoice.maxAttempts) invoice.paymentStatus = 'failed'
    else applyDerivedPaymentStatus(invoice)
    await invoice.save()
    log.warn('charge.skipped.vault_invalid', {
      invoiceId: invoice._id.toString(),
      vaultId,
      methodLabel,
      reason: vaultCheck.reason,
    })
    // Fires on both CRON auto-charge and admin retry — this is the only
    // signal an admin gets that a customer's charge is silently not
    // happening (it will keep skipping every future attempt too).
    await notifyNmiVaultInvalid({
      invoiceId: invoice._id.toString(),
      shopifyOrderId: invoice.shopifyOrderId,
      vaultId,
      methodLabel,
      reason: vaultCheck.reason,
    }).catch((e) => log.error('vault_invalid_alert.failed', { err: e?.message || e }))
    return { skipped: true, reason }
  }

  // Mark in-flight so two concurrent jobs don't both charge the same card.
  // We rely on the document version to detect concurrent updates.
  invoice.paymentStatus = 'in_progress'
  await invoice.save()

  // Outstanding (base) — what's left to settle on the invoice before
  // adding the per-method processing fee. For card / ACH invoices the fee
  // was already added at creation (processingFeeAppliedAt is set, and it's
  // baked into amountDue), so feePreview below is null and we charge the
  // full fee-inclusive balance. The staging here is now the FALLBACK path:
  // it fires for the cheque → card admin override (a cheque invoice has no
  // fee yet, so charging the card applies the 3% card fee) and for legacy
  // invoices created before fee-at-creation. The fee is added at most once
  // per invoice — once processingFeeAppliedAt is set, retries use the
  // already-applied amount and don't double-add.
  //
  // `requestedAmount` is the optional admin-driven partial-charge amount
  // (entered on the Retry / Charge-card modal). It clips against the
  // remaining outstanding so an admin can never over-charge. CRON
  // callers pass it as undefined → full-balance charge as before.
  const remainingOutstanding = Number((invoice.amountDue - invoice.amountPaid).toFixed(2))
  let baseAmount = remainingOutstanding
  if (requestedAmount != null) {
    const req = Number(requestedAmount)
    if (!Number.isFinite(req) || req <= 0) {
      throw new Error(`chargeInvoice: requestedAmount must be > 0, got ${requestedAmount}`)
    }
    if (req > remainingOutstanding + 0.005) {
      throw new Error(
        `chargeInvoice: requestedAmount $${req.toFixed(2)} exceeds remaining balance $${remainingOutstanding.toFixed(2)}`,
      )
    }
    baseAmount = Number(req.toFixed(2))
  }
  // Processing fee is sized off the FULL remaining outstanding (it's a
  // per-invoice fee, not per-charge). It's only staged the first time —
  // subsequent partial charges of the same invoice don't re-stage.
  const feePreview =
    !invoice.processingFeeAppliedAt &&
    computeProcessingFee({
      baseAmount: remainingOutstanding,
      method: invoice.paymentMethod,
      rates: invoiceConfig.processingFeeRates,
    })
  // The fee only rides along on the charge that actually settles the
  // invoice. Partial charges send just the base portion; the final
  // charge picks up the fee. This keeps NMI's settled amount in lockstep
  // with the QBO invoice's TotalAmt.
  const willSettleNow = baseAmount + 0.005 >= remainingOutstanding
  const feeAmount = feePreview && willSettleNow ? feePreview.amount : 0
  const amount = Number((baseAmount + feeAmount).toFixed(2))
  console.log(
    `[payment] charging invoice=${invoice._id} method=${invoice.paymentMethod} ` +
      `vault=${vaultId}${billingId ? ` billing=${billingId}` : ''} (${methodLabel}) ` +
      `base=$${baseAmount.toFixed(2)} fee=$${feeAmount.toFixed(2)} total=$${amount.toFixed(2)}`,
  )

  // Resolve the NMI billing_id to target for this charge. Customers with
  // a single billing (card-or-check preferred) leave billingId undefined —
  // NMI charges the priority-1 (only) billing. ACH customers have two
  // billings inside their vault; we pick the one that matches the active
  // invoice.paymentMethod so the cheque→card / ACH→card admin fallback
  // hits the card billing instead of the (priority-1) ACH billing.
  const targetBillingId =
    invoice.paymentMethod === 'ach'
      ? customerMap.nmiAchBillingId || undefined
      : customerMap.nmiCardBillingId || undefined

  const attemptNumber = invoice.attemptCount + 1
  let result
  try {
    result = await chargeCustomerVault({
      customerVaultId: customerMap.nmiCustomerVaultId,
      billingId: targetBillingId,
      amount,
      currency: invoice.currency,
      // A UNIQUE per-order reference. Drop-ship invoices all charge ONE shared
      // vault, so a unique orderid is the only lever (this processor forbids
      // the `dup_seconds` override) to let NMI's gateway-level duplicate check
      // distinguish distinct same-amount orders — IF the gateway's "Duplicate
      // Transaction Checking" is configured to key on order id. Falls back to
      // the invoice id so the reference is never empty.
      orderId: invoice.shopifyOrderId || invoice._id?.toString(),
      invoiceNumber: invoice.qboDocNumber || invoice.qboInvoiceId,
    })
  } catch (err) {
    log.error('charge.threw', { invoiceId: invoice._id.toString(), err })
    await PaymentAttempt.create({
      invoiceRef: invoice._id,
      qboInvoiceId: invoice.qboInvoiceId,
      attemptNumber,
      amount,
      currency: invoice.currency,
      outcome: 'error',
      errorMessage: err.message,
    })
    invoice.attemptCount = attemptNumber
    invoice.lastAttemptAt = new Date()
    invoice.lastAttemptError = err.message
    if (invoice.attemptCount >= invoice.maxAttempts) invoice.paymentStatus = 'failed'
    else applyDerivedPaymentStatus(invoice)
    await invoice.save()
    return { skipped: false, outcome: 'error', error: err.message }
  }

  await PaymentAttempt.create({
    invoiceRef: invoice._id,
    qboInvoiceId: invoice.qboInvoiceId,
    attemptNumber,
    amount,
    currency: invoice.currency,
    outcome: result.outcome,
    nmiTransactionId: result.transactionId,
    nmiResponseCode: result.responseCode,
    nmiResponseText: result.responseText,
    nmiAuthCode: result.authCode,
    nmiAvsResponse: result.avsResponse,
    nmiCvvResponse: result.cvvResponse,
    rawResponse: result.raw,
  })

  // NMI's gateway-level duplicate-transaction check rejecting a charge is
  // a processor-config issue, not a routine decline — see the 2026-06-22
  // incident in CLAUDE.md. Flag it distinctly so an admin checks the NMI
  // control panel instead of assuming it's a normal card decline.
  if (result.outcome !== 'approved' && /duplicate transaction/i.test(result.responseText || '')) {
    await notifyNmiDuplicateTransaction({
      invoiceId: invoice._id.toString(),
      shopifyOrderId: invoice.shopifyOrderId,
      vaultId: customerMap.nmiCustomerVaultId,
      amount,
      responseText: result.responseText,
      transactionId: result.transactionId,
    }).catch((e) => log.error('duplicate_txn_alert.failed', { err: e?.message || e }))
  }

  invoice.attemptCount = attemptNumber
  invoice.lastAttemptAt = new Date()
  invoice.lastAttemptError = result.outcome === 'approved' ? null : result.responseText

  if (result.outcome === 'approved') {
    // ACH branch — NMI response code 100 on an ACH sale means "accepted
    // into the ACH network", NOT "funds settled". The transaction can
    // still be returned (NSF, closed account, frozen funds, etc.) for
    // 1–3 business days. We DO NOT bump amountPaid or run downstream
    // sync (QBO recordPayment / Shopify markPaid) at this point —
    // doing so would falsely mark the invoice as paid in QBO and on
    // Shopify, and a later ACH return would leave those systems out
    // of sync with reality.
    //
    // Instead the in-flight amount lives on pendingSettlementAmount
    // and the invoice goes to `awaiting_settlement`. The settlement-
    // check CRON pass (PASS 1.7) polls NMI for the transaction's
    // condition and applies the credit only after NMI returns
    // `complete`. The processing fee is staged the same way so the
    // QBO line append happens only post-settlement.
    if (invoice.paymentMethod === 'ach') {
      invoice.pendingSettlementTxnId = result.transactionId
      invoice.pendingSettlementAmount = amount
      invoice.pendingSettlementFeeAmount = feePreview && willSettleNow ? feePreview.amount : 0
      invoice.pendingSettlementSince = new Date()
      invoice.pendingSettlementLastCheckedAt = null
      invoice.paymentStatus = 'awaiting_settlement'
    } else {
      // Card branch — synchronous settlement. Funds are captured at
      // NMI's approval, so the existing fast-path applies: bump
      // amountPaid, stage the fee, run downstream sync, derive status.
      if (feePreview && willSettleNow) {
        invoice.processingFeeAmount = feePreview.amount
        invoice.processingFeeRate = feePreview.rate
        invoice.processingFeeMethod = feePreview.method
        invoice.amountDue = Number((invoice.amountDue + feeAmount).toFixed(2))
      }
      invoice.amountPaid = Number((invoice.amountPaid + amount).toFixed(2))
      invoice.paidAt = new Date()
      invoice.paymentSettledVia = 'card'
      invoice.paymentSettledAt = invoice.paidAt
      applyDerivedPaymentStatus(invoice)

      await propagateSuccessfulPayment({
        invoice,
        customerMap,
        amount,
        transactionId: result.transactionId,
      })
    }
  } else {
    if (invoice.attemptCount >= invoice.maxAttempts) invoice.paymentStatus = 'failed'
    else applyDerivedPaymentStatus(invoice)
  }
  await invoice.save()

  return {
    skipped: false,
    outcome: result.outcome,
    transactionId: result.transactionId,
    responseText: result.responseText,
    baseAmount,
    feeAmount,
    amount,
    // True when the approval put the invoice into ACH-settlement wait
    // (no money applied yet, no QBO/Shopify sync run). Callers (CRON,
    // admin endpoints) use this to log "submitted, awaiting settlement"
    // rather than "paid" in their remarks / response payloads.
    awaitingSettlement:
      result.outcome === 'approved' && invoice.paymentMethod === 'ach',
  }
}

// Re-export the sync-only path so the scheduler PASS 2 has a single
// "payment" service entry point regardless of whether the work was a
// fresh charge or just a downstream retry.
export { propagateSuccessfulPayment } from '../invoice/invoice.service'

// Poll NMI for the current condition of an awaiting-settlement ACH
// invoice and act on the result. Called by the scheduler PASS 1.7 and
// can also be invoked manually by an admin "Check settlement" action.
//
// Outcomes (all return shape: { action, condition?, ... }):
//   - { action: 'settled', amount }
//       NMI condition='complete' — credit the pendingSettlementAmount
//       to amountPaid, stage the fee, run propagateSuccessfulPayment,
//       clear pending fields, set paidAt + paymentSettledVia='ach'.
//   - { action: 'returned', condition, reason }
//       NMI condition='failed' or 'canceled' — drop the in-flight
//       credit, clear pending fields, advance attemptCount /
//       paymentStatus the same way a fresh decline would, log the
//       reason on lastAttemptError. The invoice goes back to
//       'pending' (or 'failed' if maxAttempts exhausted) so the next
//       CRON tick can retry OR the admin can fall back to the card
//       on file.
//   - { action: 'still_pending', condition }
//       Still working through ACH — no state change. Caller decides
//       whether to log a remark (CRON throttles to once-per-day).
//   - { action: 'unknown', reason }
//       NMI returned an unexpected condition or the lookup failed.
//       Caller logs a warning but does NOT touch invoice state.
//   - { action: 'noop', reason }
//       Invoice isn't actually awaiting settlement, or no transaction
//       id is on file. Defensive guard; should not normally fire.
export async function checkAchSettlement({ invoice, customerMap }) {
  if (!invoice) return { action: 'noop', reason: 'no invoice provided' }
  if (invoice.paymentStatus !== 'awaiting_settlement') {
    return { action: 'noop', reason: `invoice is not awaiting_settlement (status=${invoice.paymentStatus})` }
  }
  if (!invoice.pendingSettlementTxnId) {
    return { action: 'noop', reason: 'no pendingSettlementTxnId on file' }
  }

  const status = await getNmiTransactionStatus(invoice.pendingSettlementTxnId)
  invoice.pendingSettlementLastCheckedAt = new Date()

  if (!status.found) {
    // Don't change state on a transport / lookup failure. Save the
    // checked-at timestamp so the next pass throttles correctly.
    await invoice.save()
    log.warn('settlement.lookup.failed', {
      invoiceId: invoice._id.toString(),
      transactionId: invoice.pendingSettlementTxnId,
      reason: status.reason,
    })
    return { action: 'unknown', reason: status.reason }
  }

  const condition = status.condition
  // Map NMI's transaction conditions to one of three terminal outcomes.
  // NMI's documented condition values for ACH:
  //   complete           — funds settled, terminal success
  //   pendingsettlement  — accepted, still waiting on ACH network
  //   pending            — same as above for some gateway versions
  //   in_progress        — same idea (rare for ACH)
  //   failed             — terminal failure (NSF, return code, etc.)
  //   canceled           — voided / cancelled before settling
  //   unknown            — gateway lost track; treat as still-pending
  //                        for safety (don't credit, don't drop)
  if (condition === 'complete') {
    const settledAmount = Number(invoice.pendingSettlementAmount || 0)
    const settledFeeAmount = Number(invoice.pendingSettlementFeeAmount || 0)
    const transactionId = invoice.pendingSettlementTxnId

    if (settledFeeAmount > 0) {
      invoice.processingFeeAmount = settledFeeAmount
      invoice.processingFeeRate = invoiceConfig.processingFeeRates?.ach
      invoice.processingFeeMethod = 'ach'
      invoice.amountDue = Number((invoice.amountDue + settledFeeAmount).toFixed(2))
    }
    invoice.amountPaid = Number((invoice.amountPaid + settledAmount).toFixed(2))
    invoice.paidAt = new Date()
    invoice.paymentSettledVia = 'ach'
    invoice.paymentSettledAt = invoice.paidAt
    invoice.pendingSettlementTxnId = undefined
    invoice.pendingSettlementAmount = undefined
    invoice.pendingSettlementFeeAmount = undefined
    invoice.pendingSettlementSince = undefined
    // Clear the sticky guard before deriving so the helper can move
    // the invoice to paid / partially_paid based on amountPaid.
    invoice.paymentStatus = 'pending'
    applyDerivedPaymentStatus(invoice)

    await propagateSuccessfulPayment({
      invoice,
      customerMap,
      amount: settledAmount,
      transactionId,
    })
    await invoice.save()

    log.info('settlement.settled', {
      invoiceId: invoice._id.toString(),
      transactionId,
      amount: settledAmount,
      newStatus: invoice.paymentStatus,
    })
    return {
      action: 'settled',
      condition,
      amount: settledAmount,
      transactionId,
      newStatus: invoice.paymentStatus,
    }
  }

  if (condition === 'failed' || condition === 'canceled') {
    const failedAmount = Number(invoice.pendingSettlementAmount || 0)
    const transactionId = invoice.pendingSettlementTxnId
    const action = status.latestAction
    const reason =
      action?.response_text || action?.responsetext || `NMI condition=${condition}`
    const returnCode = action?.response_code || action?.responsecode || undefined

    // Persist the NACHA return detail on the invoice so the ACH
    // status-sync layer + admin UI can surface it (code + reason +
    // when). These are distinct from the PaymentAttempt row below: this
    // is the "latest return" snapshot on the invoice itself.
    invoice.achReturnCode = returnCode
    invoice.achReturnReason = reason
    invoice.achReturnedAt = new Date()

    // Persist the failure on the payment audit ledger so the
    // PaymentAttempt count + lastAttemptError reflect the return.
    // We use a NEW attempt number (the original 'approved' attempt
    // stays as-is so the audit trail is honest about what NMI's
    // gateway said at submission time).
    invoice.attemptCount = (invoice.attemptCount || 0) + 1
    invoice.lastAttemptAt = new Date()
    invoice.lastAttemptError = `ACH return — ${reason}`
    await PaymentAttempt.create({
      invoiceRef: invoice._id,
      qboInvoiceId: invoice.qboInvoiceId,
      attemptNumber: invoice.attemptCount,
      amount: failedAmount,
      currency: invoice.currency,
      outcome: condition === 'canceled' ? 'error' : 'declined',
      nmiTransactionId: transactionId,
      nmiResponseText: reason,
      errorMessage: `ACH settlement ${condition} — ${reason}`,
    })

    invoice.pendingSettlementTxnId = undefined
    invoice.pendingSettlementAmount = undefined
    invoice.pendingSettlementFeeAmount = undefined
    invoice.pendingSettlementSince = undefined
    // Move out of awaiting_settlement first so deriving below isn't
    // pinned by the sticky guard. amountPaid was never bumped so the
    // derivation falls back to 'pending' (or 'failed' if we hit max
    // attempts).
    if (invoice.attemptCount >= invoice.maxAttempts) {
      invoice.paymentStatus = 'failed'
    } else {
      invoice.paymentStatus = 'pending'
      applyDerivedPaymentStatus(invoice)
    }
    await invoice.save()

    log.warn('settlement.returned', {
      invoiceId: invoice._id.toString(),
      transactionId,
      condition,
      reason,
      newStatus: invoice.paymentStatus,
    })
    return {
      action: 'returned',
      condition,
      reason,
      returnCode,
      transactionId,
      amount: failedAmount,
      newStatus: invoice.paymentStatus,
    }
  }

  // pendingsettlement / pending / in_progress / unknown — leave alone.
  await invoice.save()
  return { action: 'still_pending', condition: condition || 'unknown' }
}
