// Admin-only critical alert emails for NMI payment processing / customer
// vaults. Same SMTP utility + admin-only (no cc) + best-effort-never-throws
// convention as qboAlertNotification.service.js — read that file's header
// comment for the full rationale; not repeated here.

import { sendEmail } from '../email/email.service'
import { nmiAlertNotificationConfig as config } from './nmiAlertNotification.config'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('nmiAlertNotification')

function wrapHtml(bodyHtml) {
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.5">
      ${bodyHtml}
      <p style="margin-top:24px;color:#6b6b6b;font-size:12px">Natural Solutions Wholesale — automated system alert</p>
    </div>
  `
}

function errorDetailsHtml(error) {
  const parts = []
  parts.push(`Message: ${error?.message || String(error)}`)
  if (error?.name) parts.push(`Type: ${error.name}`)
  if (error?.status !== undefined) parts.push(`HTTP status: ${error.status}`)
  if (error?.body !== undefined) {
    try {
      parts.push(`Response body: ${JSON.stringify(error.body).slice(0, 1000)}`)
    } catch {
      parts.push(`Response body: ${String(error.body).slice(0, 1000)}`)
    }
  }
  if (error?.stack) parts.push(`\nStack trace:\n${String(error.stack).slice(0, 2000)}`)
  return `<pre style="background:#f4f4f4;padding:12px;border-radius:4px;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere">${parts.join('\n')}</pre>`
}

async function send({ subject, html, context }) {
  const result = await sendEmail({ to: config.adminEmail, subject, html })
  if (!result.success) {
    log.error('send.failed', { ...context, error: result.error })
  } else {
    log.info('send.success', { ...context, messageId: result.messageId })
  }
  return result
}

// ── 1. NMI Customer Vault Missing or Invalid ────────────────────────────
//
// Fires from payment.service.js's chargeInvoice pre-flight when a stored
// vault/billing id fails validateCustomerVault (vault deleted out-of-band
// on NMI's side, wrong environment's id, etc.) — the charge is skipped
// (a `skipped` PaymentAttempt is recorded) and this is the only signal an
// admin gets that a customer's auto-charge is silently not happening.
export async function notifyNmiVaultInvalid({ invoiceId, shopifyOrderId, vaultId, methodLabel, reason }) {
  const subject = `NMI Vault Invalid — Charge Skipped (Invoice ${invoiceId || 'unknown'})`
  const html = wrapHtml(`
    <p>A scheduled or manual charge attempt was <strong>skipped</strong> because the customer's stored NMI
    ${methodLabel || 'payment'} vault could not be validated. No charge was attempted — this invoice will keep
    being skipped on every future attempt until the vault is fixed or replaced.</p>
    <p><strong>Invoice:</strong> ${invoiceId || 'unknown'}<br/>
    ${shopifyOrderId ? `<strong>Shopify order:</strong> ${shopifyOrderId}<br/>` : ''}
    <strong>NMI vault/billing id:</strong> ${vaultId || 'unknown'}<br/>
    <strong>Method:</strong> ${methodLabel || 'unknown'}</p>
    ${errorDetailsHtml({ message: reason })}
  `)

  return send({ subject, html, context: { event: 'nmi_vault_invalid', invoiceId, vaultId, reason } })
}

// ── 2. NMI Vault Creation Failed During Registration ────────────────────
//
// Fires from the NMI vault-creation catch blocks in
// app/api/registration-form.js — a technical, admin-facing companion to
// the customer-facing notifyApplicationDeclined email (which is
// intentionally vague for the applicant). No account was created and
// nothing was charged on any of these paths.
export async function notifyNmiVaultCreationFailed({ email, businessName, paymentMethod, stage, error }) {
  const subject = `NMI Vault Creation Failed During Registration — ${businessName || email || 'unknown applicant'}`
  const html = wrapHtml(`
    <p>A wholesale registration attempt failed at the NMI payment-vault step. The applicant's registration was
    rejected — no Shopify customer or MongoDB application record was created.</p>
    <p><strong>Applicant:</strong> ${businessName || 'unknown'} (${email || 'unknown'})<br/>
    <strong>Payment method attempted:</strong> ${paymentMethod || 'unknown'}<br/>
    <strong>Failure stage:</strong> ${stage || 'unknown'}</p>
    ${errorDetailsHtml(error)}
  `)

  return send({
    subject,
    html,
    context: { event: 'nmi_vault_creation_failed', email, paymentMethod, stage },
  })
}

// ── 3. NMI Duplicate Transaction Rejected ───────────────────────────────
//
// Fires when NMI's gateway-level duplicate-transaction check rejects a
// charge (responseText matching /duplicate transaction/i). Per this app's
// 2026-06-22 incident (see CLAUDE.md changelog), this is NOT fixable from
// app code — NMI hard-rejects any attempt to override the duplicate
// window/threshold for this processor — so the alert exists purely to
// tell an admin to check the NMI control panel's "Duplicate Transaction
// Checking" setting for the affected MID, not to suggest a code retry.
export async function notifyNmiDuplicateTransaction({ invoiceId, shopifyOrderId, vaultId, amount, responseText, transactionId }) {
  const subject = `NMI Duplicate Transaction Rejected — Invoice ${invoiceId || 'unknown'}`
  const html = wrapHtml(`
    <p>NMI's gateway-level duplicate-transaction check rejected a charge attempt. This is a processor/gateway
    configuration issue, not an application bug — see the "Action required" note below.</p>
    <p><strong>Invoice:</strong> ${invoiceId || 'unknown'}<br/>
    ${shopifyOrderId ? `<strong>Shopify order:</strong> ${shopifyOrderId}<br/>` : ''}
    <strong>NMI vault id:</strong> ${vaultId || 'unknown'}<br/>
    <strong>Amount:</strong> ${amount != null ? `$${Number(amount).toFixed(2)}` : 'unknown'}<br/>
    <strong>NMI transaction id:</strong> ${transactionId || 'none'}</p>
    <p><strong>Action required:</strong> in the NMI control panel, check Settings → Transaction/Security
    Options → "Duplicate Transaction Checking" for this MID — disable it, shorten the window, or key it on
    order id instead of amount+card. This app deliberately does not override NMI's <code>dup_seconds</code>
    setting from code (a prior attempt caused every charge to fail, not just true duplicates).</p>
    ${errorDetailsHtml({ message: responseText })}
  `)

  return send({
    subject,
    html,
    context: { event: 'nmi_duplicate_transaction', invoiceId, transactionId, responseText },
  })
}
