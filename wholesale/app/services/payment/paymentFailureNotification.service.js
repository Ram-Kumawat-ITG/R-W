// Customer-facing "Payment Failed" email for the process-pending-payments
// CRON. Fires whenever a charge attempt against an invoice does NOT end in
// success (declined, errored, or skipped for a real failure reason —
// missing/invalid vault, no card on file, max attempts reached, etc).
//
// Deliberately isolated from payment.service / the CRON job's charge logic:
// this module only builds + sends the notification. It is never allowed to
// throw — a mail-transport hiccup must not interrupt batch processing or
// mask the underlying payment outcome, which is already recorded on the
// invoice via remarks[]/PaymentAttempt regardless of whether this email
// goes out.

import { sendEmail } from '../email/email.service'
import { paymentFailureNotificationConfig } from './paymentFailureNotification.config'
import { isEmailNotificationsPaused } from '../scheduler/cronNotificationSettings.service'
import { formatAmount } from '../../utils/format.utils'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('paymentFailureNotification.service')

const PAYMENT_METHOD_LABEL = { card: 'Credit card', ach: 'ACH / bank transfer', check: 'Cheque' }

function formatOrderDate(value) {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

// Pure content builder — no I/O, easy to reason about / reuse elsewhere
// (e.g. a future admin preview) without touching the send path.
export function buildPaymentFailureEmail({
  customerName,
  orderLabel,
  orderDate,
  invoiceLabel,
  amount,
  currency,
  paymentMethod,
  attemptCount,
  maxAttempts,
  reason,
  supportEmail,
}) {
  const greeting = customerName ? `Hi ${customerName},` : 'Hello,'
  const amountLine = amount !== undefined && amount !== null ? formatAmount(amount, currency) : null
  const contactLine = supportEmail
    ? `If you have any questions or need assistance, please contact our support team at ${supportEmail}.`
    : 'If you have any questions or need assistance, please contact our support team.'

  // Order/invoice/payment context — rendered as a labelled list so the
  // customer sees exactly what was being charged and why, without having
  // to infer it from a single sentence.
  const details = [
    orderLabel && ['Order', orderLabel],
    formatOrderDate(orderDate) && ['Order date', formatOrderDate(orderDate)],
    invoiceLabel && ['Invoice', invoiceLabel],
    amountLine && ['Amount', amountLine],
    paymentMethod && ['Payment method', PAYMENT_METHOD_LABEL[paymentMethod] || paymentMethod],
    attemptCount != null && maxAttempts != null && ['Attempt', `${attemptCount} of ${maxAttempts}`],
  ].filter(Boolean)

  const subject = orderLabel
    ? `Payment Failed for Order ${orderLabel} — Action Required`
    : 'Payment Failed — Action Required'

  const text =
    `${greeting}\n\n` +
    `We attempted to process your payment, but it was unsuccessful.\n\n` +
    (details.length ? details.map(([label, value]) => `${label}: ${value}`).join('\n') + '\n\n' : '') +
    (reason ? `Reason: ${reason}\n\n` : '') +
    `${contactLine}\n\n` +
    `Thank you,\nNatural Solutions`

  const html =
    `<p>${greeting}</p>` +
    `<p>We attempted to process your payment, but it was unsuccessful.</p>` +
    (details.length
      ? `<ul>${details.map(([label, value]) => `<li><strong>${label}:</strong> ${value}</li>`).join('')}</ul>`
      : '') +
    (reason ? `<p><strong>Reason:</strong> ${reason}</p>` : '') +
    `<p>${contactLine}</p>` +
    `<p>Thank you,<br/>Natural Solutions</p>`

  return { subject, text, html }
}

// notifyPaymentFailure — the only call site the CRON needs. Resolves the
// recipient off the invoice, builds the content, and sends via the shared
// SMTP utility. Always resolves (never rejects) — callers should log the
// returned result if they want visibility but never need a try/catch of
// their own.
export async function notifyPaymentFailure({ invoice, reason, customerName, orderLabel, orderDate }) {
  const context = { invoiceId: invoice?._id?.toString(), to: invoice?.customerEmail }
  try {
    if (await isEmailNotificationsPaused()) {
      log.info('notify.skipped_paused', context)
      return { success: false, error: 'CRON email notifications are currently paused', skipped: true }
    }

    if (!invoice?.customerEmail) {
      log.warn('notify.skipped_no_email', context)
      return { success: false, error: 'invoice has no customerEmail on file' }
    }

    const { subject, text, html } = buildPaymentFailureEmail({
      customerName,
      orderLabel: orderLabel || (invoice.shopifyOrderId ? `#${invoice.shopifyOrderId}` : null),
      orderDate,
      invoiceLabel: invoice.qboDocNumber || invoice.qboInvoiceId || null,
      amount: invoice.amountDue != null && invoice.amountPaid != null
        ? invoice.amountDue - invoice.amountPaid
        : invoice.amountDue,
      currency: invoice.currency,
      paymentMethod: invoice.paymentMethod,
      attemptCount: invoice.attemptCount,
      maxAttempts: invoice.maxAttempts,
      reason,
      supportEmail: paymentFailureNotificationConfig.supportEmail,
    })

    const result = await sendEmail({
      to: invoice.customerEmail,
      cc: paymentFailureNotificationConfig.adminEmail || undefined,
      subject,
      text,
      html,
    })

    if (result.success) {
      log.info('notify.sent', {
        ...context,
        cc: paymentFailureNotificationConfig.adminEmail,
        messageId: result.messageId,
      })
    } else {
      log.error('notify.send_failed', { ...context, error: result.error })
    }
    return result
  } catch (err) {
    // sendEmail() itself never throws, but this module must be bulletproof
    // regardless — a defect here can never be allowed to abort a CRON tick.
    log.error('notify.unexpected', { ...context, err })
    return { success: false, error: err.message || 'Unexpected error sending payment failure email' }
  }
}
