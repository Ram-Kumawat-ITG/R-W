// Payment-preference realignment.
//
// When a customer changes their payment preference (card / ACH / check),
// `applyPaymentPreferenceToOpenInvoices` realigns every UNPAID/OPEN invoice
// for that customer to the new method:
//   - recompute the per-method processing fee (card 3% / ach 1% / check 0%)
//     and rewrite the QBO invoice's fee line,
//   - recompute the per-method due date (DueDate on QBO + local dueAt),
//   - reset `failed` invoices back to `pending` so the new method's flow
//     (e.g. card/ACH auto-charge) resumes,
//   - mirror the new method onto CustomerMap (so it's not stale until the
//     next order) and append an audit entry to the customer's
//     wholesale_applications.paymentMethodHistory[] + a per-invoice remark.
//
// Eligibility (the business rules):
//   paymentStatus ∈ {pending, failed} AND amountPaid == 0.
//   Excluded: in_progress / awaiting_settlement (a charge is mid-flight),
//   partially_paid / paid (money already settled), cancelled.
//
// Future orders already pick up the new preference automatically —
// customer.service.ensureCustomerForOrder re-reads
// wholesale_applications.payment.method at order intake and
// createInvoiceForOrder reads CustomerMap.paymentMethod. This service only
// handles the EXISTING open invoices.
//
// Triggered from /api/update-profile (customer self-service) and
// /api/admin/customers/:id/payment-method (admin).

import Invoice from '../../models/invoice.server'
import CustomerMap from '../../models/customerMap.server'
import WholesaleApplication from '../../models/wholesaleApplication.server'
import { setInvoiceProcessingFee } from '../qbo/qbo.service'
import { invoiceConfig, resolveInvoiceDueDate } from './invoice.config'
import {
  computeProcessingFee,
  buildProcessingFeeLine,
} from './invoice.utils'
import { appendInvoiceRemark } from './invoice.service'
import { normalizePaymentMethod } from '../customer/customer.utils'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('paymentPreference.service')

const EPS = 0.005

// Statuses we will realign. amountPaid is additionally asserted to be 0
// below so a partial payment can never slip through even if the status
// filter is ever loosened.
const ELIGIBLE_STATUSES = ['pending', 'failed']

export async function applyPaymentPreferenceToOpenInvoices({
  shop,
  email,
  newMethod,
  performedBy,
  source, // 'customer' | 'admin'
}) {
  const method = normalizePaymentMethod(newMethod)
  const normalizedEmail = String(email || '').toLowerCase()
  if (!shop || !normalizedEmail) {
    throw new Error('applyPaymentPreferenceToOpenInvoices: shop and email are required')
  }

  console.log(
    `\n[pref] realigning open invoices for ${shop} / ${normalizedEmail} → ${method} ` +
      `(source=${source}, by=${performedBy || 'unknown'})`,
  )

  // Mirror the new preference onto CustomerMap immediately so the next
  // order's invoice uses it without waiting for the order-intake re-sync.
  // The prior cached value is our audit "previousMethod".
  const customerMap = await CustomerMap.findOne({ shop, email: normalizedEmail })
  const previousMethod = customerMap?.paymentMethod
    ? normalizePaymentMethod(customerMap.paymentMethod)
    : null
  if (customerMap && customerMap.paymentMethod !== method) {
    customerMap.paymentMethod = method
    await customerMap.save()
  }

  const candidates = await Invoice.find({
    shop,
    customerEmail: normalizedEmail,
    qboCreationStatus: 'created',
    qboInvoiceId: { $ne: null },
    paymentStatus: { $in: ELIGIBLE_STATUSES },
  }).select('_id')

  const summary = {
    newMethod: method,
    previousMethod,
    total: candidates.length,
    updated: 0,
    skipped: 0,
    failed: 0,
    affectedInvoiceIds: [],
    details: [],
  }

  for (const { _id } of candidates) {
    try {
      const outcome = await realignOneInvoice({ invoiceId: _id, method, performedBy, source })
      if (outcome.status === 'updated') {
        summary.updated += 1
        summary.affectedInvoiceIds.push(String(_id))
      } else {
        summary.skipped += 1
      }
      summary.details.push(outcome)
    } catch (err) {
      summary.failed += 1
      summary.details.push({ invoiceId: String(_id), status: 'failed', error: err.message })
      console.error(`[pref] invoice ${_id} realign FAILED: ${err.message}`)
      log.error('pref.invoice_failed', { invoiceId: String(_id), method, err })
    }
  }

  // Append the change-event audit entry to the customer's application.
  // Best-effort: a missing application (customer with no app row) just
  // means no customer-level history — the per-invoice remarks still stand.
  try {
    await WholesaleApplication.updateOne(
      { shop, email: normalizedEmail },
      {
        $push: {
          paymentMethodHistory: {
            previousMethod,
            newMethod: method,
            invoiceCount: summary.updated,
            affectedInvoiceIds: summary.affectedInvoiceIds,
            changedAt: new Date(),
            performedBy: performedBy || undefined,
            source: source === 'admin' ? 'admin' : 'customer',
          },
        },
      },
    )
  } catch (auditErr) {
    console.error(`[pref] audit-history write failed: ${auditErr.message}`)
    log.error('pref.audit_failed', { shop, email: normalizedEmail, err: auditErr })
  }

  console.log(
    `[pref] done — ${summary.updated} updated, ${summary.skipped} skipped, ` +
      `${summary.failed} failed (of ${summary.total} open)`,
  )
  log.info('pref.realign.done', {
    shop,
    email: normalizedEmail,
    previousMethod,
    newMethod: method,
    ...summary,
    details: undefined, // keep the structured log compact
  })

  return summary
}

