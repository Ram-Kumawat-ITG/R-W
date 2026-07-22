// Durable, background email-delivery job.
//
// Every SMTP notification in ns-retail is enqueued as one of these jobs (via
// services/email/emailQueue.service.enqueueEmail) instead of being sent inline
// on the request/CRON path. The job owns the actual send, so:
//
//   • the primary operation (payout, vendor bill, invoice) completes without
//     waiting on SMTP — email can never add latency or trip a timeout;
//   • delivery is DURABLE — the job is persisted in Mongo (`cdo_agenda_jobs`),
//     so a process restart / deploy mid-flight doesn't lose a queued email;
//   • delivery is RETRIED beyond the transport's own 3 in-process attempts —
//     on a failed send the job reschedules itself on a backoff ladder.
//
// (Ported from the wholesale workspace's sendEmail.job for consistency.)

import { sendEmail } from "../../email/email.service";
import { createLogger } from "../../../utils/logger.utils";

export const SEND_EMAIL_JOB = "send-email";
const log = createLogger("job.send_email");

// Cross-restart retry ladder (minutes) applied AFTER sendEmail()'s own 3
// in-process attempts. Index i is the wait before attempt i+2.
const RETRY_DELAYS_MIN = [2, 5, 15, 60];
const MAX_ATTEMPTS = RETRY_DELAYS_MIN.length + 1;

export function registerSendEmailJob(agenda) {
  agenda.define(
    SEND_EMAIL_JOB,
    { concurrency: 5, lockLifetime: 2 * 60 * 1000 },
    async (job) => {
      const { message, attempt = 1, label } = job.attrs.data || {};
      const context = { label, to: message?.to, subject: message?.subject, attempt };

      if (!message) {
        log.error("send.no_message", context);
        return;
      }

      const result = await sendEmail(message);

      if (result.success) {
        log.info("send.delivered", { ...context, messageId: result.messageId });
        return;
      }

      if (attempt < MAX_ATTEMPTS) {
        const delayMin = RETRY_DELAYS_MIN[attempt - 1];
        log.warn("send.retry_scheduled", { ...context, error: result.error, retryInMin: delayMin });
        await job.agenda.schedule(`in ${delayMin} minutes`, SEND_EMAIL_JOB, {
          message,
          label,
          attempt: attempt + 1,
        });
        return;
      }

      log.error("send.exhausted", { ...context, error: result.error, maxAttempts: MAX_ATTEMPTS });
    },
  );
}
