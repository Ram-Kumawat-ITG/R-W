// Durable, background retail QuickBooks invoice-email delivery.
//
// The admin "Send invoice" button on the Order Details page fires QBO's
// `/invoice/<id>/send` (an HTTP round-trip) inline, blocking the request. This
// job moves that send off the request path and makes it durable + retried:
// the admin action returns immediately (queued), the job is persisted so a
// restart doesn't lose it, and a failed send reschedules on a backoff ladder.
//
// The heavy lifting lives in retailOrderInvoice.service.sendRetailInvoiceForOrder
// (resolve invoice + recipient, send, write the retailQbo syncLog); this job
// just re-invokes it with retry. Payload carries only ids (serializable).

import { sendRetailInvoiceForOrder } from "../../retailQbo/retailOrderInvoice.service";
import { createLogger } from "../../../utils/logger.utils";

export const SEND_RETAIL_INVOICE_EMAIL_JOB = "send-retail-invoice-email";
const log = createLogger("job.send_retail_invoice_email");

const RETRY_DELAYS_MIN = [2, 5, 15, 60];
const MAX_ATTEMPTS = RETRY_DELAYS_MIN.length + 1;

// Reasons that mean "nothing to send / won't ever succeed" — don't retry.
const TERMINAL_REASONS = new Set([
  "missing_order_id",
  "not_configured",
  "order_not_found",
  "no_invoice",
  "no_email",
]);

export function registerSendRetailInvoiceEmailJob(agenda) {
  agenda.define(
    SEND_RETAIL_INVOICE_EMAIL_JOB,
    { concurrency: 5, lockLifetime: 5 * 60 * 1000 },
    async (job) => {
      const { shop, shopifyOrderId, attempt = 1 } = job.attrs.data || {};
      const context = { shop, shopifyOrderId, attempt };

      if (!shopifyOrderId) {
        log.error("retail_invoice_email.no_order_id", context);
        return;
      }

      let result;
      try {
        result = await sendRetailInvoiceForOrder({ shop, shopifyOrderId });
      } catch (err) {
        result = { ok: false, reason: "error", error: err?.message || "unknown error" };
      }

      if (result.ok) {
        log.info("retail_invoice_email.sent", { ...context, email: result.email });
        return;
      }

      if (TERMINAL_REASONS.has(result.reason)) {
        log.warn("retail_invoice_email.skipped", { ...context, reason: result.reason });
        return;
      }

      if (attempt < MAX_ATTEMPTS) {
        const delayMin = RETRY_DELAYS_MIN[attempt - 1];
        log.warn("retail_invoice_email.retry_scheduled", {
          ...context,
          reason: result.reason,
          error: result.error,
          retryInMin: delayMin,
        });
        await job.agenda.schedule(`in ${delayMin} minutes`, SEND_RETAIL_INVOICE_EMAIL_JOB, {
          shop,
          shopifyOrderId,
          attempt: attempt + 1,
        });
        return;
      }

      log.error("retail_invoice_email.exhausted", {
        ...context,
        reason: result.reason,
        error: result.error,
        maxAttempts: MAX_ATTEMPTS,
      });
    },
  );
}
