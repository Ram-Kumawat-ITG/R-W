// Durable, background email-delivery job.
//
// Every SMTP notification in the app is enqueued as one of these jobs (via
// services/email/emailQueue.service.enqueueEmail) instead of being sent
// inline on the request/order/CRON path. The job owns the actual send, so:
//
//   • the primary operation (registration, order processing, payment, payout)
//     completes without waiting on SMTP — email can never add latency or trip
//     a gateway timeout;
//   • delivery is DURABLE — the job is persisted in Mongo (`agenda_jobs`), so a
//     process restart / deploy mid-flight doesn't lose a queued email;
//   • delivery is RETRIED beyond the transport's own 3 in-process attempts —
//     on a failed send the job reschedules itself on a backoff ladder, so a
//     transient SMTP outage that outlasts the request is still recovered.
//
// The message payload is the exact sendEmail() argument object (already-
// rendered subject/html), so it serializes cleanly into the job document.

import { sendEmail } from '../../email/email.service'
import { createLogger } from '../../../utils/logger.utils'

export const SEND_EMAIL_JOB = 'send-email'
const log = createLogger('job.send_email')

// Cross-restart retry ladder (minutes) applied AFTER sendEmail()'s own 3
// in-process attempts are exhausted. Index i is the wait before attempt i+2.
// Total horizon ≈ 1h 22m across 5 attempts.
const RETRY_DELAYS_MIN = [2, 5, 15, 60]
const MAX_ATTEMPTS = RETRY_DELAYS_MIN.length + 1

export function registerSendEmailJob(agenda) {
  agenda.define(
    SEND_EMAIL_JOB,
    { concurrency: 5, lockLifetime: 2 * 60 * 1000 },
    async (job) => {
      const { message, attempt = 1, label } = job.attrs.data || {}
      const context = { label, to: message?.to, subject: message?.subject, attempt }

      if (!message) {
        log.error('send.no_message', context)
        return
      }

      // sendEmail never throws — it returns a standardized result and retries
      // transient SMTP errors up to 3x internally.
      const result = await sendEmail(message)

      if (result.success) {
        log.info('send.delivered', { ...context, messageId: result.messageId })
        return
      }

      // Delivery failed after the transport's own retries. Reschedule on the
      // backoff ladder for durable, cross-restart recovery until exhausted.
      if (attempt < MAX_ATTEMPTS) {
        const delayMin = RETRY_DELAYS_MIN[attempt - 1]
        log.warn('send.retry_scheduled', { ...context, error: result.error, retryInMin: delayMin })
        await job.agenda.schedule(`in ${delayMin} minutes`, SEND_EMAIL_JOB, {
          message,
          label,
          attempt: attempt + 1,
        })
        return
      }

      // Give up — log loudly so the failure is visible. The primary business
      // operation already completed successfully regardless.
      log.error('send.exhausted', { ...context, error: result.error, maxAttempts: MAX_ATTEMPTS })
    },
  )
}
