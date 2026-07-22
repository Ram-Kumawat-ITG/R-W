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
// (Ported from the wholesale workspace's emailQueue.service for consistency.)

import { scheduleNow, JOB_NAMES } from "../scheduler/scheduler.service";
import { sendEmail } from "./email.service";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("email.queue");

// enqueueEmail — hand a fully-composed sendEmail() message off to the durable
// background queue. `message` is the exact { to, cc, bcc, subject, html, text,
// attachments, replyTo, from } object sendEmail() accepts. `label` is an
// optional short tag for logging. Returns { success: true, queued: true } once
// the job is persisted. Never throws — if the queue is unreachable we fall
// back to a best-effort fire-and-forget inline send so nothing is dropped.
export async function enqueueEmail(message, { label } = {}) {
  if (!message?.to) {
    log.warn("enqueue.no_recipient", { label });
    return { success: false, skipped: true, reason: "no recipient" };
  }

  try {
    await scheduleNow(JOB_NAMES.SEND_EMAIL, { message, label, attempt: 1 });
    log.info("enqueue.queued", { label, to: message.to, subject: message.subject });
    return { success: true, queued: true };
  } catch (err) {
    log.error("enqueue.failed_fallback_inline", { label, err });
    sendEmail(message).catch((e) => log.error("enqueue.inline_fallback_failed", { label, err: e }));
    return { success: false, queued: false, fellBackInline: true };
  }
}

// enqueueRetailInvoiceEmail — hand the admin "Send invoice" QBO round-trip off
// to the durable send-retail-invoice-email job so the request returns without
// waiting on QBO. The job re-invokes sendRetailInvoiceForOrder with retry.
export async function enqueueRetailInvoiceEmail({ shop, shopifyOrderId }) {
  if (!shopifyOrderId) return { success: false, skipped: true, reason: "no order id" };
  try {
    await scheduleNow(JOB_NAMES.SEND_RETAIL_INVOICE_EMAIL, { shop, shopifyOrderId, attempt: 1 });
    log.info("enqueue.retail_invoice_queued", { shop, shopifyOrderId });
    return { success: true, queued: true };
  } catch (err) {
    log.error("enqueue.retail_invoice_failed", { shop, shopifyOrderId, err });
    return { success: false, queued: false, error: err.message };
  }
}
