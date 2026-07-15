// Two customer-facing (+ admin CC'd) emails covering post-approval account
// events: account blocked/revoked (admin action) and profile-or-payment-
// method updated (customer self-service OR admin action). Same SMTP
// utility + best-effort-never-throws convention as
// applicationLifecycleNotification.service.js.

import { sendEmail } from '../email/email.service'
import { accountNotificationConfig as config } from './accountNotification.config'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('accountNotification')

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

// ── 4. Customer Account Blocked / Revoked ──────────────────────────────
export async function notifyAccountBlocked({ email, firstName, lastName, businessName, reason, blockedAt }) {
  if (!email) return { success: false, skipped: true, reason: 'no email' }

  const supportLine = config.supportEmail
    ? `contact us at <a href="mailto:${config.supportEmail}">${config.supportEmail}</a>`
    : 'contact our support team'

  const subject = 'Your Wholesale Account Access Has Been Revoked'
  const html = wrapHtml(`
    <p>Hi ${fullName({ firstName, lastName })},</p>
    <p>Your wholesale account access has been revoked. <strong>You no longer have access to wholesale pricing or ordering.</strong> See the details below.</p>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">
      <tbody>
        <tr><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Field</th><th style="text-align:left;padding:8px;border:1px solid #ddd">Value</th></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Account</td><td style="padding:8px;border:1px solid #ddd">${businessName || '—'}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Revoked at</td><td style="padding:8px;border:1px solid #ddd">${blockedAt ? new Date(blockedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '—'}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Reason</td><td style="padding:8px;border:1px solid #ddd">${reason || '—'}</td></tr>
      </tbody>
    </table>
    <p style="margin-top:16px">If you believe this is a mistake or would like more information, please ${supportLine}.</p>
  `)

  return send({ to: email, subject, html, context: { event: 'account_blocked', email, reason } })
}

// ── 5. Customer Profile or Payment Method Updated ──────────────────────
//
// `changes` is a short array of human-readable strings (e.g. ["Business
// name", "Billing address"] or ["Payment method changed to ACH"]) so the
// customer sees exactly what changed without dumping raw field diffs.
// `source` is 'customer' (self-service /api/update-profile) or 'admin'
// (POST /api/admin/customers/:id/payment-method), used only to adjust
// the email's framing, not to gate whether it sends.
export async function notifyProfileUpdated({ email, firstName, lastName, businessName, changes = [], source = 'customer', updatedAt }) {
  if (!email) return { success: false, skipped: true, reason: 'no email' }
  if (!changes.length) return { success: false, skipped: true, reason: 'no changes to report' }

  const subject = 'Your Wholesale Account Information Was Updated'
  const byLine =
    source === 'admin'
      ? 'This change was made by a Natural Solutions administrator on your behalf.'
      : 'This change was made on your account.'
  const changeRows = changes.map((c) => `<tr><td style="padding:8px;border:1px solid #ddd">${c}</td></tr>`).join('')

  const html = wrapHtml(`
    <p>Hi ${fullName({ firstName, lastName })},</p>
    <p>The following account information was updated on your Natural Solutions Wholesale account${businessName ? ` (<strong>${businessName}</strong>)` : ''}. <strong>Review the changes below and contact us immediately if you did not authorize them.</strong></p>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">
      <thead>
        <tr><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Field changed</th></tr>
      </thead>
      <tbody>${changeRows}</tbody>
    </table>
    <p style="margin-top:12px"><strong>Changed by:</strong> ${byLine}</p>
    <p><strong>Updated at:</strong> ${updatedAt ? new Date(updatedAt).toLocaleString('en-US') : '—'}</p>
  `)

  return send({ to: email, subject, html, context: { event: 'profile_updated', email, source, changes } })
}
