// Failed-card auto-retry job.
//
// Separate from the twice-monthly payment-retry ticks (process-pending-
// payments): re-charges CARD invoices whose first charge failed, on a fixed
// ladder (default 2 / 4 / 7 days after that first failure, max 3 retries), so
// recovery doesn't wait for the next regular cycle. Cadence is set by the
// scheduler (hourly cron in prod, PAYMENT_RETRY_FAILED_INTERVAL in dev/test).
// All logic lives in services/payment/paymentRetry; this is the thin Agenda
// wrapper. concurrency:1 + the Agenda lock + the per-invoice claim in the
// service guarantee no double-charge.

import { processFailedCardRetries } from '../../payment/paymentRetry.service'
import { createLogger } from '../../../utils/logger.utils'

export const PROCESS_FAILED_CARD_RETRIES_JOB = 'process-failed-card-retries'
const log = createLogger('job.failed_card_retries')

export function registerProcessFailedCardRetriesJob(agenda) {
  agenda.define(
    PROCESS_FAILED_CARD_RETRIES_JOB,
    { concurrency: 1, lockLifetime: 15 * 60 * 1000 },
    async (job) => {
      const tick = job.attrs.data?.tick || 'manual'
      const tickId = String(job.attrs._id).slice(-6)

      console.log(`\n┌─── [failed-card-retries ${tick} #${tickId}] ${new Date().toISOString()}`)
      log.info('tick.start', { tick, tickId })

      try {
        const summary = await processFailedCardRetries({ now: new Date() })
        console.log(
          `└─── [failed-card-retries #${tickId}] evaluated=${summary.evaluated} ` +
            `charged=${summary.charged} succeeded=${summary.succeeded} ` +
            `failed=${summary.failed} skipped=${summary.skipped} finalized=${summary.finalized}`,
        )
        log.info('tick.done', { tickId, ...summary })
      } catch (err) {
        console.error(`└─── [failed-card-retries #${tickId}] FAILED:`, err?.stack || err)
        log.error('tick.failed', { tickId, err })
        throw err
      }
    },
  )
}
