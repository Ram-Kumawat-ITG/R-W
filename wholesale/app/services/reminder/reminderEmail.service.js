// Dynamic SMTP email builder for the check-payment reminder ladder.
//
// Replaces the previous QuickBooks-rendered reminder (QBO can't produce a
// fully dynamic body). The body is generated per STAGE (first / second /
// card / recurring) so the tone + call-to-action escalate, while a shared
// details block carries the order + invoice facts. Pure — no I/O — so it's
// easy to preview/test; the reminder service handles sending via SMTP.

import { formatAmount } from '../../utils/format.utils'

// Per-stage copy. The stage key comes straight from reminder.config
// (reminderStages()[].stage + recurringStage.stage), so the body is chosen
// dynamically by event.
const STAGE_COPY = {
  first: {
    subjectPrefix: 'Payment Reminder',
    heading: 'Payment Reminder',
    intro:
      'This is a friendly reminder that the invoice below is currently outstanding. ' +
      "We'd appreciate your payment at your earliest convenience.",
    action: 'Please arrange payment for the outstanding amount shown below.',
    tone: '#2d6a4f',
  },
  second: {
    subjectPrefix: 'Second Payment Reminder',
    heading: 'Second Payment Reminder',
    intro:
      "We're following up on the invoice below, which remains unpaid. " +
      'Please arrange payment as soon as possible to keep your account in good standing.',
    action: 'Please submit your payment as soon as possible to avoid further action.',
    tone: '#8a5300',
  },
  card: {
    subjectPrefix: 'Final Notice',
    heading: 'Final Notice — Payment Required',
    intro:
      'This is a final notice regarding the outstanding invoice below. ' +
      'If payment is not received, the balance may be charged to the card on file.',
    action:
      'Please pay the outstanding balance now. If unpaid, the amount may be charged to the card on file.',
    tone: '#9a2b4c',
  },
  recurring: {
    subjectPrefix: 'Payment Reminder',
    heading: 'Outstanding Invoice Reminder',
    intro:
      'The invoice below remains unpaid. This is a recurring reminder and will continue ' +
      'until the outstanding balance is settled.',
    action: 'Please arrange payment to settle the balance and stop further reminders.',
    tone: '#8a5300',
  },
}

function formatDate(value) {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

const PAYMENT_STATUS_LABEL = {
  pending: 'Unpaid',
  partially_paid: 'Partially paid',
  failed: 'Payment failed',
  paid: 'Paid',
}

const TD = 'padding:8px 12px;border:1px solid #ddd'
function detailRow(label, value) {
  return `<tr><td style="${TD};font-weight:600;background:#fafafa;white-space:nowrap">${label}</td><td style="${TD}">${value ?? '—'}</td></tr>`
}

// products: [{ title, quantity, price }] (optional)
export function buildReminderEmail({
  stage,
  practitionerName,
  orderNumber,
  invoiceNumber,
  invoiceDate,
  outstandingAmount,
  currency,
  paymentStatus,
  dueDate,
  products = [],
  supportEmail,
}) {
  const copy = STAGE_COPY[stage] || STAGE_COPY.first
  const greeting = practitionerName ? `Hi ${practitionerName},` : 'Hello,'
  const amountLine =
    outstandingAmount !== undefined && outstandingAmount !== null
      ? formatAmount(outstandingAmount, currency)
      : null
  const statusLabel = PAYMENT_STATUS_LABEL[paymentStatus] || paymentStatus || '—'
  const invDate = formatDate(invoiceDate)
  const due = formatDate(dueDate)
  const contactLine = supportEmail
    ? `If you have already made this payment, please disregard this notice. For any questions or assistance, contact our support team at ${supportEmail}.`
    : 'If you have already made this payment, please disregard this notice. For any questions or assistance, please contact our support team.'

  const subject = invoiceNumber
    ? `${copy.subjectPrefix} — Invoice ${invoiceNumber}${amountLine ? ` (${amountLine} due)` : ''}`
    : `${copy.subjectPrefix} — Outstanding Invoice`

  // ── Plain text ────────────────────────────────────────────────────────
  const productLinesText = products.length
    ? '\nProducts:\n' +
      products
        .map((p) => `  - ${p.quantity != null ? `${p.quantity} × ` : ''}${p.title}${p.price != null ? ` (${formatAmount(p.price, currency)})` : ''}`)
        .join('\n') +
      '\n'
    : ''

  const text =
    `${greeting}\n\n` +
    `${copy.intro}\n\n` +
    `Invoice details:\n` +
    `- Practitioner: ${practitionerName || '—'}\n` +
    `- Order Number: ${orderNumber || '—'}\n` +
    `- Invoice Number: ${invoiceNumber || '—'}\n` +
    `- Invoice Date: ${invDate || '—'}\n` +
    `- Payment Status: ${statusLabel}\n` +
    (due ? `- Due Date: ${due}\n` : '') +
    `- Outstanding Amount: ${amountLine || '—'}\n` +
    productLinesText +
    `\n${copy.action}\n\n` +
    `${contactLine}\n\n` +
    `Thank you,\nNatural Solutions`

  // ── HTML ──────────────────────────────────────────────────────────────
  const productTable = products.length
    ? `<p style="margin:18px 0 4px;font-weight:600">Products</p>` +
      `<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px"><tbody>` +
      `<tr><th style="${TD};text-align:left;background:#f4f4f4">Item</th>` +
      `<th style="${TD};text-align:center;background:#f4f4f4;white-space:nowrap">Qty</th>` +
      `<th style="${TD};text-align:right;background:#f4f4f4;white-space:nowrap">Price</th></tr>` +
      products
        .map(
          (p) =>
            `<tr><td style="${TD}">${p.title || '—'}</td>` +
            `<td style="${TD};text-align:center">${p.quantity != null ? p.quantity : '—'}</td>` +
            `<td style="${TD};text-align:right">${p.price != null ? formatAmount(p.price, currency) : '—'}</td></tr>`,
        )
        .join('') +
      `</tbody></table>`
    : ''

  const html =
    `<div style="max-width:640px;margin:0 auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a">` +
    `<div style="border-left:4px solid ${copy.tone};padding:2px 0 2px 14px;margin-bottom:16px">` +
    `<h2 style="margin:0;font-size:20px;color:${copy.tone}">${copy.heading}</h2></div>` +
    `<p>${greeting}</p>` +
    `<p>${copy.intro}</p>` +
    `<p style="margin:18px 0 4px;font-weight:600">Invoice details</p>` +
    `<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px"><tbody>` +
    detailRow('Practitioner', practitionerName || '—') +
    detailRow('Order Number', orderNumber || '—') +
    detailRow('Invoice Number', invoiceNumber || '—') +
    detailRow('Invoice Date', invDate || '—') +
    detailRow('Payment Status', statusLabel) +
    (due ? detailRow('Due Date', due) : '') +
    detailRow('Outstanding Amount', `<strong>${amountLine || '—'}</strong>`) +
    `</tbody></table>` +
    productTable +
    `<p style="margin-top:18px;padding:12px 14px;background:#f6f6f6;border-radius:6px"><strong>Action required:</strong> ${copy.action}</p>` +
    `<p style="color:#555;font-size:13px">${contactLine}</p>` +
    `<p style="margin-top:16px">Thank you,<br/>Natural Solutions</p>` +
    `</div>`

  return { subject, text, html }
}
