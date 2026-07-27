// Failed-CARD-payment auto-retry service.
//
// Drives the retry ladder recorded on `Invoice.cardRetry` (initialised by
// chargeInvoice the first time a card charge fails — see
// paymentRetry.config.buildInitialCardRetry). A dedicated CRON
// (process-failed-card-retries) calls `processFailedCardRetries` frequently;
// this re-charges each scheduled retry when due (default 2 / 4 / 7 days after
// the first failure), records the full per-attempt result on the ladder, and
// finalises it (paid or, after the last retry, failed) — WITHOUT waiting for
// the twice-monthly process-pending-payments cycle.
//
// Card-only (ACH has its own settlement flow; cheque/dropship excluded). While
// a ladder is `active`, PASS 1 skips the invoice, so the two charge paths can
// never double-charge the same invoice.
//
// Duplicate-safe + crash-resumable: concurrency 1 + Agenda lock + a per-invoice
// atomic `cardRetry.processingAt` claim (stale claims reclaimed after
// LOCK_STALE_MS). If a charge actually succeeded but we crashed before
// recording, the invoice is already `paid`, so chargeInvoice returns an
// "already paid" skip and we finalise instead of double-charging.

import connectDB from '../APIService/mongo.service'
import Invoice from '../../models/invoice.server'
import CustomerMap from '../../models/customerMap.server'
import WholesaleApplication from '../../models/wholesaleApplication.server'
import ShopifyOrder from '../../models/order.server'
import { chargeInvoice } from './payment.service'
import { paymentRetryConfig } from './paymentRetry.config'
import { reconcilePractitionerOrderHold } from '../order/orderHold.service'
import { notifyOrderBlocked } from '../order/orderBlockNotification.service'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('paymentRetry.service')

const LOCK_STALE_MS = 15 * 60 * 1000

const unit = () => (paymentRetryConfig.useMinutes ? 'min' : 'day')

function firstPendingEntry(invoice) {
  return (invoice.cardRetry?.schedule || []).find((e) => e.status === 'pending') || null
}

// Best-effort lookups for the order-block email — used only on the rare
// finalize-to-failed path, so a per-invoice query is fine. Both swallow their
// own errors and return null so they can never break the retry flow.
async function resolveOrderNumber(orderRef) {
  if (!orderRef) return null
  try {
    const order = await ShopifyOrder.findById(orderRef)
      .select('shopifyOrderName shopifyOrderNumber')
      .lean()
    if (!order) return null
    return order.shopifyOrderName || (order.shopifyOrderNumber ? `#${order.shopifyOrderNumber}` : null)
  } catch {
    return null
  }
}

async function resolvePractitionerName(email) {
  if (!email) return null
  try {
    const app = await WholesaleApplication.findOne({ email })
      .select('firstName lastName businessName')
      .lean()
    if (!app) return null
    return [app.firstName, app.lastName].filter(Boolean).join(' ') || app.businessName || null
  } catch {
    return null
  }
}

function dueEntry(invoice, now) {
  const e = firstPendingEntry(invoice)
  return e && new Date(e.scheduledAt).getTime() <= now.getTime() ? e : null
}

function finalizeLadder(invoice, finalStatus, now) {
  const cr = invoice.cardRetry
  if (!cr) return
  for (const e of cr.schedule || []) {
    if (e.status === 'pending') e.status = 'skipped'
  }
  cr.active = false
  cr.finalStatus = finalStatus
  cr.completedAt = now
  cr.nextRetryAt = null
  cr.processingAt = null
}

