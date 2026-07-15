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
    <p>Your commission payout has been processed. <strong>No action is needed.</strong></p>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">
      <tbody>
        <tr><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Field</th><th style="text-align:left;padding:8px;border:1px solid #ddd">Value</th></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Amount</td><td style="padding:8px;border:1px solid #ddd">${amountLabel}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Method</td><td style="padding:8px;border:1px solid #ddd">${methodLabel}</td></tr>
        ${reference ? `<tr><td style="padding:8px;border:1px solid #ddd">Reference</td><td style="padding:8px;border:1px solid #ddd">${reference}</td></tr>` : ""}
        <tr><td style="padding:8px;border:1px solid #ddd">Processed at</td><td style="padding:8px;border:1px solid #ddd">${paidAtLabel}</td></tr>
      </tbody>
    </table>
    <p style="margin-top:16px">If you have any questions about this payout, please contact us.</p>
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
    <p>We attempted to process your commission payout but it failed. Please review the details below. <strong>No funds were released.</strong></p>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">
      <tbody>
        <tr><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Field</th><th style="text-align:left;padding:8px;border:1px solid #ddd">Value</th></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Amount</td><td style="padding:8px;border:1px solid #ddd">${amountLabel}</td></tr>
        ${reference ? `<tr><td style="padding:8px;border:1px solid #ddd">Reference</td><td style="padding:8px;border:1px solid #ddd">${reference}</td></tr>` : ""}
        <tr><td style="padding:8px;border:1px solid #ddd">Reason</td><td style="padding:8px;border:1px solid #ddd">${reason || "An unexpected error occurred"}</td></tr>
        ${returnCode ? `<tr><td style="padding:8px;border:1px solid #ddd">Return code</td><td style="padding:8px;border:1px solid #ddd">${returnCode}</td></tr>` : ""}
        <tr><td style="padding:8px;border:1px solid #ddd">Date</td><td style="padding:8px;border:1px solid #ddd">${failedAtLabel}</td></tr>
      </tbody>
    </table>
    <p style="margin-top:12px">We'll retry automatically on our next payout run. If this relates to your bank account details, please review them in your practitioner profile or contact us.</p>
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
    <p><strong>Commission Payout Batch Summary</strong></p>
    <p>The commission payout batch <strong>${escapeHtml(reference || "—")}</strong> has finished running. Review the summary and per-practitioner details below.</p>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px">
      <tbody>
        <tr><th style="text-align:left;padding:8px;border:1px solid #d5d5d5;background:#f4f4f4">Status</th><td style="padding:8px;border:1px solid #d5d5d5">${STATUS_LABEL[status] || status || "—"}</td></tr>
        <tr><th style="text-align:left;padding:8px;border:1px solid #d5d5d5;background:#f4f4f4">Started</th><td style="padding:8px;border:1px solid #d5d5d5">${formatDateTime(startedAt)}</td></tr>
        <tr><th style="text-align:left;padding:8px;border:1px solid #d5d5d5;background:#f4f4f4">Completed</th><td style="padding:8px;border:1px solid #d5d5d5">${formatDateTime(completedAt)}</td></tr>
        <tr><th style="text-align:left;padding:8px;border:1px solid #d5d5d5;background:#f4f4f4">Practitioners</th><td style="padding:8px;border:1px solid #d5d5d5">${totalPractitioners ?? (rows || []).length}</td></tr>
        <tr><th style="text-align:left;padding:8px;border:1px solid #d5d5d5;background:#f4f4f4">Total amount</th><td style="padding:8px;border:1px solid #d5d5d5">${formatCurrency(totalAmount)}</td></tr>
        ${paidCount != null ? `<tr><th style="text-align:left;padding:8px;border:1px solid #d5d5d5;background:#f4f4f4">Paid</th><td style="padding:8px;border:1px solid #d5d5d5">${paidCount}</td></tr>` : ""}
        ${failedCount != null ? `<tr><th style="text-align:left;padding:8px;border:1px solid #d5d5d5;background:#f4f4f4">Failed</th><td style="padding:8px;border:1px solid #d5d5d5">${failedCount}</td></tr>` : ""}
        ${skippedCount != null ? `<tr><th style="text-align:left;padding:8px;border:1px solid #d5d5d5;background:#f4f4f4">Skipped</th><td style="padding:8px;border:1px solid #d5d5d5">${skippedCount}</td></tr>` : ""}
      </tbody>
    </table>
    <p style="margin-top:16px"><strong>Practitioners</strong></p>
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
