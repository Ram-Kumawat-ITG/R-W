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
export async function notifyReferralCodeCreated({ email, practitionerName, code, discountPercent, referralUrl }) {
  const subject = `Your Referral Code "${code}" Is Ready`
  const html = wrapHtml(`
    <p>Hi ${practitionerName || 'there'},</p>
    <p>Your new referral code has been created and is live:</p>
    <ul>
      <li><strong>Code:</strong> ${code}</li>
      <li><strong>Discount:</strong> ${pctLabel(discountPercent)} off for anyone who uses it</li>
      ${referralUrl ? `<li><strong>Shareable link:</strong> <a href="${referralUrl}">${referralUrl}</a></li>` : ''}
    </ul>
    <p>Share the code or the link above with your patients — the discount is already active.</p>
  `)

  return send({
    to: email,
    subject,
    html,
    context: { event: 'referral_code_created', email, code, discountPercent },
  })
}

// ── 2. Referral Code Paused ─────────────────────────────────────────────
export async function notifyReferralCodePaused({ email, practitionerName, code, discountPercent }) {
  const subject = `Your Referral Code "${code}" Has Been Paused`
  const html = wrapHtml(`
    <p>Hi ${practitionerName || 'there'},</p>
    <p>Your referral code <strong>${code}</strong> (${pctLabel(discountPercent)} off) has been paused —
    it will no longer apply a discount for anyone who uses it.</p>
    <p>You can resume it at any time from the Referral Management page in your Practitioner Portal.</p>
  `)

  return send({
    to: email,
    subject,
    html,
    context: { event: 'referral_code_paused', email, code, discountPercent },
  })
}

// ── 3. Referral Code Resumed ─────────────────────────────────────────────
export async function notifyReferralCodeResumed({ email, practitionerName, code, discountPercent }) {
  const subject = `Your Referral Code "${code}" Has Been Resumed`
  const html = wrapHtml(`
    <p>Hi ${practitionerName || 'there'},</p>
    <p>Your referral code <strong>${code}</strong> (${pctLabel(discountPercent)} off) is active again —
    the discount will now apply for anyone who uses it.</p>
  `)

  return send({
    to: email,
    subject,
    html,
    context: { event: 'referral_code_resumed', email, code, discountPercent },
  })
}
