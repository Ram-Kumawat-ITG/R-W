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
export async function notifyApplicationSubmitted({ email, firstName, lastName, businessName, applicationDate }) {
  if (!email) return { success: false, skipped: true, reason: 'no email' }

  const subject = 'We received your Wholesale Application'
  const html = wrapHtml(`
    <p>Hi ${fullName({ firstName, lastName })},</p>
    <p>Thank you for applying for a Natural Solutions Wholesale account. We've received your application and it is now being processed. You'll get a separate email as soon as your account is ready. <strong>No action is needed right now.</strong></p>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">
      <tbody>
        <tr><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4;width:30%">Field</th><th style="text-align:left;padding:8px;border:1px solid #ddd">Value</th></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Applicant</td><td style="padding:8px;border:1px solid #ddd">${fullName({ firstName, lastName })}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Business</td><td style="padding:8px;border:1px solid #ddd">${businessName || '—'}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Email</td><td style="padding:8px;border:1px solid #ddd">${email}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Submitted at</td><td style="padding:8px;border:1px solid #ddd">${applicationDate ? new Date(applicationDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '—'}</td></tr>
      </tbody>
    </table>
    <p style="margin-top:16px">If anything looks incorrect, please contact us right away.</p>
  `)

  return send({ to: email, subject, html, context: { event: 'application_submitted', email } })
}

// ── 2. Wholesale Application Auto-Approved ─────────────────────────────
export async function notifyApplicationApproved({ email, firstName, lastName, businessName, approvedAt }) {
  if (!email) return { success: false, skipped: true, reason: 'no email' }

  const subject = 'Your Wholesale Account Has Been Approved'
  const html = wrapHtml(`
    <p>Hi ${fullName({ firstName, lastName })},</p>
    <p>Your wholesale application has been approved. You can now sign in with your email and request a one-time verification code (OTP).</p>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">
      <tbody>
        <tr><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Field</th><th style="text-align:left;padding:8px;border:1px solid #ddd">Value</th></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Account</td><td style="padding:8px;border:1px solid #ddd">${businessName || '—'}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Email</td><td style="padding:8px;border:1px solid #ddd">${email}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Approved at</td><td style="padding:8px;border:1px solid #ddd">${approvedAt ? new Date(approvedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '—'}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Login method</td><td style="padding:8px;border:1px solid #ddd">One-time code (OTP)</td></tr>
      </tbody>
    </table>
    <p style="margin-top:16px"><strong>Next step:</strong> Sign in at your wholesale portal and request a verification code to proceed.</p>
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
    ? `contact us at <a href="mailto:${config.supportEmail}">${config.supportEmail}</a>`
    : 'contact our support team'

  const html = wrapHtml(`
    <p>Hi ${fullName({ firstName, lastName })},</p>
    <p>We could not complete your wholesale application. Please review the details below and resubmit with corrected information.</p>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">
      <tbody>
        <tr><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Field</th><th style="text-align:left;padding:8px;border:1px solid #ddd">Details</th></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Applicant</td><td style="padding:8px;border:1px solid #ddd">${fullName({ firstName, lastName })}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Business</td><td style="padding:8px;border:1px solid #ddd">${businessName || '—'}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Reason</td><td style="padding:8px;border:1px solid #ddd">${reason || 'Payment method could not be verified'}</td></tr>
      </tbody>
    </table>
    <p style="margin-top:12px"><strong>No account was created and nothing was charged.</strong> Double-check your payment details and submit again. If the problem continues, ${supportLine}.</p>
  `)

  return send({ to: email, subject, html, context: { event: 'application_declined', email, reason } })
}