export async function processFailedCardRetries({ now = new Date() } = {}) {
  await connectDB()
  const staleThreshold = new Date(now.getTime() - LOCK_STALE_MS)

  // Never charge a blocked practitioner (mirrors PASS 1).
  const blockedApps = await WholesaleApplication.find({ status: 'blocked' }).select('email').lean()
  const blockedEmails = blockedApps.map((a) => String(a.email || '').toLowerCase()).filter(Boolean)

  const cursor = Invoice.find({
    'cardRetry.active': true,
    isDropship: { $ne: true },
    $or: [
      { 'cardRetry.nextRetryAt': { $lte: now } },
      { paymentStatus: { $in: ['paid', 'cancelled'] } },
    ],
    ...(blockedEmails.length ? { customerEmail: { $nin: blockedEmails } } : {}),
  }).cursor()

  const summary = { evaluated: 0, charged: 0, succeeded: 0, failed: 0, skipped: 0, finalized: 0 }

  for await (const candidate of cursor) {
    summary.evaluated += 1

    // Atomic claim — one worker/tick per invoice; excludes a ladder closed
    // between the cursor read and now; a stale lock (crash) is reclaimable.
    const invoice = await Invoice.findOneAndUpdate(
      {
        _id: candidate._id,
        'cardRetry.active': true,
        $or: [
          { 'cardRetry.processingAt': null },
          { 'cardRetry.processingAt': { $exists: false } },
          { 'cardRetry.processingAt': { $lt: staleThreshold } },
        ],
      },
      { $set: { 'cardRetry.processingAt': now } },
      { new: true },
    )
    if (!invoice) {
      summary.skipped += 1
      continue
    }

    let released = false
    try {
      // Settled out-of-band (admin / checkout / a crashed-but-successful prior
      // charge) → just close the ladder, no charge.
      if (
        invoice.paymentStatus === 'paid' ||
        invoice.paymentStatus === 'cancelled' ||
        invoice.amountPaid >= invoice.amountDue
      ) {
        finalizeLadder(invoice, invoice.paymentStatus, now)
        invoice.markModified('cardRetry')
        await invoice.save()
        released = true
        summary.finalized += 1
        continue
      }

      if (invoice.autoChargePaused) {
        invoice.cardRetry.processingAt = null
        invoice.markModified('cardRetry')
        await invoice.save()
        released = true
        summary.skipped += 1
        continue
      }

      const entry = dueEntry(invoice, now)
      if (!entry) {
        invoice.cardRetry.processingAt = null
        invoice.markModified('cardRetry')
        await invoice.save()
        released = true
        summary.skipped += 1
        continue
      }

      const customerMap = invoice.customerMapRef
        ? await CustomerMap.findById(invoice.customerMapRef)
        : null

      // Headroom so chargeInvoice's `attemptCount >= maxAttempts → failed` guard
      // doesn't prematurely mark the invoice failed mid-ladder — the LADDER owns
      // the terminal state (it sets `failed` only after the last retry).
      if (invoice.attemptCount + 1 >= invoice.maxAttempts) {
        invoice.maxAttempts = invoice.attemptCount + 2
      }

      log.info('retry.charge', {
        invoiceId: String(invoice._id),
        attemptNumber: entry.attemptNumber,
        scheduledAt: entry.scheduledAt,
      })

      const result = await chargeInvoice({ invoice, customerMap })
      summary.charged += 1

      const settledSkip = result.skipped && /already (paid|refunded)/i.test(result.reason || '')
      const approved = result.outcome === 'approved' && !result.awaitingSettlement
      const responseText = result.responseText || result.reason || result.error || null

      entry.executedAt = now
      entry.transactionId = result.transactionId || null
      entry.invoiceStatusAfter = invoice.paymentStatus
      if (approved || settledSkip) {
        entry.status = 'succeeded'
        entry.outcome = 'approved'
        entry.gatewayResponseText = responseText
      } else if (result.skipped) {
        entry.status = 'skipped'
        entry.outcome = 'skipped'
        entry.failureReason = result.reason || null
        entry.gatewayResponseText = responseText
      } else {
        entry.status = 'failed'
        entry.outcome = result.outcome || 'error'
        entry.failureReason = responseText
        entry.gatewayResponseText = responseText
      }

      invoice.cardRetry.retryCount = (invoice.cardRetry.retryCount || 0) + 1
      const nextPending = firstPendingEntry(invoice)
      invoice.cardRetry.nextRetryAt = nextPending ? nextPending.scheduledAt : null

      invoice.remarks.push({
        kind: 'cron_failed_retry',
        message:
          `Failed-card retry ${entry.attemptNumber}/${invoice.cardRetry.maxRetries} ` +
          `(${unit()} offset) → ${entry.outcome}` +
          (responseText ? `: ${responseText}` : ''),
        amount: invoice.amountDue - invoice.amountPaid,
        currency: invoice.currency,
        source: 'cron',
        createdAt: now,
      })

      if (approved || settledSkip || invoice.paymentStatus === 'paid') {
        finalizeLadder(invoice, 'paid', now)
        summary.succeeded += 1
        summary.finalized += 1
      } else if (invoice.cardRetry.retryCount >= invoice.cardRetry.maxRetries || !nextPending) {
        invoice.paymentStatus = 'failed'
        finalizeLadder(invoice, 'failed', now)
        summary.failed += 1
        summary.finalized += 1
      } else {
        invoice.cardRetry.processingAt = null
        summary.failed += 1
      }

      invoice.markModified('cardRetry')
      await invoice.save()
      released = true

      // All card retries exhausted → put the practitioner on a payment order
      // hold (blocks NEW orders at checkout until the invoice is paid).
      // Idempotent + best-effort (never throws); a successful retry instead
      // went through chargeInvoice → propagateSuccessfulPayment, which
      // re-reconciles and clears the hold if nothing else is outstanding.
      if (invoice.paymentStatus === 'failed') {
        const holdResult = await reconcilePractitionerOrderHold({
          shop: invoice.shop,
          email: invoice.customerEmail,
          reason: 'card_retries_exhausted',
        })

        // Email the practitioner (admin CC'd) the moment the block is newly
        // applied — `changed && held` = the transition INTO the blocked state,
        // so an already-blocked practitioner (another failed invoice) isn't
        // spammed. Best-effort: notify never throws, but guard anyway so a
        // notification defect can never abort the retry CRON.
        if (holdResult?.changed && holdResult?.held) {
          try {
            const orderNumber = await resolveOrderNumber(invoice.orderRef)
            const practitionerName = await resolvePractitionerName(invoice.customerEmail)
            await notifyOrderBlocked({
              invoice,
              practitionerName,
              orderNumber,
              retryCount: invoice.cardRetry?.retryCount,
              maxRetries: invoice.cardRetry?.maxRetries,
              lastFailedAt: now,
            })
          } catch (notifyErr) {
            log.error('retry.block_email_failed', {
              invoiceId: String(invoice._id),
              err: notifyErr?.message || notifyErr,
            })
          }
        }
      }
    } catch (err) {
      log.error('retry.invoice_failed', { invoiceId: String(invoice._id), err: err?.message || err })
    } finally {
      if (!released) {
        try {
          invoice.cardRetry.processingAt = null
          invoice.markModified('cardRetry')
          await invoice.save()
        } catch (e) {
          log.error('retry.lock_release_failed', { invoiceId: String(invoice._id), err: e?.message || e })
        }
      }
    }
  }

  log.info('retry.run_complete', summary)
  return summary
}
