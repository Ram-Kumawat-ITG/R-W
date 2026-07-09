// Practitioner-facing (+ admin CC'd) email for the Commission Payout
// Processed event — fired once a CDO payout reaches its terminal `paid`
// state, either via ACH settlement (cdo.service.finalizeSettledPayout) or a
// manually-issued check (cdo.service.markCheckPayoutPaid). Same shared SMTP
// utility (services/email/email.service.sendEmail) and best-effort-never-
// throws convention as the wholesale workspace's notification modules — a
// notification failure must never surface as a payout-processing failure
// (the settlement/check-issue already succeeded by the time this is called).

import { sendEmail } from "../email/email.service";
import { payoutNotificationConfig as config } from "./payoutNotification.config";
import { createLogger } from "../../utils/logger.utils";
import { formatCurrency, formatDate } from "../../utils/format";

const log = createLogger("payoutNotification");

function wrapHtml(bodyHtml) {
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.5">
      ${bodyHtml}
      <p style="margin-top:24px;color:#6b6b6b;font-size:12px">Natural Solutions</p>
    </div>
  `;
}

const METHOD_LABEL = {
  ach: "Direct deposit (ACH)",
  bank: "Bank transfer",
  paypal: "PayPal",
  check: "Check",
  manual: "Manual",
};

export async function notifyCommissionPayoutProcessed({
  email,
  practitionerName,
  amount,
  currency,
  method,
  reference,
  paidAt,
}) {
  if (!email) {
    log.warn("send.skipped_no_email", { event: "commission_payout_processed" });
    return { success: false, skipped: true, reason: "no practitioner email" };
  }

  const amountLabel = formatCurrency(amount, currency);
  const methodLabel = METHOD_LABEL[method] || method || "—";
  const paidAtLabel = paidAt ? formatDate(paidAt) : formatDate(new Date());

  const subject = `Your Commission Payout of ${amountLabel} Has Been Processed`;
  const html = wrapHtml(`
    <p>Hi ${practitionerName || "there"},</p>
    <p>Your commission payout has been processed:</p>
    <ul>
      <li><strong>Amount:</strong> ${amountLabel}</li>
      <li><strong>Method:</strong> ${methodLabel}</li>
      ${reference ? `<li><strong>Reference:</strong> ${reference}</li>` : ""}
      <li><strong>Date:</strong> ${paidAtLabel}</li>
    </ul>
    <p>No further action is needed on your part. If you have any questions about this payout, please contact us.</p>
  `);

  const result = await sendEmail({ to: email, cc: config.adminEmail, subject, html });

  const context = { event: "commission_payout_processed", email, amount, method, reference };
  if (!result.success) {
    log.error("send.failed", { ...context, error: result.error });
  } else {
    log.info("send.success", { ...context, messageId: result.messageId });
  }
  return result;
}
