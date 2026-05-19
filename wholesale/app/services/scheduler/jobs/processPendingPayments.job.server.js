import connectDB from '../../../db.server'
import Invoice from '../../../models/invoice.server'
import CustomerMap from '../../../models/customerMap.server'
import { attemptInvoiceCharge, propagateSuccessfulPayment } from '../../invoices/invoiceService.server'
import { createLogger } from '../../logger.server'

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
      const pendingCursor = Invoice.find({
        paymentStatus: 'pending',
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

          const result = await attemptInvoiceCharge({ invoice, customerMap })
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

      // PASS 2 — invoices already paid in NMI but whose downstream sync
      // (QBO recordPayment or Shopify orderMarkAsPaid) failed previously.
      // Replays just the sync side; never re-charges NMI.
      const sweepFilter = {
        paymentStatus: 'paid',
        $or: [{ qboPaymentRecorded: false }, { shopifyMarkedPaid: false }],
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
            amount: invoice.amountDue,
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
          ` | sync-retries: processed=${sweepProcessed} ok=${sweepOk} failed=${sweepFailed}\n`,
      )
      log.info('tick.complete', {
        tick, tickId, elapsedMs,
        processed, approved, declined, errored, skipped,
        sweepProcessed, sweepOk, sweepFailed,
      })
    },
  )
}
