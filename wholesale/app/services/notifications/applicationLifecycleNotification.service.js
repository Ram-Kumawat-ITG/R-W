// Three customer-facing (+ admin CC'd) emails covering the wholesale
// registration lifecycle: application submitted, auto-approved, and
// declined (NMI payment-method failure). All three go through the shared
// SMTP utility (services/email/email.service.sendEmail) — this module owns
// only the template content + trigger points, mirroring the established
// paymentFailureNotification.service.js / batchSummaryNotification.service.js
// pattern.
//
// Approval here is AUTOMATIC (see app/api/registration-form.js) — there is
// no separate manual-review step today, so "Submitted" and "Approved" fire
// back-to-back in the same request for a successful registration. "Declined"
// fires instead of "Submitted" when NMI vault/billing creation fails, since
// no WholesaleApplication doc is ever persisted on that path — its content
// comes from the raw submitted form fields, not a Mongo doc.
//
// All three sends are best-effort: failures are logged and swallowed, never
// thrown upward — registration success/failure must never hinge on SMTP.

import { sendEmail } from '../email/email.service'
import { applicationLifecycleNotificationConfig as config } from './applicationLifecycleNotification.config'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('applicationLifecycleNotification')

function fullName({ firstName, lastName }) {
  return [firstName, lastName].filter(Boolean).join(' ').trim() || 'there'
}

function wrapHtml(bodyHtml) {
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.5">
      ${bodyHtml}
      <p style="margin-top:24px;color:#6b6b6b;font-size:12px">Natural Solutions Wholesale</p>
    </div>
  `
}

async function send({ to, subject, html, context }) {
  const result = await sendEmail({ to, cc: config.adminEmail, subject, html })
  if (!result.success) {
    log.error('send.failed', { ...context, error: result.error })
  } else {
    log.info('send.success', { ...context, messageId: result.messageId })
  }
  return result
}

// ── 1. New Wholesale Application Submitted ─────────────────────────────
export async function notifyApplicationSubmitted({ email, firstName, lastName, businessName }) {
  if (!email) return { success: false, skipped: true, reason: 'no email' }

  const subject = 'We received your Wholesale Application'
  const html = wrapHtml(`
    <p>Hi ${fullName({ firstName, lastName })},</p>
    <p>Thank you for applying for a Natural Solutions Wholesale account${businessName ? ` for <strong>${businessName}</strong>` : ''}.
    We've received your application and it is now being processed.</p>
    <p>You'll receive a separate email as soon as your account is ready to use.</p>
    <p>If anything looks incorrect or you didn't submit this application, please contact us right away.</p>
  `)

  return send({ to: email, subject, html, context: { event: 'application_submitted', email } })
}

// ── 2. Wholesale Application Auto-Approved ─────────────────────────────
export async function notifyApplicationApproved({ email, firstName, lastName, businessName }) {
  if (!email) return { success: false, skipped: true, reason: 'no email' }

  const subject = 'Your Wholesale Account Has Been Approved'
  const html = wrapHtml(`
    <p>Hi ${fullName({ firstName, lastName })},</p>
    <p>Great news — your Natural Solutions Wholesale application${businessName ? ` for <strong>${businessName}</strong>` : ''}
    has been approved.</p>
    <p>You should receive a separate account-activation email shortly with a link to set your password
    and start shopping at wholesale pricing. If you don't see it within a few minutes, please check your
    spam folder before contacting us.</p>
  `)

  return send({ to: email, subject, html, context: { event: 'application_approved', email } })
}

// ── 3. Wholesale Application Declined (NMI card/bank failure) ──────────
//
// Fires from the two NMI-failure branches in registration-form.js — no
// WholesaleApplication doc exists at that point (registration aborts with
// no side effects), so content comes straight from the submitted payload.
export async function notifyApplicationDeclined({ email, firstName, lastName, businessName, reason }) {
  if (!email) return { success: false, skipped: true, reason: 'no email' }

  const subject = 'We Could Not Complete Your Wholesale Application'
  const supportLine = config.supportEmail
    ? `please contact us at <a href="mailto:${config.supportEmail}">${config.supportEmail}</a>`
    : 'please contact our support team'

  const html = wrapHtml(`
    <p>Hi ${fullName({ firstName, lastName })},</p>
    <p>We were unable to complete your Natural Solutions Wholesale application${businessName ? ` for <strong>${businessName}</strong>` : ''}
    because we could not verify the payment method you provided.</p>
    ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
    <p>No account was created and nothing was charged. Please double-check your card or bank details and
    submit the application again — if the problem continues, ${supportLine}.</p>
  `)

  return send({ to: email, subject, html, context: { event: 'application_declined', email, reason } })
}
