// Configuration for the failed-CARD-payment auto-retry ladder.
//
// When a card charge attempt fails (declined / gateway error), we schedule up
// to 3 retries at fixed offsets from that FIRST failure — by default 2, 4, and
// 7 days later — and a dedicated CRON (process-failed-card-retries) re-charges
// when each is due, WITHOUT waiting for the twice-monthly process-pending-
// payments cycle.
//
// Two offset sets + a switch (like the reminder ladder):
//   Production (days)    2, 4, 7  days after the first failure
//   Testing  (minutes)   e.g. 1, 3, 4 minutes  (PAYMENT_RETRY_FAILED_USE_MINUTES)
// so the whole ladder can be exercised in minutes instead of a week.
//
// The retry COUNT is the offset-list length — there is no separate max-retries
// knob to drift out of sync (the requirement fixes it at 3).

import { readEnv, readBool } from '../../utils/env.utils'

function parseOffsets(raw, fallback) {
  const parsed = String(raw ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
  return parsed.length ? parsed : fallback
}

const dayOffsets = parseOffsets(readEnv('PAYMENT_RETRY_FAILED_DAYS', { fallback: '2,4,7' }), [2, 4, 7])
const minuteOffsets = parseOffsets(
  readEnv('PAYMENT_RETRY_FAILED_MINUTES', { fallback: '2,4,7' }),
  [2, 4, 7],
)

export const paymentRetryConfig = {
  // Production sweep cadence. Hourly is frequent enough for day-granularity
  // offsets while staying light (a tick that finds nothing due is one indexed
  // query gated on cardRetry.nextRetryAt <= now).
  cron: readEnv('PAYMENT_RETRY_FAILED_CRON', { fallback: '0 * * * *' }),
  // Dev/test override: Agenda "every <interval>" (e.g. "30 seconds"). Unset in prod.
  intervalOverride: readEnv('PAYMENT_RETRY_FAILED_INTERVAL'),
  timezone: readEnv('PAYMENT_SCHEDULE_TZ', { fallback: 'America/Los_Angeles' }),
  dayOffsets,
  minuteOffsets,
  useMinutes: readBool('PAYMENT_RETRY_FAILED_USE_MINUTES', false),
}

export function activeRetryOffsets() {
  return paymentRetryConfig.useMinutes ? paymentRetryConfig.minuteOffsets : paymentRetryConfig.dayOffsets
}

const MS_PER_DAY = 24 * 60 * 60 * 1000
const MS_PER_MIN = 60 * 1000

export function retryUnitMs() {
  return paymentRetryConfig.useMinutes ? MS_PER_MIN : MS_PER_DAY
}

// PURE. Build the initial cardRetry sub-document for an invoice whose first
// card charge just failed. `firstFailedAt` is the moment of that failure; every
// retry is scheduled relative to it. No I/O — the caller (chargeInvoice)
// assigns the result to `invoice.cardRetry` and saves as part of its own
// failure write, so the schedule is stored atomically with the failure.
export function buildInitialCardRetry(firstFailedAt, { reason, responseText } = {}) {
  const base = firstFailedAt instanceof Date ? firstFailedAt : new Date(firstFailedAt)
  const offsets = activeRetryOffsets()
  const unitMs = retryUnitMs()
  const schedule = offsets.map((offset, i) => ({
    attemptNumber: i + 1,
    scheduledAt: new Date(base.getTime() + offset * unitMs),
    status: 'pending',
  }))
  return {
    active: true,
    firstFailedAt: base,
    firstFailureReason: (reason || responseText || 'card payment failed').slice(0, 500),
    retryCount: 0,
    maxRetries: offsets.length,
    nextRetryAt: schedule[0]?.scheduledAt || null,
    processingAt: null,
    finalStatus: null,
    completedAt: null,
    schedule,
  }
}
