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

import Invoice from '../../models/invoice.server'
import PaymentAttempt from '../../models/paymentAttempt.server'
import { chargeCustomerVault, validateCustomerVault } from '../nmi/nmi.service'
import { propagateSuccessfulPayment } from '../invoice/invoice.service'
import { invoiceConfig } from '../invoice/invoice.config'
import { computeProcessingFee, applyDerivedPaymentStatus } from '../invoice/invoice.utils'
import { createLogger } from '../../utils/logger.utils'

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
  if (invoice.attemptCount >= invoice.maxAttempts) {
    return { skipped: true, reason: 'max attempts reached' }
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
    return { skipped: true, reason }
  }

  // Mark in-flight so two concurrent jobs don't both charge the same card.
  // We rely on the document version to detect concurrent updates.
  invoice.paymentStatus = 'in_progress'
  await invoice.save()

  // Outstanding (base) — what's left to settle on the invoice before
  // adding the per-method processing fee. The fee is decided by the
  // ACTUAL settlement method on the invoice (not the customer's
  // preference): a cheque-preferred customer who lands here via the
  // admin charge-card fallback has invoice.paymentMethod === 'card'
  // already, so the 3% card fee applies. The fee is added at most
  // once per invoice — once processingFeeAppliedAt is set, retries
  // use the already-applied amount and don't double-add.
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

  const attemptNumber = invoice.attemptCount + 1
  let result
  try {
    result = await chargeCustomerVault({
      customerVaultId: vaultId,
      billingId,
      amount,
      currency: invoice.currency,
      orderId: invoice.shopifyOrderId,
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

  invoice.attemptCount = attemptNumber
  invoice.lastAttemptAt = new Date()
  invoice.lastAttemptError = result.outcome === 'approved' ? null : result.responseText

  if (result.outcome === 'approved') {
    // Stage processing-fee state locally on the settling charge —
    // propagateSuccessfulPayment appends the fee line to QBO and sets
    // processingFeeAppliedAt once QBO confirms. Partial charges
    // (willSettleNow=false) don't stage the fee; it rides along on the
    // final charge that closes the invoice.
    if (feePreview && willSettleNow) {
      invoice.processingFeeAmount = feePreview.amount
      invoice.processingFeeRate = feePreview.rate
      invoice.processingFeeMethod = feePreview.method
      invoice.amountDue = Number((invoice.amountDue + feeAmount).toFixed(2))
    }
    invoice.amountPaid = Number((invoice.amountPaid + amount).toFixed(2))
    invoice.paidAt = new Date()
    // Record what actually settled this charge. Reflects the active
    // `paymentMethod` at the moment of approval, which is 'card' or
    // 'ach' for NMI-driven settlements. The cheque → card override
    // flips paymentMethod BEFORE chargeInvoice runs, so a cheque
    // invoice that fell back to card lands here with paymentMethod
    // already set to 'card'.
    invoice.paymentSettledVia = invoice.paymentMethod === 'ach' ? 'ach' : 'card'
    invoice.paymentSettledAt = invoice.paidAt
    // Status flows through the derivation helper: partial_paid when
    // amountPaid < amountDue, paid when settled, paid-with-refund
    // states once refunds[] is populated. Single source of truth.
    applyDerivedPaymentStatus(invoice)

    await propagateSuccessfulPayment({
      invoice,
      customerMap,
      amount,
      transactionId: result.transactionId,
    })
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
  }
}

// Re-export the sync-only path so the scheduler PASS 2 has a single
// "payment" service entry point regardless of whether the work was a
// fresh charge or just a downstream retry.
export { propagateSuccessfulPayment } from '../invoice/invoice.service'
