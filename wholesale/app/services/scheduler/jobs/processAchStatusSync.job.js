// ACH Status Synchronization job.
//
// Independent of the payment-processing ticks (process-pending-payments):
// this job's SOLE responsibility is reconciling the status of in-flight
// ACH transactions with NMI. It polls NMI for every awaiting-settlement
// ACH invoice, detects status changes (settled / returned / voided /
// failed / still-settling), updates the payment + invoice records, stores
// return codes, maintains an audit trail, and alerts admins on critical
// returns — but it NEVER initiates a charge (that's the payment CRON).
// All logic lives in services/payment/achStatusSync; this module is the
// thin Agenda wrapper.
//
// Cadence is set by the scheduler and is environment-configurable:
// production runs once per day (ACH_SYNC_CRON, default "0 3 * * *");
// testing runs every minute (ACH_SYNC_INTERVAL, e.g. "1 minute").
// concurrency:1 so two ticks never overlap on the same invoice.

import { syncAchTransactionStatuses } from '../../payment/achStatusSync.service'
import { createLogger } from '../../../utils/logger.utils'

export const PROCESS_ACH_STATUS_SYNC_JOB = 'process-ach-status-sync'
const log = createLogger('job.ach_status_sync')

export function registerProcessAchStatusSyncJob(agenda) {
  agenda.define(
    PROCESS_ACH_STATUS_SYNC_JOB,
    { concurrency: 1, lockLifetime: 15 * 60 * 1000 },
    async (job) => {
      const tick = job.attrs.data?.tick || 'manual'
      const tickId = String(job.attrs._id).slice(-6)

      console.log(`\n┌─── [ach-status-sync ${tick} #${tickId}] ${new Date().toISOString()}`)
      log.info('tick.start', { tick, tickId })

      try {
        const summary = await syncAchTransactionStatuses({ now: new Date() })
        console.log(
          `└─── [ach-status-sync #${tickId}] evaluated=${summary.evaluated} ` +
            `settled=${summary.settled} returned=${summary.returned} ` +
            `stillPending=${summary.stillPending} unknown=${summary.unknown} ` +
            `errors=${summary.failed}`,
        )
        log.info('tick.done', { tickId, ...summary })
      } catch (err) {
        // A whole-sweep failure (e.g. DB connect) is logged + rethrown so
        // Agenda marks the job failed; per-invoice failures are already
        // isolated inside the service and never reach here.
        console.error(`└─── [ach-status-sync #${tickId}] FAILED:`, err?.stack || err)
        log.error('tick.failed', { tickId, err })
        throw err
      }
    },
  )
}
