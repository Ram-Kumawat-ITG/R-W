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
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('paymentFailureNotification.service')

function formatAmount(amount, currency) {
  const n = Number(amount || 0)
  return `${(currency || 'USD').toUpperCase()} ${n.toFixed(2)}`
}

// Pure content builder — no I/O, easy to reason about / reuse elsewhere
// (e.g. a future admin preview) without touching the send path.
export function buildPaymentFailureEmail({
  customerName,
  invoiceLabel,
  amount,
  currency,
  reason,
  supportEmail,
}) {
  const greeting = customerName ? `Hi ${customerName},` : 'Hello,'
  const invoiceLine = invoiceLabel ? ` for invoice ${invoiceLabel}` : ''
  const amountLine = amount !== undefined && amount !== null ? ` of ${formatAmount(amount, currency)}` : ''
  const reasonLine = reason ? `\n\nReason: ${reason}` : ''
  const contactLine = supportEmail
    ? `If you have any questions or need assistance, please contact our support team at ${supportEmail}.`
    : 'If you have any questions or need assistance, please contact our support team.'

  const subject = 'Payment Failed — Action Required'

  const text =
    `${greeting}\n\n` +
    `We attempted to process your payment${amountLine}${invoiceLine}, but the payment was unsuccessful.` +
    `${reasonLine}\n\n` +
    `${contactLine}\n\n` +
    `Thank you,\nNatural Solutions`

  const html =
    `<p>${greeting}</p>` +
    `<p>We attempted to process your payment${amountLine}${invoiceLine}, but the payment was unsuccessful.</p>` +
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
export async function notifyPaymentFailure({ invoice, reason, customerName }) {
  const context = { invoiceId: invoice?._id?.toString(), to: invoice?.customerEmail }
  try {
    if (!invoice?.customerEmail) {
      log.warn('notify.skipped_no_email', context)
      return { success: false, error: 'invoice has no customerEmail on file' }
    }

    const { subject, text, html } = buildPaymentFailureEmail({
      customerName,
      invoiceLabel: invoice.qboDocNumber || invoice.qboInvoiceId || invoice.shopifyOrderId,
      amount: invoice.amountDue != null && invoice.amountPaid != null
        ? invoice.amountDue - invoice.amountPaid
        : invoice.amountDue,
      currency: invoice.currency,
      reason,
      supportEmail: paymentFailureNotificationConfig.supportEmail,
    })

    const result = await sendEmail({ to: invoice.customerEmail, subject, text, html })

    if (result.success) {
      log.info('notify.sent', { ...context, messageId: result.messageId })
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
