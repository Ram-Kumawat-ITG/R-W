// Agenda lifecycle + recurring job registration.
//
// One singleton per process. Concurrent first calls all await the same
// startPromise so we never have two Agenda instances on the same Mongo
// collection.

import Agenda from 'agenda'
import { schedulerConfig } from './scheduler.config'
import { achSyncConfig } from '../payment/achStatusSync.config'
import { createLogger } from '../../utils/logger.utils'
import { registerJobs, JOB_NAMES } from './jobs'

const log = createLogger('scheduler.service')

const MONGODB_URI = process.env.MONGODB_URI

let agendaInstance = null
let startPromise = null

function buildAgenda() {
  // For fast dev intervals (e.g. PAYMENT_RETRY_INTERVAL=30 seconds),
  // Agenda's default processEvery of 5s is fine. For minute-or-longer
  // intervals we tune down to reduce DB chatter.
  const processEvery = schedulerConfig.retryIntervalOverride ? '5 seconds' : '1 minute'
  const agenda = new Agenda({
    db: { address: MONGODB_URI, collection: 'agenda_jobs' },
    processEvery,
    maxConcurrency: 5,
    defaultConcurrency: 2,
    defaultLockLifetime: 10 * 60 * 1000,
  })

  agenda.on('error', (err) => {
    console.error('[scheduler] error:', err.stack || err)
    log.error('agenda.error', { err })
  })
  agenda.on('start', (job) => log.info('job.start', { name: job.attrs.name }))
  agenda.on('success', (job) => log.info('job.success', { name: job.attrs.name }))
  agenda.on('fail', (err, job) => {
    console.error(`[scheduler] job ${job.attrs.name} failed:`, err.stack || err)
    log.error('job.fail', { name: job.attrs.name, err })
  })

  registerJobs(agenda)
  return agenda
}

