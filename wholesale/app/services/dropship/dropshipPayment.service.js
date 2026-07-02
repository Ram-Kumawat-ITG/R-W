// Drop-ship payment collection — the engine behind the dedicated
// `process-dropship-payments` CRON.
//
// Responsibility: collect every UNPAID drop-ship invoice
// (Invoice.isDropship=true, paymentStatus='pending') by charging the SINGLE
// configured NMI customer vault (DROPSHIP_NMI_VAULT_ID), then record the
// payment in QBO + mark the Shopify order paid. The synthetic retail
// drop-ship customer has no per-registration vault, so the vault id comes
// from config and is INJECTED onto the customer map at charge time.
//
// This deliberately REUSES the wholesale payment primitives:
//   - payment.service.chargeInvoice          — NMI vault charge, with the
//       in_progress lock, PaymentAttempt audit ledger, attempt counting,
//       vault pre-flight, and (on approval) inline propagateSuccessfulPayment.
//   - invoice.service.propagateSuccessfulPayment — QBO recordPayment + Shopify
//       markAsPaid + local mirror, idempotent per-side.
// so duplicate-payment prevention, status tracking, and error handling match
// the battle-tested wholesale path exactly.
//
// Idempotency / duplicate prevention:
//   - chargeInvoice skips invoices already paid/cancelled/in_progress and
//     enforces the in_progress lock, so two overlapping ticks can't double-
//     charge. (The job is also registered concurrency:1.)
//   - propagateSuccessfulPayment records only the (amountPaid − qboRecordedTotal)
//     delta, so QBO never gets a duplicate Payment.
//
// Two passes per tick (mirrors process-pending-payments PASS 1 + PASS 2,
// filtered to drop-ship invoices — the wholesale CRON excludes these via
// `isDropship: { $ne: true }`):
//   PASS A — charge pending drop-ship invoices against the configured vault.
//   PASS B — replay downstream sync for drop-ship invoices that were charged
//            but whose QBO/Shopify sync is behind (never re-charges NMI).

import connectDB from '../APIService/mongo.service'
import Invoice from '../../models/invoice.server'
import CustomerMap from '../../models/customerMap.server'
import { chargeInvoice, propagateSuccessfulPayment } from '../payment/payment.service'
import { appendInvoiceRemark } from '../invoice/invoice.service'
import { dropshipPaymentConfig } from './dropshipPayment.config'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('dropship.payment.service')

// Build the operator-facing remark message for one charge attempt — mirrors
// the wholesale PASS 1 wording so the Order Details / Remarks feed reads
// consistently.
function chargeRemarkMessage(result) {
  if (result.skipped) return `Drop-ship collection skipped: ${result.reason}`
  if (result.outcome === 'approved') {
    return `Drop-ship invoice collected — charged the configured NMI vault (txn ${result.transactionId || '?'})`
  }
  if (result.outcome === 'declined') {
    return `Drop-ship collection declined: ${result.responseText || 'no reason given'}`
  }
  return `Drop-ship collection errored: ${result.error || result.responseText || 'unknown'}`
}

