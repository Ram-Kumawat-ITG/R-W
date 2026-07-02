// Drop-ship payment CRON.
//
// Independent of the wholesale payment ticks (process-pending-payments):
// this job's SOLE responsibility is collecting UNPAID drop-ship invoices
// (Invoice.isDropship=true) by charging the configured NMI vault
// (DROPSHIP_NMI_VAULT_ID) and recording the payment in QBO + Shopify. The
// wholesale CRON explicitly excludes drop-ship invoices, so the two never
// touch the same rows. All logic lives in services/dropship/
// dropshipPayment.service; this module is the thin Agenda wrapper.
//
// Cadence is set by the scheduler and is environment-configurable:
//   production — once per month (DROPSHIP_PAYMENT_CRON, default "30 0 1 * *")
//   testing    — every 2 minutes (DROPSHIP_PAYMENT_INTERVAL="2 minutes")
// concurrency:1 so two ticks never overlap on the same invoice.

import { collectDropshipPayments } from '../../dropship/dropshipPayment.service'
import { createLogger } from '../../../utils/logger.utils'

export const PROCESS_DROPSHIP_PAYMENTS_JOB = 'process-dropship-payments'
const log = createLogger('job.dropship_payments')

export function registerProcessDropshipPaymentsJob(agenda) {
  agenda.define(
    PROCESS_DROPSHIP_PAYMENTS_JOB,
    { concurrency: 1, lockLifetime: 30 * 60 * 1000 },
    async (job) => {
      const tick = job.attrs.data?.tick || 'manual'
      const tickId = String(job.attrs._id).slice(-6)
      const startedAt = Date.now()

      console.log(`\n┌─── [dropship-pay ${tick} #${tickId}] ${new Date().toISOString()}`)
      log.info('tick.start', { tick, tickId })

      try {
        const s = await collectDropshipPayments({ now: new Date() })
        const elapsedMs = Date.now() - startedAt
        console.log(
          `└─── [dropship-pay #${tickId}] done in ${elapsedMs}ms — ` +
            `charges: processed=${s.processed} collected=${s.approved} declined=${s.declined} ` +
            `errored=${s.errored} skipped=${s.skipped}` +
            ` | sync-retries: processed=${s.sweepProcessed} ok=${s.sweepOk} failed=${s.sweepFailed}\n`,
        )
        log.info('tick.done', { tickId, elapsedMs, ...s })
      } catch (err) {
        // A whole-sweep failure (e.g. DB connect) is logged + rethrown so
        // Agenda marks the job failed; per-invoice failures are isolated
        // inside the service and never reach here.
        console.error(`└─── [dropship-pay #${tickId}] FAILED:`, err?.stack || err)
        log.error('tick.failed', { tickId, err })
        throw err
      }
    },
  )
}
