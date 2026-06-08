// Check-payment reminder job.
//
// Separate from the payment-retry ticks (process-pending-payments): this
// identifies unpaid CHECK invoices and triggers QBO invoice reminder
// emails on the first / second / card-on-file ladder (Day 7 / 11 / 13 in
// production, Minute 1 / 3 / 4 in testing mode). Cadence is set by the
// scheduler (daily cron in prod, REMINDER_INTERVAL in dev/test). It only
// SENDS emails — it never charges a payment method. All logic lives in
// services/reminder; this module is the thin Agenda wrapper.

import { processCheckPaymentReminders } from '../../reminder/reminder.service'
import { createLogger } from '../../../utils/logger.utils'

export const PROCESS_CHECK_REMINDERS_JOB = 'process-check-reminders'
const log = createLogger('job.check_reminders')

export function registerProcessCheckRemindersJob(agenda) {
  agenda.define(
    PROCESS_CHECK_REMINDERS_JOB,
    { concurrency: 1, lockLifetime: 15 * 60 * 1000 },
    async (job) => {
      const tick = job.attrs.data?.tick || 'manual'
      const tickId = String(job.attrs._id).slice(-6)

      console.log(`\n┌─── [check-reminders ${tick} #${tickId}] ${new Date().toISOString()}`)
      log.info('tick.start', { tick, tickId })

      try {
        const summary = await processCheckPaymentReminders({ now: new Date() })
        console.log(
          `└─── [check-reminders #${tickId}] evaluated=${summary.evaluated} ` +
            `sent=${summary.sent} failed=${summary.failed} skipped=${summary.skipped}`,
        )
        log.info('tick.done', { tickId, ...summary })
      } catch (err) {
        console.error(`└─── [check-reminders #${tickId}] FAILED:`, err?.stack || err)
        log.error('tick.failed', { tickId, err })
        throw err
      }
    },
  )
}
