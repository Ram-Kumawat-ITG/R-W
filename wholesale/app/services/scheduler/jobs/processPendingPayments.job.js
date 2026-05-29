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
      // Card AND ACH invoices both flow through here. The actual NMI
      // vault id is picked by payment.service.chargeInvoice based on
      // `invoice.paymentMethod`:
      //   - 'card' → customerMap.nmiCustomerVaultId
      //   - 'ach'  → customerMap.nmiAchBillingId (mirrored from
      //              wholesale_applications.payment.ach.nmi_billing_id)
      // Cheque invoices remain skipped — they sit on `paymentStatus:
      // 'pending'` until an admin records a manual cheque receipt or
      // falls back to charging the card on file.
      //
      // The `autoChargePaused: { $ne: true }` term excludes invoices an
      // admin has explicitly paused from the Order Details page. The
      // `$ne` (not `false`) covers legacy rows where the field is
      // absent entirely — those default to "not paused". When an admin
      // hits Resume the flag flips back to false and the next tick
      // picks the invoice up again.
      const pendingCursor = Invoice.find({
        paymentStatus: 'pending',
        paymentMethod: { $in: ['card', 'ach'] },
        autoChargePaused: { $ne: true },
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
          // Method-aware remark kind + label. The kind is captured at
          // write time off the invoice's CURRENT paymentMethod so the
          // Order Details badge ("CRON charge" vs "ACH charge") stays
          // accurate even if the admin later flips the method via the
          // ACH → card fallback. The label inside the message echoes
          // the same source so log scrapers don't need to peek at the
          // kind enum to know what failed.
          const methodIsAch = invoice.paymentMethod === 'ach'
          const remarkKind = methodIsAch ? 'cron_ach_attempt' : 'cron_card_attempt'
          const methodLabel = methodIsAch ? 'ACH' : 'card'
          let remarkMsg
          if (result.skipped) {
            remarkMsg = `CRON ${methodLabel} charge skipped: ${result.reason}`
          } else if (result.outcome === 'approved') {
            remarkMsg = `CRON ${methodLabel} charged successfully (NMI txn ${result.transactionId || '?'})`
          } else if (result.outcome === 'declined') {
            remarkMsg = `CRON ${methodLabel} charge declined: ${result.responseText || 'no reason given'}`
          } else {
            remarkMsg = `CRON ${methodLabel} charge errored: ${result.error || result.responseText || 'unknown'}`
          }
          await Invoice.updateOne(
            { _id: invoice._id },
            {
              $push: {
                remarks: {
                  kind: remarkKind,
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

      // PASS 1.5 — cheque-pending invoices (no NMI vault to charge
      // against) and failed card/ACH invoices that exhausted retries.
      // CRON cannot auto-charge these, so we log a "reminder" / "follow-up"
      // remark each tick. Admins see the trail on the Order List
      // "Remarks" column and can act manually (mark cheque paid, charge
      // card on file as a fallback, etc.). No customer-facing
      // notifications are sent here — operator-visible log only.
      //
      // ACH-pending invoices NO LONGER land here — they now flow through
      // PASS 1 as an active charge path against the NMI billing id.
      // The legacy `cron_ach_reminder` enum is preserved on the Invoice
      // schema for back-compat with rows written before that change;
      // PASS 1.5 will not emit it anymore.
      //
      // Paused invoices are excluded from reminders too — pausing is
      // an explicit "leave this one alone" signal. Surfacing a
      // recurring reminder would defeat that intent.
      const reminderCursor = Invoice.find({
        autoChargePaused: { $ne: true },
        $or: [
          { paymentStatus: 'pending', paymentMethod: 'check' },
          { paymentStatus: 'failed' },
        ],
      }).cursor()
      let remindersLogged = 0
      for await (const invoice of reminderCursor) {
        const outstanding = Number((invoice.amountDue - invoice.amountPaid).toFixed(2))
        const isFailed = invoice.paymentStatus === 'failed'
        // Failed invoices keep the "Failed follow-up" kind regardless
        // of original method so the Order List filter stays clean.
        // Pending invoices land here only when paymentMethod==='check',
        // so the kind is fixed at cron_cheque_reminder.
        const kind = isFailed ? 'cron_failed_followup' : 'cron_cheque_reminder'
        const methodLabel = isFailed
          ? (invoice.paymentMethod === 'ach' ? 'ACH' : 'Card')
          : 'Cheque'
        const message = isFailed
          ? `Failed ${methodLabel.toLowerCase()} payment follow-up — $${outstanding.toFixed(2)} outstanding after ${invoice.attemptCount} attempt(s)`
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
