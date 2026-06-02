// Configuration for the Check-payment reminder CRON.
//
// There are two ladders — a PRODUCTION ladder in DAYS and a TESTING ladder
// in MINUTES — and a switch (`REMINDER_USE_MINUTES`) that picks which one
// is live. Both are anchored to the invoice/order date.
//
//   Production (days)   First = 9   Second = 11   Card-on-file = 13
//   Testing  (minutes)  First = 1   Second = 3    Card-on-file = 4
//
// Testing mode lets the whole ladder be exercised in ~4 minutes (pair it
// with REMINDER_INTERVAL="1 minute" so the sweep runs every minute)
// instead of waiting nearly two weeks.

import { readEnv, readInt, readBool } from '../../utils/env.utils'

export const reminderConfig = {
  // Daily run time. Default 02:00 in the scheduler timezone.
  reminderCron: readEnv('REMINDER_CRON', { fallback: '0 2 * * *' }),
  // Dev/test override: replaces the cron with an Agenda "every <interval>"
  // schedule, e.g. REMINDER_INTERVAL="1 minute". Leave unset in prod.
  reminderIntervalOverride: readEnv('REMINDER_INTERVAL'),

  // Production ladder — DAYS since the order/invoice date.
  dayFirst: readInt('REMINDER_DAY_FIRST', 9), // First payment reminder
  daySecond: readInt('REMINDER_DAY_SECOND', 11), // Second payment reminder
  dayCard: readInt('REMINDER_DAY_CARD', 13), // Final card-on-file notice

  // Testing ladder — MINUTES since the order/invoice date. Used only when
  // REMINDER_USE_MINUTES=true.
  minFirst: readInt('REMINDER_MIN_FIRST', 1), // First payment reminder
  minSecond: readInt('REMINDER_MIN_SECOND', 3), // Second payment reminder
  minCard: readInt('REMINDER_MIN_CARD', 4), // Final card-on-file notice

  // Recurring phase — AFTER the final (card / Day 13) stage has been
  // sent, the job keeps emailing a reminder every `repeat` units until
  // the invoice is fully paid. This is the "configured interval" the
  // spec calls for. DAYS in production, MINUTES in testing mode. The
  // service throttles to this interval since the most recent reminder,
  // so the email cadence is independent of how often the CRON ticks.
  repeatDays: readInt('REMINDER_REPEAT_DAYS', 2), // every 2 days after Day 13
  repeatMinutes: readInt('REMINDER_REPEAT_MINUTES', 1), // every 1 min in testing

  // Switch: when true, the testing (minute) ladder is live and elapsed
  // time is measured in minutes; when false, the production (day) ladder.
  useMinutes: readBool('REMINDER_USE_MINUTES', false),
}

// Ordered high → low so the job sends the most-advanced due-but-unsent
// reminder in a single run (and never an earlier one once a later one is
// warranted — e.g. if the CRON was down across several days). The active
// threshold for each stage is chosen by `useMinutes`.
export function reminderStages() {
  const m = reminderConfig.useMinutes
  return [
    {
      stage: 'card',
      threshold: m ? reminderConfig.minCard : reminderConfig.dayCard,
      label: 'Final card-on-file notice',
      message:
        'Outstanding balance remains unpaid and may be charged to the card on file.',
    },
    {
      stage: 'second',
      threshold: m ? reminderConfig.minSecond : reminderConfig.daySecond,
      label: 'Second payment reminder',
      message: 'Second reminder — invoice balance is still outstanding.',
    },
    {
      stage: 'first',
      threshold: m ? reminderConfig.minFirst : reminderConfig.dayFirst,
      label: 'First payment reminder',
      message: 'First reminder — invoice balance is outstanding.',
    },
  ]
}

// The recurring reminder — sent repeatedly AFTER the final ladder stage
// until the invoice is paid. It has no threshold of its own; the service
// throttles it to `recurringIntervalUnits()` since the most recent
// reminder. Reuses the `paymentReminders[]` ledger with `stage:
// 'recurring'` (entries accumulate, one per cycle, for the audit trail).
export const recurringStage = {
  stage: 'recurring',
  label: 'Recurring payment reminder',
  message:
    'Invoice balance remains outstanding — recurring reminder until paid.',
}

// Active recurring interval, in the same unit (days/minutes) the ladder
// uses, chosen by useMinutes. Floored at 1 so a misconfigured 0 can't
// turn the throttle off and email on every tick.
export function recurringIntervalUnits() {
  const n = reminderConfig.useMinutes
    ? reminderConfig.repeatMinutes
    : reminderConfig.repeatDays
  return Number.isFinite(n) && n >= 1 ? n : 1
}