async function ensureRecurring(agenda) {
  // ── Daily Check-payment reminder job ─────────────────────────────
  // Registered independently of the payment-retry ticks so it always
  // runs once a day (dev + prod). REMINDER_INTERVAL gives a fast dev
  // cadence; otherwise the cron from config (default 02:00).
  if (schedulerConfig.reminderIntervalOverride) {
    await agenda.cancel({ name: JOB_NAMES.PROCESS_CHECK_REMINDERS })
    await agenda.every(
      schedulerConfig.reminderIntervalOverride,
      JOB_NAMES.PROCESS_CHECK_REMINDERS,
      { tick: 'dev' },
    )
    console.log(
      `\n[scheduler] DEV MODE — process-check-reminders running every ${schedulerConfig.reminderIntervalOverride}\n`,
    )
  } else {
    await agenda.every(
      schedulerConfig.reminderCron,
      JOB_NAMES.PROCESS_CHECK_REMINDERS,
      { tick: 'daily' },
      { timezone: schedulerConfig.scheduleTimezone },
    )
  }
  log.info('scheduler.reminder_registered', {
    mode: schedulerConfig.reminderIntervalOverride ? 'dev-interval' : 'cron',
    schedule: schedulerConfig.reminderIntervalOverride || schedulerConfig.reminderCron,
  })

  // ── ACH status-synchronization job ───────────────────────────────
  // Independent of the payment-retry ticks: ACH settles 1–3 business
  // days after submission, so settlement status must be polled on its
  // own (frequent) cadence rather than only on the monthly charge
  // ticks. Registered here (before the retry dev-override early-return
  // below) so it runs in dev mode too. ACH_SYNC_INTERVAL gives a fast
  // testing cadence (every minute); otherwise the cron from config
  // (production default: once per day at 03:00).
  if (achSyncConfig.intervalOverride) {
    await agenda.cancel({ name: JOB_NAMES.PROCESS_ACH_STATUS_SYNC })
    await agenda.every(
      achSyncConfig.intervalOverride,
      JOB_NAMES.PROCESS_ACH_STATUS_SYNC,
      { tick: 'dev' },
    )
    console.log(
      `\n[scheduler] DEV MODE — process-ach-status-sync running every ${achSyncConfig.intervalOverride}\n`,
    )
  } else {
    await agenda.every(
      achSyncConfig.cron,
      JOB_NAMES.PROCESS_ACH_STATUS_SYNC,
      { tick: 'scheduled' },
      { timezone: achSyncConfig.timezone },
    )
  }
  log.info('scheduler.ach_sync_registered', {
    mode: achSyncConfig.intervalOverride ? 'dev-interval' : 'cron',
    schedule: achSyncConfig.intervalOverride || achSyncConfig.cron,
  })

  // ── Drop-ship payment job (CRON DISABLED — replaced by batch payment UI) ──
  // The process-dropship-payments CRON has been superseded by the manual
  // Admin Order Batch Payment flow (/app/admin-orders/batch). The admin
  // reviews all unpaid drop-ship invoices, enters a single payment reference
  // (cheque / bank transfer), and marks the entire batch paid in one step.
  // Cancel any previously-scheduled runs that may still be in the Agenda
  // agenda_jobs collection from before this change.
  await agenda.cancel({ name: JOB_NAMES.PROCESS_DROPSHIP_PAYMENTS })
  log.info('scheduler.dropship_payment_cancelled', {
    reason: 'replaced by admin-order batch payment UI',
  })

  // Dev override: PAYMENT_RETRY_INTERVAL replaces the production cron
  // with a fast interval so the retry job can be exercised locally.
  // Cancel the production ticks first so a switch from cron → interval
  // doesn't leave both registered.
  if (schedulerConfig.retryIntervalOverride) {
    await agenda.cancel({ name: JOB_NAMES.PROCESS_PENDING_PAYMENTS })
    await agenda.every(
      schedulerConfig.retryIntervalOverride,
      JOB_NAMES.PROCESS_PENDING_PAYMENTS,
      { tick: 'dev' },
    )
    log.info('scheduler.recurring_registered', {
      mode: 'dev-interval',
      interval: schedulerConfig.retryIntervalOverride,
    })
    console.log(
      `\n[scheduler] DEV MODE — process-pending-payments running every ${schedulerConfig.retryIntervalOverride}\n`,
    )
    return
  }

  // Production: cron expressions from config (default 15th + last day).
  // `every` is idempotent on (interval, name) so re-running doesn't duplicate.
  const { retryCronPrimary, retryCronSecondary, scheduleTimezone } = schedulerConfig
  await agenda.every(retryCronPrimary, JOB_NAMES.PROCESS_PENDING_PAYMENTS, { tick: 'primary' }, {
    timezone: scheduleTimezone,
  })
  await agenda.every(retryCronSecondary, JOB_NAMES.PROCESS_PENDING_PAYMENTS, { tick: 'secondary' }, {
    timezone: scheduleTimezone,
  })
  log.info('scheduler.recurring_registered', {
    mode: 'cron',
    timezone: scheduleTimezone,
    primary: retryCronPrimary,
    secondary: retryCronSecondary,
  })
}

export async function getAgenda() {
  if (agendaInstance) return agendaInstance
  if (!startPromise) {
    startPromise = (async () => {
      const agenda = buildAgenda()
      await agenda.start()
      await ensureRecurring(agenda)
      agendaInstance = agenda
      log.info('scheduler.started')
      return agenda
    })().catch((err) => {
      startPromise = null
      log.error('scheduler.start_failed', { err })
      throw err
    })
  }
  return startPromise
}

// Convenience for one-off enqueues (e.g. webhook → process this order now).
export async function scheduleNow(jobName, data) {
  const agenda = await getAgenda()
  return agenda.now(jobName, data)
}

export { JOB_NAMES }

export async function shutdownAgenda() {
  if (agendaInstance) {
    await agendaInstance.stop()
    agendaInstance = null
    startPromise = null
  }
}
