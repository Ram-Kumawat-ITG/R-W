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
import { formatCurrency, formatDate, formatDateTime } from "../../utils/format";

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

// ── Commission Payout Failed ─────────────────────────────────────────────
// Fired from the single choke point every payout-failure path already runs
// through (cdo.service.alertPayoutFailure) — banking validation failures,
// QBO/execution errors, and ACH returns all land here. Practitioner-facing,
// admin CC'd, with the failure reason spelled out so the practitioner knows
// what happened and the admin has enough detail to troubleshoot.
export async function notifyCommissionPayoutFailed({
  email,
  practitionerName,
  amount,
  currency,
  reference,
  reason,
  returnCode,
  failedAt,
}) {
  if (!email) {
    log.warn("send.skipped_no_email", { event: "commission_payout_failed" });
    return { success: false, skipped: true, reason: "no practitioner email" };
  }

  const amountLabel = formatCurrency(amount, currency);
  const failedAtLabel = formatDateTime(failedAt || new Date());

  const subject = `Action Needed: Your Commission Payout of ${amountLabel} Could Not Be Processed`;
  const html = wrapHtml(`
    <p>Hi ${practitionerName || "there"},</p>
    <p>We attempted to process your commission payout, but it did not go through.</p>
    <ul>
      <li><strong>Amount:</strong> ${amountLabel}</li>
      ${reference ? `<li><strong>Reference:</strong> ${reference}</li>` : ""}
      <li><strong>Reason:</strong> ${reason || "An unexpected error occurred"}</li>
      ${returnCode ? `<li><strong>Return code:</strong> ${returnCode}</li>` : ""}
      <li><strong>Date:</strong> ${failedAtLabel}</li>
    </ul>
    <p>Your commission amount has not been lost — it remains reserved and will be automatically
    retried on our next payout run once the issue above is resolved. If this relates to your bank
    account details, please review them in your practitioner profile. If you have any questions,
    please contact us.</p>
  `);

  const result = await sendEmail({ to: email, cc: config.adminEmail, subject, html });

  const context = { event: "commission_payout_failed", email, amount, reference, reason };
  if (!result.success) {
    log.error("send.failed", { ...context, error: result.error });
  } else {
    log.info("send.success", { ...context, messageId: result.messageId });
  }
  return result;
}

// ── Commission Payout Batch Summary ──────────────────────────────────────
// Admin-only, fired once per automated payout batch run (any outcome —
// awaiting-approval, completed, or completed-with-errors) from
// cdo.service.runAutomatedPayouts. `rows` is the per-practitioner breakdown
// the caller already assembled from the batch's payouts.
const STATUS_LABEL = {
  draft: "Draft",
  awaiting_approval: "Awaiting approval",
  approved: "Approved",
  processing: "Processing",
  awaiting_settlement: "Awaiting settlement",
  paid: "Paid",
  failed: "Failed",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function buildBatchSummaryTable(rows) {
  if (!rows || !rows.length) {
    return "<p>No practitioners were included in this batch.</p>";
  }
  const headerCells = [
    "Practitioner Name",
    "Practitioner Email",
    "Total Commission Amount",
    "Number of Orders",
    "Payout Status",
    "Transaction / Reference ID",
    "Processed Date & Time",
  ]
    .map((h) => `<th style="text-align:left;padding:8px;border:1px solid #d5d5d5;background:#f4f4f4">${h}</th>`)
    .join("");

  const bodyRows = rows
    .map((r) => {
      const cells = [
        escapeHtml(r.practitionerName || "—"),
        escapeHtml(r.practitionerEmail || "—"),
        formatCurrency(r.totalAmount, r.currency),
        escapeHtml(r.commissionCount ?? "—"),
        escapeHtml(STATUS_LABEL[r.status] || r.status || "—"),
        escapeHtml(r.txnRef || "—"),
        formatDateTime(r.processedAt),
      ]
        .map((c) => `<td style="padding:8px;border:1px solid #d5d5d5">${c}</td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  return `
    <table style="border-collapse:collapse;width:100%;font-size:13px;margin-top:12px">
      <thead><tr>${headerCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
  `;
}

export async function notifyPayoutBatchSummary({
  reference,
  status,
  startedAt,
  completedAt,
  totalPractitioners,
  totalAmount,
  paidCount,
  failedCount,
  skippedCount,
  rows,
}) {
  if (!config.adminEmail) {
    log.warn("send.skipped_no_email", { event: "commission_payout_batch_summary" });
    return { success: false, skipped: true, reason: "no admin email configured" };
  }

  const subject = `Commission Payout Batch Summary — ${reference || "batch"} (${STATUS_LABEL[status] || status || "—"})`;
  const html = wrapHtml(`
    <p>The commission payout batch <strong>${escapeHtml(reference || "—")}</strong> has finished running.</p>
    <ul>
      <li><strong>Status:</strong> ${STATUS_LABEL[status] || status || "—"}</li>
      <li><strong>Started:</strong> ${formatDateTime(startedAt)}</li>
      <li><strong>Completed:</strong> ${formatDateTime(completedAt)}</li>
      <li><strong>Practitioners:</strong> ${totalPractitioners ?? (rows || []).length}</li>
      <li><strong>Total amount:</strong> ${formatCurrency(totalAmount)}</li>
      ${paidCount != null ? `<li><strong>Paid:</strong> ${paidCount}</li>` : ""}
      ${failedCount != null ? `<li><strong>Failed:</strong> ${failedCount}</li>` : ""}
      ${skippedCount != null ? `<li><strong>Skipped commissions:</strong> ${skippedCount}</li>` : ""}
    </ul>
    ${buildBatchSummaryTable(rows)}
  `);

  const result = await sendEmail({ to: config.adminEmail, subject, html });

  const context = { event: "commission_payout_batch_summary", reference, status, rowCount: (rows || []).length };
  if (!result.success) {
    log.error("send.failed", { ...context, error: result.error });
  } else {
    log.info("send.success", { ...context, messageId: result.messageId });
  }
  return result;
}
