import Agenda from 'agenda'
import { config } from '../config.server'
import { createLogger } from '../logger.server'
import { registerJobs, JOB_NAMES } from './jobs/index.server'

const log = createLogger('scheduler')

let agendaInstance = null
let startPromise = null

function buildAgenda() {
  // For fast dev intervals (e.g. PAYMENT_RETRY_INTERVAL=30 seconds),
  // Agenda's default processEvery of 5s is fine. For minute-or-longer
  // intervals we tune down to reduce DB chatter.
  const processEvery = config.payments.retryIntervalOverride ? '5 seconds' : '1 minute'
  const agenda = new Agenda({
    db: { address: config.mongodbUri, collection: 'agenda_jobs' },
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
  // Dev override: PAYMENT_RETRY_INTERVAL replaces the production cron
  // with a fast interval so the retry job can be exercised locally.
  // Cancel the production ticks first so a switch from cron → interval
  // doesn't leave both registered.
  if (config.payments.retryIntervalOverride) {
    await agenda.cancel({ name: JOB_NAMES.PROCESS_PENDING_PAYMENTS })
    await agenda.every(
      config.payments.retryIntervalOverride,
      JOB_NAMES.PROCESS_PENDING_PAYMENTS,
      { tick: 'dev' },
    )
    log.info('scheduler.recurring_registered', {
      mode: 'dev-interval',
      interval: config.payments.retryIntervalOverride,
    })
    console.log(
      `\n[scheduler] DEV MODE — process-pending-payments running every ${config.payments.retryIntervalOverride}\n`,
    )
    return
  }

  // Production: cron expressions from config (default 15th + last day).
  // `every` is idempotent on (interval, name) so re-running doesn't duplicate.
  const { retryCronPrimary, retryCronSecondary, scheduleTimezone } = config.payments
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
