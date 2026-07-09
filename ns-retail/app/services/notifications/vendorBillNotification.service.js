// Admin-only emails for the Drop-ship Vendor Bill (A/P) lifecycle:
//   - Created (retailVendorBill.service.ensureRetailVendorBillForOrder, success)
//   - Creation OR Reconciliation Failed — one shared template/event, fired from
//     ensureRetailVendorBillForOrder's catch block (creation) AND
//     reconcileRetailVendorBillForOrder's catch block (reconciliation); the
//     `stage` field is the only thing that differs between the two call sites.
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

// ── 2. Drop-ship Vendor Bill (A/P) Creation or Reconciliation Failed ─────
const STAGE_LABEL = {
  creation: "Creation",
  reconciliation: "Reconciliation",
};

const STAGE_EXPLANATION = {
  creation:
    "The QBO Vendor Bill for this drop-ship order could not be created. The order's wholesale " +
    "cost has NOT been recorded as a payable yet — this will be retried automatically on the " +
    "next order sync / reconciliation CRON tick.",
  reconciliation:
    "This vendor bill remains UNPAID in QuickBooks and will be retried automatically on the next " +
    "reconciliation CRON tick. If the error persists, it may need manual review (e.g. the bill " +
    "was voided/edited directly in QuickBooks, or the linked wholesale invoice mapping is broken).",
};

// `stage` is "creation" | "reconciliation" — the only thing that differs
// between the two failure call sites; everything else (subject shape,
// order/bill details, error, troubleshooting note) is one shared template.
export async function notifyVendorBillFailed({
  stage,
  shopifyOrderId,
  orderName,
  billId,
  billDocNumber,
  vendorId,
  totalAmount,
  currency,
  reason,
  errorDetail,
  failedAt,
}) {
  const stageLabel = STAGE_LABEL[stage] || "Creation or Reconciliation";
  const subject = `Action Needed: Drop-ship Vendor Bill (A/P) ${stageLabel} Failed — ${orderName || shopifyOrderId}`;
  const html = wrapHtml(`
    <p>A drop-ship vendor bill (A/P) ${stageLabel.toLowerCase()} step failed and needs attention.</p>
    <ul>
      <li><strong>Failure stage:</strong> ${stageLabel}</li>
      <li><strong>Order:</strong> ${orderName || shopifyOrderId}</li>
      <li><strong>Shopify order id:</strong> ${shopifyOrderId}</li>
      ${billId || billDocNumber ? `<li><strong>Vendor Bill:</strong> ${billDocNumber || billId}</li>` : ""}
      ${vendorId ? `<li><strong>Vendor:</strong> ${vendorId}</li>` : ""}
      ${totalAmount != null ? `<li><strong>Amount:</strong> ${formatCurrency(totalAmount, currency)}</li>` : ""}
      <li><strong>Error message:</strong> ${reason || "An unexpected error occurred"}</li>
      ${errorDetail ? `<li><strong>Error detail:</strong> <pre style="white-space:pre-wrap;margin:4px 0 0;font-family:monospace;font-size:12px">${errorDetail}</pre></li>` : ""}
      <li><strong>Failed at:</strong> ${formatDateTime(failedAt || new Date())}</li>
    </ul>
    <p>${STAGE_EXPLANATION[stage] || STAGE_EXPLANATION.reconciliation}</p>
  `);

  return send({
    subject,
    html,
    context: { event: "vendor_bill_failed", stage, shopifyOrderId, billId, reason },
  });
}
