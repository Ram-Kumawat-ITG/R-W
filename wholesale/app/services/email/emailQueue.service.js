// Async email dispatch — the front door every notification uses instead of
// calling sendEmail() inline.
//
// enqueueEmail() persists a `send-email` Agenda job (see
// services/scheduler/jobs/sendEmail.job.js) and returns immediately, so the
// primary business operation never waits on SMTP. Delivery + retry happen in
// the background job, durably (survives a process restart).
//
// Kept in its own module (not email.service.js) to avoid an import cycle:
// emailQueue → scheduler → jobs → sendEmail.job → email.service (sendEmail).
// email.service itself imports nothing from here.

import { scheduleNow, JOB_NAMES } from '../scheduler/scheduler.service'
import { sendEmail } from './email.service'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('email.queue')

// enqueueEmail — hand a fully-composed sendEmail() message off to the durable
// background queue. `message` is the exact { to, cc, bcc, subject, html, text,
// attachments, replyTo, from } object sendEmail() accepts. `label` is an
// optional short tag for logging (e.g. 'application_approved').
//
// Returns { success: true, queued: true } once the job is persisted. Never
// throws — if the queue itself is unreachable we fall back to a best-effort
// fire-and-forget inline send so the email isn't silently dropped.
export async function enqueueEmail(message, { label } = {}) {
  if (!message?.to) {
    log.warn('enqueue.no_recipient', { label })
    return { success: false, skipped: true, reason: 'no recipient' }
  }

  try {
    await scheduleNow(JOB_NAMES.SEND_EMAIL, { message, label, attempt: 1 })
    log.info('enqueue.queued', { label, to: message.to, subject: message.subject })
    return { success: true, queued: true }
  } catch (err) {
    // Queue/Mongo unavailable — don't lose the email, but still don't block
    // the caller: fire the send inline without awaiting it.
    log.error('enqueue.failed_fallback_inline', { label, err })
    sendEmail(message).catch((e) => log.error('enqueue.inline_fallback_failed', { label, err: e }))
    return { success: false, queued: false, fellBackInline: true }
  }
}

// enqueueInvoiceEmail — hand a QuickBooks `/invoice/<id>/send` off to the
// durable send-invoice-email job so the caller (e.g. the admin "Send invoice"
// button) doesn't block on the QBO round-trip. The job reloads the live
// invoice, sends, and writes the emailEvents[] audit ledger itself. Never
// throws.
export async function enqueueInvoiceEmail({ shop, invoiceId, sendTo, triggerType, triggeredBy, source, remark }) {
  if (!invoiceId) return { success: false, skipped: true, reason: 'no invoiceId' }
  try {
    await scheduleNow(JOB_NAMES.SEND_INVOICE_EMAIL, {
      shop,
      invoiceId: String(invoiceId),
      sendTo,
      triggerType,
      triggeredBy,
      source,
      remark,
      attempt: 1,
    })
    log.info('enqueue.invoice_queued', { invoiceId: String(invoiceId), sendTo })
    return { success: true, queued: true }
  } catch (err) {
    log.error('enqueue.invoice_failed', { invoiceId: String(invoiceId), err })
    return { success: false, queued: false, error: err.message }
  }
}
