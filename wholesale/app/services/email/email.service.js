// Generic, template-agnostic SMTP email sender.
//
// Any module that needs to send an email (payment failure alerts, invoice
// notices, admin digests, etc.) calls sendEmail() with its own subject/body —
// this service owns only the transport (SMTP connection, retries, logging,
// error shape). It has no knowledge of *why* an email is being sent.

import nodemailer from 'nodemailer'
import { emailConfig, assertEmailConfigured } from './email.config'
import { createLogger } from '../../utils/logger.utils'
import { PermanentError, TransientError, retry } from '../../utils/retry.utils'

const log = createLogger('email.service')

let transporter = null

function getTransporter() {
  if (transporter) return transporter
  assertEmailConfigured()
  transporter = nodemailer.createTransport({
    host: emailConfig.host,
    port: emailConfig.port,
    secure: emailConfig.secure,
    auth: { user: emailConfig.user, pass: emailConfig.password },
    // Hard SMTP timeouts so a slow/unreachable mail server can never hang the
    // caller for the OS-default TCP timeout (minutes). Without these, an
    // awaited send in a request path (e.g. registration) could block long
    // enough to trip the Shopify App Proxy / platform gateway timeout. A send
    // that exceeds these fails fast as a TransientError (retried, then the
    // caller gets { success:false }).
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  })
  return transporter
}

function toList(value) {
  if (!value) return undefined
  return Array.isArray(value) ? value.filter(Boolean) : value
}

// sendEmail — the only exported entry point. Every field except `to` and
// (`subject` + one of `html`/`text`) is optional.
//
//   to / cc / bcc      string | string[]
//   subject            string
//   html / text        body content — at least one required
//   attachments        nodemailer attachment shape: [{ filename, content|path, contentType }]
//   replyTo            string, overrides emailConfig.replyTo for this send
//   from               string, overrides the configured from name/email for this send
//
// Returns { success: true, messageId } or { success: false, error }.
// Never throws — callers get a standardized result and decide what to do.
export async function sendEmail({ to, cc, bcc, subject, html, text, attachments, replyTo, from }) {
  const context = { to, subject }

  if (!to) return failure('sendEmail: "to" is required', context)
  if (!subject) return failure('sendEmail: "subject" is required', context)
  if (!html && !text) return failure('sendEmail: one of "html" or "text" is required', context)

  try {
    const client = getTransporter()

    const message = {
      from: from || `"${emailConfig.fromName}" <${emailConfig.fromEmail}>`,
      to: toList(to),
      cc: toList(cc),
      bcc: toList(bcc),
      replyTo: replyTo || emailConfig.replyTo || undefined,
      subject,
      html,
      text,
      attachments,
    }

    const info = await retry(() => sendOnce(client, message), {
      attempts: 3,
      baseMs: 500,
      maxMs: 4000,
      onAttempt: ({ attempt, err, nextDelayMs }) =>
        log.warn('send.retry', { ...context, attempt, err, nextDelayMs }),
    })

    log.info('send.success', { ...context, messageId: info.messageId })
    return { success: true, messageId: info.messageId }
  } catch (err) {
    log.error('send.failed', { ...context, err })
    return { success: false, error: err.message || 'Failed to send email' }
  }
}

// SMTP 5xx / connection-level failures are transient; 4xx (bad recipient,
// auth rejected, etc.) are permanent and shouldn't be retried.
async function sendOnce(client, message) {
  try {
    return await client.sendMail(message)
  } catch (err) {
    const code = err.responseCode
    if (code && code >= 400 && code < 500) {
      throw new PermanentError(err.message, { cause: err, status: code })
    }
    throw new TransientError(err.message, { cause: err, status: code })
  }
}

function failure(message, context) {
  log.error('send.invalid', { ...context, message })
  return { success: false, error: message }
}
