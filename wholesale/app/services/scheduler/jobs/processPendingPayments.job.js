import connectDB from '../../APIService/mongo.service'
import Invoice from '../../../models/invoice.server'
import CustomerMap from '../../../models/customerMap.server'
import { chargeInvoice, propagateSuccessfulPayment } from '../../payment/payment.service'
import { createLogger } from '../../../utils/logger.utils'

export const PROCESS_PENDING_PAYMENTS_JOB = 'process-pending-payments'
const log = createLogger('job.pending_payments')

// Fires on the 15th and last day of each month. Walks every pending
// invoice and attempts a single NMI charge. Each attempt mutates the
// invoice atomically (in_progress → paid/pending/failed) so a re-run is
// safe.
export function registerProcessPendingPaymentsJob(agenda) {
  agenda.define(
    PROCESS_PENDING_PAYMENTS_JOB,
    { concurrency: 1, lockLifetime: 30 * 60 * 1000 },
    async (job) => {
      const tick = job.attrs.data?.tick || 'manual'
      const tickId = String(job.attrs._id).slice(-6)
      const startedAt = Date.now()

      console.log(`\n┌─── [scheduler tick ${tick} #${tickId}] ${new Date().toISOString()}`)
      log.info('tick.start', { tick, tickId })
      await connectDB()

      // PASS 1 — pending invoices that still need to be charged.
      //
      // Card-only: cheque and ACH invoices are skipped by the CRON. Those
      // sit on `paymentStatus: 'pending'` until an admin records a
      // manual cheque receipt or falls back to charging the card from
      // the Order Details page.
      const pendingCursor = Invoice.find({
        paymentStatus: 'pending',
        paymentMethod: 'card',
        $expr: { $lt: ['$attemptCount', '$maxAttempts'] },
      }).cursor()

      let processed = 0
      let approved = 0
      let declined = 0
      let errored = 0
      let skipped = 0

      for await (const invoice of pendingCursor) {
        processed += 1
        const invId = invoice._id.toString()
        const remaining = invoice.amountDue - invoice.amountPaid
        console.log(
          `│   invoice ${invoice.qboInvoiceId || invId} order=${invoice.shopifyOrderId} ` +
            `email=${invoice.customerEmail} due=$${remaining.toFixed(2)} ` +
            `attempt=${invoice.attemptCount + 1}/${invoice.maxAttempts}`,
        )
        try {
          const customerMap = invoice.customerMapRef
            ? await CustomerMap.findById(invoice.customerMapRef)
            : null

          const result = await chargeInvoice({ invoice, customerMap })
          // Mirror the outcome into the remarks[] ledger — surfaces in
          // the Order List "Remarks" column. We re-read the invoice
          // because chargeInvoice mutates amountDue / fee state.
          const after = await Invoice.findById(invoice._id).select('amountDue amountPaid currency')
          const outstanding = after ? Number((after.amountDue - after.amountPaid).toFixed(2)) : null
          let remarkMsg
          if (result.skipped) {
            remarkMsg = `CRON skipped: ${result.reason}`
          } else if (result.outcome === 'approved') {
            remarkMsg = `CRON charged successfully (NMI txn ${result.transactionId || '?'})`
          } else if (result.outcome === 'declined') {
            remarkMsg = `CRON charge declined: ${result.responseText || 'no reason given'}`
          } else {
            remarkMsg = `CRON charge errored: ${result.error || result.responseText || 'unknown'}`
          }
          await Invoice.updateOne(
            { _id: invoice._id },
            {
              $push: {
                remarks: {
                  kind: 'cron_card_attempt',
                  message: remarkMsg,
                  amount: outstanding,
                  currency: after?.currency || invoice.currency,
                  source: 'cron',
                  createdAt: new Date(),
                },
              },
            },
          )
          if (result.skipped) {
            skipped += 1
            console.log(`│     → SKIPPED reason="${result.reason}"`)
          } else if (result.outcome === 'approved') {
            approved += 1
            console.log(`│     → APPROVED txn=${result.transactionId}`)
          } else if (result.outcome === 'declined') {
            declined += 1
            console.log(`│     → DECLINED "${result.responseText}"`)
          } else {
            errored += 1
            console.log(`│     → ERROR "${result.error || result.responseText || 'unknown'}"`)
          }
        } catch (err) {
          errored += 1
          console.log(`│     → THREW ${err.message}`)
          console.error(err.stack || err)
          log.error('charge.unexpected', { invoiceId: invId, err })
        }
      }

      // PASS 1.5 — non-card pending invoices (cheque + ACH) and failed
      // card invoices. CRON cannot auto-charge these, so we log a
      // "reminder" remark each tick. Admins see the follow-up trail on
      // the Order List "Remarks" column and can act manually (mark
      // cheque paid / charge card on file). No customer-facing
      // notifications are sent here — operator-visible log only.
      const reminderCursor = Invoice.find({
        $or: [
          { paymentStatus: 'pending', paymentMethod: { $in: ['check', 'ach'] } },
          { paymentStatus: 'failed' },
        ],
      }).cursor()
      let remindersLogged = 0
      for await (const invoice of reminderCursor) {
        const outstanding = Number((invoice.amountDue - invoice.amountPaid).toFixed(2))
        const isFailed = invoice.paymentStatus === 'failed'
        const kind = isFailed ? 'cron_failed_followup' : 'cron_cheque_reminder'
        const methodLabel = invoice.paymentMethod === 'ach' ? 'ACH' : 'Cheque'
        const message = isFailed
          ? `Failed payment follow-up — $${outstanding.toFixed(2)} outstanding after ${invoice.attemptCount} attempt(s)`
          : `${methodLabel} payment reminder — $${outstanding.toFixed(2)} still outstanding`
        await Invoice.updateOne(
          { _id: invoice._id },
          {
            $push: {
              remarks: {
                kind,
                message,
                amount: outstanding,
                currency: invoice.currency,
                source: 'cron',
                createdAt: new Date(),
              },
            },
          },
        )
        remindersLogged += 1
        console.log(`│ ⓘ reminder logged invoice=${invoice._id} "${message}"`)
      }

      // PASS 2 — invoices that have money paid but downstream sync
      // (QBO recordPayment, Shopify SALE transaction, or Shopify
      // orderMarkAsPaid) is behind. Replays just the sync side; never
      // re-charges NMI.
      //
      // The filter covers partial-payment cases too: a partially_paid
      // invoice whose Shopify SALE transactions don't sum to amountPaid
      // also belongs here. We use $expr to compare numeric fields, then
      // OR with the legacy boolean flags (covers pre-cumulative invoices
      // that don't have qboRecordedTotal/shopifyRecordedTotal populated).
      //
      // We also sweep `in_progress` rows. That status is the transient
      // lock chargeInvoice writes around its NMI call — if anything
      // ever leaves an invoice stuck there (a crash between the
      // approval and the final save, or a now-fixed sticky-derive
      // bug that prevented release of the lock), propagate's
      // self-heal at the top will re-derive the status from the
      // money fields and fix it. The benign concurrent-charge race
      // (CRON sweep firing while a real chargeInvoice is mid-NMI)
      // doesn't post duplicates: propagate's diff-against-cumulative
      // sync skips work that's already done, and chargeInvoice's
      // own save() runs after this loop completes.
      const sweepFilter = {
        paymentStatus: { $in: ['paid', 'partially_paid', 'partially_refunded', 'in_progress'] },
        $or: [
          { qboPaymentRecorded: false },
          { shopifyMarkedPaid: false, paymentStatus: 'paid' },
          { paymentStatus: 'in_progress' },
          {
            $expr: {
              $gt: [
                { $subtract: ['$amountPaid', { $ifNull: ['$qboRecordedTotal', 0] }] },
                0.005,
              ],
            },
          },
          {
            $expr: {
              $gt: [
                {
                  $subtract: [
                    '$amountPaid',
                    { $ifNull: ['$shopifyRecordedTotal', 0] },
                  ],
                },
                0.005,
              ],
            },
          },
        ],
      }
      const sweepCursor = Invoice.find(sweepFilter).cursor()
      let sweepProcessed = 0
      let sweepOk = 0
      let sweepFailed = 0

      for await (const invoice of sweepCursor) {
        sweepProcessed += 1
        const invId = invoice._id.toString()
        console.log(
          `│ ↻ sync-retry invoice ${invoice.qboInvoiceId || invId} order=${invoice.shopifyOrderId} ` +
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
            sweepOk += 1
            console.log(`│     ↻ → SYNCED ok`)
          } else {
            sweepFailed += 1
            console.log(`│     ↻ → still ${syncErrors.length} sync error(s)`)
          }
        } catch (err) {
          sweepFailed += 1
          console.log(`│     ↻ → THREW ${err.message}`)
          console.error(err.stack || err)
          log.error('sync_retry.unexpected', { invoiceId: invId, err })
        }
      }

      const elapsedMs = Date.now() - startedAt
      console.log(
        `└─── tick ${tick} done in ${elapsedMs}ms — ` +
          `charges: processed=${processed} approved=${approved} declined=${declined} errored=${errored} skipped=${skipped}` +
          ` | reminders: ${remindersLogged}` +
          ` | sync-retries: processed=${sweepProcessed} ok=${sweepOk} failed=${sweepFailed}\n`,
      )
      log.info('tick.complete', {
        tick, tickId, elapsedMs,
        processed, approved, declined, errored, skipped,
        remindersLogged,
        sweepProcessed, sweepOk, sweepFailed,
      })
    },
  )
}