// Realign a single invoice. Re-reads the invoice fresh so a status change
// between the candidate query and now is respected, re-validates
// eligibility, rewrites the QBO fee line + due date, then persists. Returns
// a per-invoice outcome record (never throws for the "skip" cases — only
// genuine QBO/DB errors propagate to the caller's try/catch).
async function realignOneInvoice({ invoiceId, method, performedBy, source }) {
  const invoice = await Invoice.findById(invoiceId)
  if (!invoice) return { invoiceId: String(invoiceId), status: 'skipped', reason: 'not_found' }

  const fromMethod = invoice.paymentMethod
  // Re-validate eligibility against the freshest state.
  if (!ELIGIBLE_STATUSES.includes(invoice.paymentStatus)) {
    return { invoiceId: String(invoiceId), status: 'skipped', reason: `status_${invoice.paymentStatus}` }
  }
  if (Number(invoice.amountPaid || 0) > EPS) {
    return { invoiceId: String(invoiceId), status: 'skipped', reason: 'amount_paid' }
  }
  if (invoice.achSyncInProgress) {
    return { invoiceId: String(invoiceId), status: 'skipped', reason: 'ach_sync_in_progress' }
  }
  if (fromMethod === method) {
    return { invoiceId: String(invoiceId), status: 'skipped', reason: 'same_method' }
  }
  if (!invoice.qboInvoiceId) {
    return { invoiceId: String(invoiceId), status: 'skipped', reason: 'no_qbo_invoice' }
  }

  // Pre-fee base = current total minus whatever fee is currently on it.
  // amountPaid is 0 here, so the base is the full pre-fee invoice amount
  // (products − discount + shipping + tax).
  const oldFee = Number(invoice.processingFeeAmount || 0)
  const base = Number((Number(invoice.amountDue || 0) - oldFee).toFixed(2))

  // New per-method fee on the same base.
  const newFee = computeProcessingFee({
    baseAmount: base,
    method,
    rates: invoiceConfig.processingFeeRates,
  })
  const feeLine = newFee ? buildProcessingFeeLine({ ...newFee, baseAmount: base }) : null

  // New per-method due date (ACH = on receipt, Card = billing-cycle date,
  // Check = N business days). Basis = the invoice's QBO txn date, falling
  // back to its creation timestamp.
  const basis = invoice.qboTxnDate || invoice.createdAt
  const { dueDate: newDueDate, dueAt: newDueAt } = resolveInvoiceDueDate(basis, method)

  // Rewrite the QBO invoice (fee line + due date) FIRST — if QBO rejects
  // (e.g. stale SyncToken from a concurrent CRON charge) we throw before
  // mutating local state, so the caller counts it failed and the invoice
  // stays internally consistent for the next run.
  const updated = await setInvoiceProcessingFee({
    qboInvoiceId: invoice.qboInvoiceId,
    feeLine,
    dueDate: newDueDate || undefined,
  })

  const newAmountDue = Number.isFinite(Number(updated?.TotalAmt))
    ? Number(updated.TotalAmt)
    : Number((base + (newFee?.amount || 0)).toFixed(2))

  // Persist local state.
  invoice.paymentMethod = method
  invoice.processingFeeAmount = newFee ? newFee.amount : 0
  invoice.processingFeeRate = newFee ? newFee.rate : 0
  invoice.processingFeeMethod = method
  invoice.processingFeeAppliedAt = newFee ? new Date() : null
  invoice.amountDue = newAmountDue
  invoice.qboSyncToken = updated?.SyncToken || invoice.qboSyncToken
  invoice.qboDueDate = newDueDate || invoice.qboDueDate
  invoice.dueAt = newDueAt || invoice.dueAt
  // A failed invoice on the old method gets a clean retry budget on the
  // new one (mirrors the cheque → card fallback's failed → pending reset).
  if (invoice.paymentStatus === 'failed') {
    invoice.paymentStatus = 'pending'
    invoice.attemptCount = 0
    invoice.lastAttemptError = null
  }
  await invoice.save()

  const feeMsg = `fee $${oldFee.toFixed(2)} → $${(newFee?.amount || 0).toFixed(2)}`
  await appendInvoiceRemark(invoice._id, {
    kind: 'admin_action',
    source: source === 'admin' ? 'admin' : 'system',
    message:
      `Payment method changed ${fromMethod} → ${method} (${feeMsg}, ` +
      `due ${newDueDate || 'n/a'}) by ${performedBy || (source === 'admin' ? 'admin' : 'customer')}`,
    currency: invoice.currency,
  })

  console.log(
    `[pref]   ✓ invoice ${invoice._id} ${fromMethod} → ${method} ` +
      `(${feeMsg}, amountDue=$${newAmountDue.toFixed(2)}, due ${newDueDate || 'n/a'})`,
  )

  return {
    invoiceId: String(invoice._id),
    qboInvoiceId: invoice.qboInvoiceId,
    status: 'updated',
    from: fromMethod,
    to: method,
    oldFee,
    newFee: newFee?.amount || 0,
    amountDue: newAmountDue,
    dueDate: newDueDate || null,
  }
}
