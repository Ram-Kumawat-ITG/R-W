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
import { chargeCustomerVault } from '../nmi/nmi.service'
import { propagateSuccessfulPayment } from '../invoice/invoice.service'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('payment.service')

// Attempt a single NMI charge against the invoice's outstanding balance.
// Caller is responsible for picking which invoices are eligible — this
// function only mutates the single invoice it's given.
//
// Result shape:
//   { skipped: true, reason }                                              ← no work attempted
//   { skipped: false, outcome: 'approved'|'declined'|'error', ... }        ← attempted
export async function chargeInvoice({ invoice, customerMap }) {
  if (invoice.paymentStatus === 'paid' || invoice.paymentStatus === 'cancelled') {
    return { skipped: true, reason: `invoice already ${invoice.paymentStatus}` }
  }
  if (invoice.attemptCount >= invoice.maxAttempts) {
    return { skipped: true, reason: 'max attempts reached' }
  }
  if (!customerMap?.nmiCustomerVaultId) {
    const attemptNumber = invoice.attemptCount + 1
    await PaymentAttempt.create({
      invoiceRef: invoice._id,
      qboInvoiceId: invoice.qboInvoiceId,
      attemptNumber,
      amount: invoice.amountDue - invoice.amountPaid,
      currency: invoice.currency,
      outcome: 'skipped',
      errorMessage: 'no NMI customer vault on file',
    })
    invoice.attemptCount = attemptNumber
    invoice.lastAttemptAt = new Date()
    invoice.lastAttemptError = 'no NMI customer vault on file'
    if (invoice.attemptCount >= invoice.maxAttempts) invoice.paymentStatus = 'failed'
    await invoice.save()
    return { skipped: true, reason: 'no NMI customer vault on file' }
  }

  // Mark in-flight so two concurrent jobs don't both charge the same card.
  // We rely on the document version to detect concurrent updates.
  invoice.paymentStatus = 'in_progress'
  await invoice.save()

  const amount = Number((invoice.amountDue - invoice.amountPaid).toFixed(2))
  const attemptNumber = invoice.attemptCount + 1
  let result
  try {
    result = await chargeCustomerVault({
      customerVaultId: customerMap.nmiCustomerVaultId,
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
    invoice.paymentStatus = invoice.attemptCount >= invoice.maxAttempts ? 'failed' : 'pending'
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
    invoice.amountPaid = Number((invoice.amountPaid + amount).toFixed(2))
    invoice.paidAt = new Date()
    invoice.paymentStatus = invoice.amountPaid >= invoice.amountDue ? 'paid' : 'pending'

    await propagateSuccessfulPayment({
      invoice,
      customerMap,
      amount,
      transactionId: result.transactionId,
    })
  } else {
    invoice.paymentStatus = invoice.attemptCount >= invoice.maxAttempts ? 'failed' : 'pending'
  }
  await invoice.save()

  return {
    skipped: false,
    outcome: result.outcome,
    transactionId: result.transactionId,
    responseText: result.responseText,
  }
}

// Re-export the sync-only path so the scheduler PASS 2 has a single
// "payment" service entry point regardless of whether the work was a
// fresh charge or just a downstream retry.
export { propagateSuccessfulPayment } from '../invoice/invoice.service'
