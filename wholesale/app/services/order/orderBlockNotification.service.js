// "New Orders Temporarily Blocked" email — sent to the PRACTITIONER (admin CC'd)
// the moment they are put on a payment order hold because their card payment
// retries were exhausted on an outstanding invoice.
//
// Trigger point: paymentRetry.service, right after reconcilePractitionerOrderHold
// places the hold (the card retry ladder finalized `failed`). Deliberately
// isolated + never-throws — a mail-transport hiccup must never interrupt the
// retry CRON or mask the payment/hold state, which is already persisted.
//
// Delivery is via the durable SMTP queue (enqueueEmail → send-email Agenda job),
// same transport the other notifications use.

import { enqueueEmail } from '../email/emailQueue.service'
import { orderBlockNotificationConfig } from './orderBlockNotification.config'
import { formatAmount } from '../../utils/format.utils'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('orderBlockNotification.service')

function formatDate(value) {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

const TD = 'padding:8px;border:1px solid #ddd'
function row(label, value) {
  return `<tr><td style="${TD};font-weight:600;background:#fafafa">${label}</td><td style="${TD}">${value ?? '—'}</td></tr>`
}

// Pure content builder — no I/O. Kept separate so the content can be unit-tested
// or previewed without touching the send path.
export function buildOrderBlockEmail({
  practitionerName,
  invoiceNumber,
  orderNumber,
  outstandingAmount,
  currency,
  dueDate,
  lastFailedAt,
  retryCount,
  maxRetries,
  supportEmail,
}) {
  const greeting = practitionerName ? `Hi ${practitionerName},` : 'Hello,'
  const amountLine =
    outstandingAmount !== undefined && outstandingAmount !== null
      ? formatAmount(outstandingAmount, currency)
      : null
  const dueLine = formatDate(dueDate)
  const failedLine = formatDate(lastFailedAt)
  const attemptsLine =
    retryCount != null && maxRetries != null ? `${retryCount} of ${maxRetries}` : retryCount != null ? String(retryCount) : null
  const contactLine = supportEmail
    ? `If you have any questions or need assistance, please contact our support team at ${supportEmail}.`
    : 'If you have any questions or need assistance, please contact our support team.'

  const subject = invoiceNumber
    ? `Action Required: New Orders Temporarily Blocked — Invoice ${invoiceNumber}`
    : 'Action Required: New Orders Temporarily Blocked'

  const text =
    `${greeting}\n\n` +
    `We were unable to process payment for one of your invoices after multiple attempts. ` +
    `As a result, new orders have been temporarily blocked on your account until the outstanding invoice is paid.\n\n` +
    `Outstanding invoice details:\n` +
    `- Invoice Number: ${invoiceNumber || '—'}\n` +
    `- Order Number: ${orderNumber || '—'}\n` +
    `- Outstanding Amount: ${amountLine || '—'}\n` +
    (dueLine ? `- Invoice Due Date: ${dueLine}\n` : '') +
    `- Last Failed Payment Date: ${failedLine || '—'}\n` +
    `- Retry Attempts: ${attemptsLine || '—'}\n\n` +
    `Once this outstanding invoice has been paid, your account will be automatically unblocked and you will be able to place new orders again.\n\n` +
    `${contactLine}\n\n` +
    `Thank you,\nNatural Solutions`

  const html =
    `<p>${greeting}</p>` +
    `<p>We were unable to process payment for one of your invoices after multiple attempts. ` +
    `As a result, <strong>new orders have been temporarily blocked</strong> on your account until the outstanding invoice is paid.</p>` +
    `<p style="margin-top:16px;font-weight:600">Outstanding invoice details</p>` +
    `<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin-top:4px"><tbody>` +
    row('Invoice Number', invoiceNumber || '—') +
    row('Order Number', orderNumber || '—') +
    row('Outstanding Amount', amountLine || '—') +
    (dueLine ? row('Invoice Due Date', dueLine) : '') +
    row('Last Failed Payment Date', failedLine || '—') +
    row('Retry Attempts', attemptsLine || '—') +
    `</tbody></table>` +
    `<p style="margin-top:16px">Once this outstanding invoice has been paid, your account will be <strong>automatically unblocked</strong> and you will be able to place new orders again.</p>` +
    `<p>${contactLine}</p>` +
    `<p>Thank you,<br/>Natural Solutions</p>`

  return { subject, text, html }
}

// notifyOrderBlocked — the single call site the retry CRON needs. Resolves the
// recipient off the invoice, builds the content, and enqueues via the durable
// SMTP queue with the admin CC'd. Always resolves (never rejects).
export async function notifyOrderBlocked({
  invoice,
  practitionerName,
  orderNumber,
  retryCount,
  maxRetries,
  lastFailedAt,
}) {
  const context = { invoiceId: invoice?._id?.toString(), to: invoice?.customerEmail }
  try {
    if (!invoice?.customerEmail) {
      log.warn('notify.skipped_no_email', context)
      return { success: false, error: 'invoice has no customerEmail on file' }
    }

    const { subject, text, html } = buildOrderBlockEmail({
      practitionerName,
      invoiceNumber: invoice.qboDocNumber || invoice.qboInvoiceId || null,
      orderNumber: orderNumber || (invoice.shopifyOrderId ? `#${invoice.shopifyOrderId}` : null),
      outstandingAmount:
        invoice.amountDue != null && invoice.amountPaid != null
          ? invoice.amountDue - invoice.amountPaid
          : invoice.amountDue,
      currency: invoice.currency,
      dueDate: invoice.dueAt || invoice.qboDueDate || null,
      lastFailedAt: lastFailedAt || invoice?.cardRetry?.firstFailedAt || null,
      retryCount: retryCount != null ? retryCount : invoice?.cardRetry?.retryCount,
      maxRetries: maxRetries != null ? maxRetries : invoice?.cardRetry?.maxRetries,
      supportEmail: orderBlockNotificationConfig.supportEmail,
    })

    const result = await enqueueEmail(
      {
        to: invoice.customerEmail,
        cc: orderBlockNotificationConfig.adminEmail || undefined,
        subject,
        text,
        html,
      },
      { label: 'order_blocked' },
    )

    if (result.success) {
      log.info('notify.queued', { ...context, cc: orderBlockNotificationConfig.adminEmail })
    } else {
      log.error('notify.send_failed', { ...context, error: result.error })
    }
    return result
  } catch (err) {
    log.error('notify.unexpected', { ...context, err: err?.message || err })
    return { success: false, error: err?.message || 'Unexpected error sending order-block email' }
  }
}
