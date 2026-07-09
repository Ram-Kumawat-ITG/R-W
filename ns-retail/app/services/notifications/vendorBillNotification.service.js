// Admin-only emails for the Drop-ship Vendor Bill (A/P) lifecycle — creation
// (retailVendorBill.service.ensureRetailVendorBillForOrder) and reconciliation
// failure (retailBillReconcile.service.reconcileRetailVendorBillForOrder).
// Same shared SMTP utility (services/email/email.service.sendEmail) and
// best-effort-never-throws convention as the other notification modules in
// this workspace — a notification failure must never surface as a vendor-bill
// processing failure.

import { sendEmail } from "../email/email.service";
import { payoutNotificationConfig as config } from "./payoutNotification.config";
import { createLogger } from "../../utils/logger.utils";
import { formatCurrency, formatDateTime } from "../../utils/format";

const log = createLogger("vendorBillNotification");

function wrapHtml(bodyHtml) {
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.5">
      ${bodyHtml}
      <p style="margin-top:24px;color:#6b6b6b;font-size:12px">Natural Solutions</p>
    </div>
  `;
}

async function send({ subject, html, context }) {
  if (!config.adminEmail) {
    log.warn("send.skipped_no_email", context);
    return { success: false, skipped: true, reason: "no admin email configured" };
  }
  const result = await sendEmail({ to: config.adminEmail, subject, html });
  if (!result.success) {
    log.error("send.failed", { ...context, error: result.error });
  } else {
    log.info("send.success", { ...context, messageId: result.messageId });
  }
  return result;
}

// ── 1. Drop-ship Vendor Bill Created ─────────────────────────────────────
export async function notifyVendorBillCreated({
  shopifyOrderId,
  orderName,
  billId,
  billDocNumber,
  vendorId,
  totalAmount,
  currency,
  billUrl,
  createdAt,
}) {
  const subject = `Drop-ship Vendor Bill Created — ${orderName || shopifyOrderId} (${formatCurrency(totalAmount, currency)})`;
  const html = wrapHtml(`
    <p>A new drop-ship vendor bill (A/P) has been created in QuickBooks Online.</p>
    <ul>
      <li><strong>Order:</strong> ${orderName || shopifyOrderId}</li>
      <li><strong>Vendor Bill:</strong> ${billDocNumber || billId}</li>
      <li><strong>Vendor:</strong> ${vendorId}</li>
      <li><strong>Total amount:</strong> ${formatCurrency(totalAmount, currency)}</li>
      <li><strong>Status:</strong> Unpaid — awaiting reconciliation with the wholesale invoice payment</li>
      <li><strong>Created:</strong> ${formatDateTime(createdAt || new Date())}</li>
      ${billUrl ? `<li><strong>QuickBooks link:</strong> <a href="${billUrl}">${billUrl}</a></li>` : ""}
    </ul>
  `);

  return send({
    subject,
    html,
    context: { event: "vendor_bill_created", shopifyOrderId, billId, totalAmount },
  });
}

// ── 2. Drop-ship Vendor Bill Reconciliation Failed ───────────────────────
export async function notifyVendorBillReconciliationFailed({
  shopifyOrderId,
  orderName,
  billId,
  billDocNumber,
  reason,
  failedAt,
}) {
  const subject = `Action Needed: Drop-ship Vendor Bill Reconciliation Failed — ${orderName || shopifyOrderId}`;
  const html = wrapHtml(`
    <p>Reconciling a drop-ship vendor bill against its wholesale invoice payment failed.</p>
    <ul>
      <li><strong>Order:</strong> ${orderName || shopifyOrderId}</li>
      <li><strong>Vendor Bill:</strong> ${billDocNumber || billId}</li>
      <li><strong>Reason:</strong> ${reason || "An unexpected error occurred"}</li>
      <li><strong>Failed at:</strong> ${formatDateTime(failedAt || new Date())}</li>
    </ul>
    <p>This bill remains unpaid in QuickBooks and will be retried automatically on the next
    reconciliation CRON tick. If the error persists, it may need manual review (e.g. the bill
    was voided/edited directly in QuickBooks, or the linked wholesale invoice mapping is broken).</p>
  `);

  return send({
    subject,
    html,
    context: { event: "vendor_bill_reconcile_failed", shopifyOrderId, billId, reason },
  });
}
