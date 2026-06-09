// Immediate-Payment settlement — turns a completed NMI hosted-checkout
// transaction into a settled invoice, reusing the same downstream sync
// (QBO Payment + Shopify mark-paid) as every other payment path. Driven by
// the public /pay/<token> return route after the NMI 3-step completes.
//
// This module imports from invoice.service (propagate + remark); nothing in
// invoice.service imports back from here, so there is no import cycle.

import Invoice from '../../models/invoice.server'
import PaymentAttempt from '../../models/paymentAttempt.server'
import { propagateSuccessfulPayment, appendInvoiceRemark } from '../invoice/invoice.service'
import { applyDerivedPaymentStatus } from '../invoice/invoice.utils'
import { setInvoicePayLinkMemo } from '../qbo/qbo.service'
import { mintPayToken, buildPayLinkUrl } from './payLink.utils'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('payLink.service')

// Provision the pay link on an EXISTING invoice that was realigned to the
// `immediate` method after creation (createInvoiceForOrder handles the
// at-creation path). Mints a token if missing and writes the link into the
// QBO CustomerMemo (best-effort so a QBO hiccup can't fail the realignment).
// Mutates + saves the passed invoice. Returns the pay URL (or null if the
// invoice already had a token).
export async function provisionImmediatePayLink(invoice) {
  if (invoice.payToken) return buildPayLinkUrl(invoice.payToken)

  invoice.payToken = mintPayToken()
  invoice.payTokenCreatedAt = new Date()
  const payLinkUrl = buildPayLinkUrl(invoice.payToken)

  try {
    if (invoice.qboInvoiceId) {
      const updated = await setInvoicePayLinkMemo({ qboInvoiceId: invoice.qboInvoiceId, payLinkUrl })
      if (updated?.SyncToken) invoice.qboSyncToken = updated.SyncToken
    }
  } catch (err) {
    log.warn('provision.memo_failed', { invoiceId: invoice._id.toString(), err: err?.message || String(err) })
  }

  await invoice.save()
  log.info('provision.done', { invoiceId: invoice._id.toString() })
  return payLinkUrl
}

// Re-stamp the pay link into an existing invoice's QBO CustomerMemo using the
// CURRENT configured base URL. Use when the link baked at creation points at
// a now-dead host — e.g. a dev tunnel that rotated, or after PAY_LINK_BASE_URL
// changed. Mints a token if the invoice somehow lacks one. The token itself
// never changes (the /pay/<token> path is stable); only the base host is
// refreshed. Returns the current pay URL. Throws if QBO rejects the update.
export async function refreshImmediatePayLink(invoice) {
  if (!invoice.payToken) {
    invoice.payToken = mintPayToken()
    invoice.payTokenCreatedAt = new Date()
  }
  const payLinkUrl = buildPayLinkUrl(invoice.payToken)

  if (invoice.qboInvoiceId) {
    const updated = await setInvoicePayLinkMemo({ qboInvoiceId: invoice.qboInvoiceId, payLinkUrl })
    if (updated?.SyncToken) invoice.qboSyncToken = updated.SyncToken
  }
  await invoice.save()
  log.info('refresh.done', { invoiceId: invoice._id.toString(), payLinkUrl })
  return payLinkUrl
}

// Compute the still-outstanding balance on an invoice (fee already baked
// into amountDue at creation for immediate invoices).
export function invoiceOutstanding(invoice) {
  return Number(((invoice.amountDue || 0) - (invoice.amountPaid || 0)).toFixed(2))
}

// Record a successful hosted (self-pay link) payment against an invoice and
// propagate it to QBO + Shopify. Idempotent on the NMI transaction id:
// concurrent or repeated callbacks carrying the same transactionId settle
// exactly once. `amount` defaults to the full outstanding balance and is
// clamped so a stale/oversized value can never overpay.
export async function settleHostedPayment({ invoice, customerMap, transactionId, amount }) {
  if (!transactionId) throw new Error('settleHostedPayment: transactionId is required')

  if (
    invoice.paymentStatus === 'paid' ||
    invoice.paymentStatus === 'cancelled' ||
    invoice.paymentStatus === 'refunded'
  ) {
    log.info('hosted.settle.skip_terminal', { invoiceId: invoice._id.toString(), status: invoice.paymentStatus })
    return { invoice, alreadySettled: true }
  }

  // Atomic dedup: claim this transactionId only if not already recorded.
  // A losing concurrent callback (or a browser refresh of the return URL)
  // gets null here and bails without touching the money fields.
  const claimed = await Invoice.findOneAndUpdate(
    { _id: invoice._id, payTransactionIds: { $ne: transactionId } },
    { $addToSet: { payTransactionIds: transactionId } },
    { new: true },
  )
  if (!claimed) {
    log.info('hosted.settle.dup_txn', { invoiceId: invoice._id.toString(), transactionId })
    return { invoice, alreadySettled: true }
  }

  const outstanding = invoiceOutstanding(claimed)
  if (outstanding <= 0.005) {
    log.info('hosted.settle.nothing_due', { invoiceId: claimed._id.toString() })
    return { invoice: claimed, alreadySettled: true }
  }
  let amt = amount != null ? Number(amount) : outstanding
  if (!Number.isFinite(amt) || amt <= 0) amt = outstanding
  if (amt > outstanding) amt = outstanding // clamp — never overpay

  const attemptNumber = (claimed.attemptCount || 0) + 1
  console.log(
    `[payLink] settling hosted payment invoice=${claimed._id} txn=${transactionId} ` +
      `amount=$${amt.toFixed(2)} of outstanding $${outstanding.toFixed(2)}`,
  )
  log.info('hosted.settle.recording', {
    invoiceId: claimed._id.toString(),
    transactionId,
    amount: amt,
    attemptNumber,
  })

  const attempt = await PaymentAttempt.create({
    invoiceRef: claimed._id,
    qboInvoiceId: claimed.qboInvoiceId,
    attemptNumber,
    amount: amt,
    currency: claimed.currency,
    outcome: 'hosted_paid',
    nmiTransactionId: transactionId,
    nmiResponseText: 'Hosted self-pay link (NMI 3-step)',
  })

  claimed.attemptCount = attemptNumber
  claimed.lastAttemptAt = new Date()
  claimed.lastAttemptError = null
  claimed.amountPaid = Number(((claimed.amountPaid || 0) + amt).toFixed(2))
  claimed.paidAt = claimed.paidAt || new Date()
  // Hosted checkout is a card charge — record it as settled via card.
  claimed.paymentSettledVia = 'card'
  claimed.paymentSettledAt = new Date()
  applyDerivedPaymentStatus(claimed)
  await claimed.save()

  const { syncErrors } = await propagateSuccessfulPayment({
    invoice: claimed,
    customerMap,
    amount: amt,
    transactionId,
  })

  await appendInvoiceRemark(claimed._id, {
    kind: 'system_note',
    message: `Customer paid online via payment link — $${amt.toFixed(2)} (NMI ${transactionId})`,
    amount: amt,
    currency: claimed.currency,
    source: 'system',
  })

  return { invoice: claimed, attempt, syncErrors, settled: true }
}
