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

import { enqueueEmail } from "../email/emailQueue.service";
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
  const result = await enqueueEmail({ to: config.adminEmail, subject, html }, { label: context?.event });
  if (!result.success) {
    log.error("send.failed", { ...context, error: result.error });
  } else {
    log.info("send.queued", { ...context });
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
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">
      <tbody>
        <tr><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Field</th><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Value</th></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Order</td><td style="padding:8px;border:1px solid #ddd">${orderName || shopifyOrderId}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Vendor Bill</td><td style="padding:8px;border:1px solid #ddd"><strong>${billDocNumber || billId}</strong></td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Vendor</td><td style="padding:8px;border:1px solid #ddd">${vendorId || '—'}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Total amount</td><td style="padding:8px;border:1px solid #ddd"><strong>${formatCurrency(totalAmount, currency)}</strong></td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Status</td><td style="padding:8px;border:1px solid #ddd">Unpaid — awaiting reconciliation</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Created</td><td style="padding:8px;border:1px solid #ddd">${formatDateTime(createdAt || new Date())}</td></tr>
        ${billUrl ? `<tr><td style="padding:8px;border:1px solid #ddd">QuickBooks link</td><td style="padding:8px;border:1px solid #ddd"><a href="${billUrl}">${billUrl}</a></td></tr>` : ""}
      </tbody>
    </table>
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
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">
      <tbody>
        <tr><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Field</th><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Value</th></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Failure stage</td><td style="padding:8px;border:1px solid #ddd"><strong style="color:#d9534f">${stageLabel}</strong></td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Order</td><td style="padding:8px;border:1px solid #ddd">${orderName || shopifyOrderId}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Shopify order ID</td><td style="padding:8px;border:1px solid #ddd">${shopifyOrderId}</td></tr>
        ${billId || billDocNumber ? `<tr><td style="padding:8px;border:1px solid #ddd">Vendor Bill</td><td style="padding:8px;border:1px solid #ddd">${billDocNumber || billId}</td></tr>` : ""}
        ${vendorId ? `<tr><td style="padding:8px;border:1px solid #ddd">Vendor</td><td style="padding:8px;border:1px solid #ddd">${vendorId}</td></tr>` : ""}
        ${totalAmount != null ? `<tr><td style="padding:8px;border:1px solid #ddd">Amount</td><td style="padding:8px;border:1px solid #ddd">${formatCurrency(totalAmount, currency)}</td></tr>` : ""}
        <tr><td style="padding:8px;border:1px solid #ddd">Error message</td><td style="padding:8px;border:1px solid #ddd">${reason || "An unexpected error occurred"}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Failed at</td><td style="padding:8px;border:1px solid #ddd">${formatDateTime(failedAt || new Date())}</td></tr>
      </tbody>
    </table>
    ${errorDetail ? `<p style="margin-top:16px"><strong>Error detail:</strong></p><pre style="background:#f4f4f4;padding:12px;border-radius:4px;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere">${errorDetail}</pre>` : ""}
    <p style="margin-top:16px">${STAGE_EXPLANATION[stage] || STAGE_EXPLANATION.reconciliation}</p>
  `);

  return send({
    subject,
    html,
    context: { event: "vendor_bill_failed", stage, shopifyOrderId, billId, reason },
  });
}