export async function collectDropshipPayments({ now = new Date() } = {}) {
  await connectDB()
  const vaultId = dropshipPaymentConfig.vaultId || null

  const summary = {
    // PASS A — charges
    processed: 0,
    approved: 0,
    declined: 0,
    errored: 0,
    skipped: 0,
    // PASS B — sync retries
    sweepProcessed: 0,
    sweepOk: 0,
    sweepFailed: 0,
  }

  if (!vaultId) {
    console.warn(
      '[dropship-pay] DROPSHIP_NMI_VAULT_ID is not configured — cannot collect ' +
        'drop-ship invoices. Set it to the NMI customer vault for the drop-ship account.',
    )
    log.warn('collect.no_vault_configured')
  }

  // ── PASS A — charge pending drop-ship invoices ───────────────────
  const pendingCursor = Invoice.find({
    isDropship: true,
    paymentStatus: 'pending',
    autoChargePaused: { $ne: true },
    $expr: { $lt: ['$attemptCount', '$maxAttempts'] },
  }).cursor()

  for await (const invoice of pendingCursor) {
    summary.processed += 1
    const invId = invoice._id.toString()
    const remaining = Number((invoice.amountDue - invoice.amountPaid).toFixed(2))
    console.log(
      `│   drop-ship invoice ${invoice.qboInvoiceId || invId} order=${invoice.shopifyOrderId} ` +
        `email=${invoice.customerEmail} due=$${remaining.toFixed(2)} ` +
        `attempt=${invoice.attemptCount + 1}/${invoice.maxAttempts}`,
    )

    try {
      const customerMap = invoice.customerMapRef
        ? await CustomerMap.findById(invoice.customerMapRef)
        : null

      let result
      if (!customerMap) {
        // No QBO customer mapping → propagate would have nothing to record
        // against. Skip cleanly rather than charging into a dead end.
        result = { skipped: true, reason: 'no customer map for drop-ship invoice' }
      } else if (!vaultId) {
        result = { skipped: true, reason: 'no DROPSHIP_NMI_VAULT_ID configured' }
      } else {
        // Inject the configured drop-ship vault for this charge. chargeInvoice
        // reads customerMap.nmiCustomerVaultId; for method 'dropship' it routes
        // through the vault's default billing (no billing_id), exactly like a
        // card charge. The id is NOT persisted on the map — config stays the
        // single source of truth across ticks.
        customerMap.nmiCustomerVaultId = vaultId
        result = await chargeInvoice({ invoice, customerMap })
      }

      // Re-read the post-charge money state for the remark amount.
      const after = await Invoice.findById(invoice._id).select('amountDue amountPaid currency')
      const outstanding = after ? Number((after.amountDue - after.amountPaid).toFixed(2)) : null

      await appendInvoiceRemark(invoice._id, {
        kind: 'cron_dropship_attempt',
        message: chargeRemarkMessage(result),
        amount: outstanding,
        currency: after?.currency || invoice.currency,
        source: 'cron',
      })

      if (result.skipped) {
        summary.skipped += 1
        console.log(`│     → SKIPPED reason="${result.reason}"`)
      } else if (result.outcome === 'approved') {
        summary.approved += 1
        console.log(`│     → COLLECTED txn=${result.transactionId}`)
      } else if (result.outcome === 'declined') {
        summary.declined += 1
        console.log(`│     → DECLINED "${result.responseText}"`)
      } else {
        summary.errored += 1
        console.log(`│     → ERROR "${result.error || result.responseText || 'unknown'}"`)
      }
    } catch (err) {
      summary.errored += 1
      console.log(`│     → THREW ${err.message}`)
      console.error(err.stack || err)
      log.error('collect.charge.unexpected', { invoiceId: invId, err })
    }
  }

  // ── PASS B — sync-retry drop-ship invoices with downstream behind ──
  // A drop-ship invoice that was charged (paid) but whose QBO recordPayment
  // or Shopify markAsPaid failed sits here. Replays just the sync side —
  // never re-charges NMI. propagateSuccessfulPayment is idempotent per-side.
  const sweepCursor = Invoice.find({
    isDropship: true,
    paymentStatus: { $in: ['paid', 'partially_paid', 'in_progress'] },
    $or: [
      { qboPaymentRecorded: false },
      { shopifyMarkedPaid: false, paymentStatus: 'paid' },
      { paymentStatus: 'in_progress' },
      {
        $expr: {
          $gt: [{ $subtract: ['$amountPaid', { $ifNull: ['$qboRecordedTotal', 0] }] }, 0.005],
        },
      },
      {
        $expr: {
          $gt: [{ $subtract: ['$amountPaid', { $ifNull: ['$shopifyRecordedTotal', 0] }] }, 0.005],
        },
      },
    ],
  }).cursor()

  for await (const invoice of sweepCursor) {
    summary.sweepProcessed += 1
    const invId = invoice._id.toString()
    console.log(
      `│ ↻ drop-ship sync-retry ${invoice.qboInvoiceId || invId} order=${invoice.shopifyOrderId} ` +
        `qboRec=${invoice.qboPaymentRecorded} shopMarked=${invoice.shopifyMarkedPaid}`,
    )
    try {
      const customerMap = invoice.customerMapRef
        ? await CustomerMap.findById(invoice.customerMapRef)
        : null
      const { syncErrors } = await propagateSuccessfulPayment({
        invoice,
        customerMap,
        transactionId: undefined,
      })
      if (syncErrors.length === 0) {
        summary.sweepOk += 1
        console.log(`│     ↻ → SYNCED ok`)
      } else {
        summary.sweepFailed += 1
        console.log(`│     ↻ → still ${syncErrors.length} sync error(s)`)
      }
    } catch (err) {
      summary.sweepFailed += 1
      console.log(`│     ↻ → THREW ${err.message}`)
      console.error(err.stack || err)
      log.error('collect.sync_retry.unexpected', { invoiceId: invId, err })
    }
  }

  log.info('collect.done', { ...summary, now: now.toISOString() })
  return summary
}
