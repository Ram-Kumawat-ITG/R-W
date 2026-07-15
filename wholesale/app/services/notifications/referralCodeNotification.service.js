// Three practitioner-facing (+ admin CC'd) emails covering the Practitioner
// Portal's self-service referral-code lifecycle: created, paused, resumed.
// Same shared SMTP utility (services/email/email.service.sendEmail) and
// best-effort-never-throws convention as applicationLifecycleNotification /
// accountNotification — a notification failure must never surface as a
// portal-action failure (the code create/pause/resume already succeeded
// by the time these are called).

import { sendEmail } from '../email/email.service'
import { referralCodeNotificationConfig as config } from './referralCodeNotification.config'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('referralCodeNotification')

function wrapHtml(bodyHtml) {
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.5">
      ${bodyHtml}
      <p style="margin-top:24px;color:#6b6b6b;font-size:12px">Natural Solutions Wholesale</p>
    </div>
  `
}

function pctLabel(discountPercent) {
  const n = Number(discountPercent)
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : 'unknown'
}

async function send({ to, subject, html, context }) {
  if (!to) {
    log.warn('send.skipped_no_email', context)
    return { success: false, skipped: true, reason: 'no practitioner email' }
  }
  const result = await sendEmail({ to, cc: config.adminEmail, subject, html })
  if (!result.success) {
    log.error('send.failed', { ...context, error: result.error })
  } else {
    log.info('send.success', { ...context, messageId: result.messageId })
  }
  return result
}

// ── 1. Referral Code Created ────────────────────────────────────────────
export async function notifyReferralCodeCreated({ email, practitionerName, code, discountPercent, referralUrl, createdAt }) {
  const subject = `Your Referral Code "${code}" Is Ready`
  const html = wrapHtml(`
    <p>Hi ${practitionerName || 'there'},</p>
    <p>Your new referral code has been created and is live. Share it with your patients and earn rewards.</p>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">
      <tbody>
        <tr><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Field</th><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Value</th></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Code</td><td style="padding:8px;border:1px solid #ddd"><strong style="font-family:monospace;font-size:16px">${code}</strong></td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Discount</td><td style="padding:8px;border:1px solid #ddd">${pctLabel(discountPercent)} off</td></tr>
        ${referralUrl ? `<tr><td style="padding:8px;border:1px solid #ddd">Shareable link</td><td style="padding:8px;border:1px solid #ddd"><a href="${referralUrl}">${referralUrl}</a></td></tr>` : ''}
        ${createdAt ? `<tr><td style="padding:8px;border:1px solid #ddd">Created</td><td style="padding:8px;border:1px solid #ddd">${new Date(createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</td></tr>` : ''}
      </tbody>
    </table>
    <p style="margin-top:16px">The discount is already active. Start sharing today!</p>
  `)

  return send({
    to: email,
    subject,
    html,
    context: { event: 'referral_code_created', email, code, discountPercent },
  })
}

// ── 2. Referral Code Paused ─────────────────────────────────────────────
export async function notifyReferralCodePaused({ email, practitionerName, code, discountPercent, reason, pausedAt }) {
  const subject = `Your Referral Code "${code}" Has Been Paused`
  const html = wrapHtml(`
    <p>Hi ${practitionerName || 'there'},</p>
    <p>Your referral code is no longer active. New patients cannot use it to claim the discount. See details below.</p>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">
      <tbody>
        <tr><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Field</th><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Value</th></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Code</td><td style="padding:8px;border:1px solid #ddd"><strong style="font-family:monospace;font-size:16px">${code}</strong></td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Discount offered</td><td style="padding:8px;border:1px solid #ddd">${pctLabel(discountPercent)} off</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Status</td><td style="padding:8px;border:1px solid #ddd"><strong style="color:#d9534f">Paused</strong></td></tr>
        ${reason ? `<tr><td style="padding:8px;border:1px solid #ddd">Reason</td><td style="padding:8px;border:1px solid #ddd">${reason}</td></tr>` : ''}
        ${pausedAt ? `<tr><td style="padding:8px;border:1px solid #ddd">Paused at</td><td style="padding:8px;border:1px solid #ddd">${new Date(pausedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</td></tr>` : ''}
      </tbody>
    </table>
    <p style="margin-top:16px">You can resume your code at any time from your Practitioner Portal.</p>
  `)

  return send({
    to: email,
    subject,
    html,
    context: { event: 'referral_code_paused', email, code, discountPercent },
  })
}

// ── 3. Referral Code Resumed ─────────────────────────────────────────────
export async function notifyReferralCodeResumed({ email, practitionerName, code, discountPercent, resumedAt }) {
  const subject = `Your Referral Code "${code}" Has Been Resumed`
  const html = wrapHtml(`
    <p>Hi ${practitionerName || 'there'},</p>
    <p>Your referral code is active again! Patients can now use it to claim the discount.</p>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">
      <tbody>
        <tr><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Field</th><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Value</th></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Code</td><td style="padding:8px;border:1px solid #ddd"><strong style="font-family:monospace;font-size:16px">${code}</strong></td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Discount offered</td><td style="padding:8px;border:1px solid #ddd">${pctLabel(discountPercent)} off</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Status</td><td style="padding:8px;border:1px solid #ddd"><strong style="color:#5cb85c">Active</strong></td></tr>
        ${resumedAt ? `<tr><td style="padding:8px;border:1px solid #ddd">Resumed</td><td style="padding:8px;border:1px solid #ddd">${new Date(resumedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</td></tr>` : ''}
      </tbody>
    </table>
    <p style="margin-top:16px">Start sharing your code with patients again!</p>
  `)

  return send({
    to: email,
    subject,
    html,
    context: { event: 'referral_code_resumed', email, code, discountPercent },
  })
}
