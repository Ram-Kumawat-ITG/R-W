// Scheduler / cron configuration.
//
// Production runs on monthly crons (15th + last day). Dev uses a much
// shorter interval so you can see the orchestrator pick up an invoice
// without waiting two weeks.

import { readEnv } from '../../utils/env.utils'

export const schedulerConfig = {
  scheduleTimezone: readEnv('PAYMENT_SCHEDULE_TZ', { fallback: 'America/Los_Angeles' }),
  // Production cron expressions. Defaults are 00:30 on the 15th and 00:30
  // on the last day of the month.
  retryCronPrimary: readEnv('PAYMENT_RETRY_CRON_PRIMARY', { fallback: '30 0 15 * *' }),
  retryCronSecondary: readEnv('PAYMENT_RETRY_CRON_SECONDARY', { fallback: '30 0 L * *' }),
  // Dev-only override. When set, replaces the cron expressions with an
  // Agenda "every <interval>" schedule. Examples:
  //   PAYMENT_RETRY_INTERVAL=1 minute
  //   PAYMENT_RETRY_INTERVAL=30 seconds
  // Leave unset in production.
  retryIntervalOverride: readEnv('PAYMENT_RETRY_INTERVAL'),
}
