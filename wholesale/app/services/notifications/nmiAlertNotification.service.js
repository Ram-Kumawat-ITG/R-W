// Admin-only critical alert emails for NMI payment processing / customer
// vaults. Same SMTP utility + admin-only (no cc) + best-effort-never-throws
// convention as qboAlertNotification.service.js — read that file's header
// comment for the full rationale; not repeated here.

import { enqueueEmail } from '../email/emailQueue.service'
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
  const result = await enqueueEmail({ to: config.adminEmail, subject, html }, { label: context?.event })
  if (!result.success) {
    log.error('send.failed', { ...context, error: result.error })
  } else {
    log.info('send.queued', { ...context })
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
    <p>A scheduled or manual charge attempt was <strong>skipped</strong> because the customer's stored NMI payment vault could not be validated. <strong>No charge was attempted.</strong> This invoice will continue to be skipped on every future attempt until the vault is fixed or replaced.</p>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">
      <tbody>
        <tr><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Field</th><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Value</th></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Invoice ID</td><td style="padding:8px;border:1px solid #ddd"><strong>${invoiceId || '—'}</strong></td></tr>
        ${shopifyOrderId ? `<tr><td style="padding:8px;border:1px solid #ddd">Shopify order</td><td style="padding:8px;border:1px solid #ddd">${shopifyOrderId}</td></tr>` : ''}
        <tr><td style="padding:8px;border:1px solid #ddd">NMI vault ID</td><td style="padding:8px;border:1px solid #ddd"><code style="background:#f4f4f4;padding:2px 4px">${vaultId || '—'}</code></td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Payment method</td><td style="padding:8px;border:1px solid #ddd">${methodLabel || '—'}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Reason</td><td style="padding:8px;border:1px solid #ddd">${reason || '—'}</td></tr>
      </tbody>
    </table>
    <p style="margin-top:16px;color:#d9534f"><strong>Action:</strong> Review the vault error and either fix the stored payment method or remove this customer's auto-charge configuration.</p>
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
  const subject = `NMI Vault Creation Failed — Registration Rejected`
  const html = wrapHtml(`
    <p>A wholesale registration attempt failed at the NMI payment-vault step. <strong>The applicant's registration was rejected</strong> — no Shopify customer or MongoDB application record was created.</p>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">
      <tbody>
        <tr><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Field</th><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Value</th></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Applicant</td><td style="padding:8px;border:1px solid #ddd">${businessName || email || '—'}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Email</td><td style="padding:8px;border:1px solid #ddd">${email || '—'}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Payment method attempted</td><td style="padding:8px;border:1px solid #ddd">${paymentMethod || '—'}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Failure stage</td><td style="padding:8px;border:1px solid #ddd">${stage || '—'}</td></tr>
      </tbody>
    </table>
    <p style="margin-top:16px;color:#d9534f"><strong>Error details:</strong></p>
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
    <p>NMI's gateway-level duplicate-transaction check rejected a charge attempt. This is a <strong>processor/gateway configuration issue</strong>, not an application bug.</p>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">
      <tbody>
        <tr><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Field</th><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Value</th></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Invoice ID</td><td style="padding:8px;border:1px solid #ddd"><strong>${invoiceId || '—'}</strong></td></tr>
        ${shopifyOrderId ? `<tr><td style="padding:8px;border:1px solid #ddd">Shopify order</td><td style="padding:8px;border:1px solid #ddd">${shopifyOrderId}</td></tr>` : ''}
        <tr><td style="padding:8px;border:1px solid #ddd">NMI vault ID</td><td style="padding:8px;border:1px solid #ddd"><code style="background:#f4f4f4;padding:2px 4px">${vaultId || '—'}</code></td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Amount</td><td style="padding:8px;border:1px solid #ddd">${amount != null ? `$${Number(amount).toFixed(2)}` : '—'}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">NMI transaction ID</td><td style="padding:8px;border:1px solid #ddd"><code style="background:#f4f4f4;padding:2px 4px">${transactionId || 'none'}</code></td></tr>
      </tbody>
    </table>
    <p style="margin-top:16px;color:#d9534f"><strong>Admin action required:</strong></p>
    <p>In the NMI control panel, navigate to <strong>Settings → Transaction/Security Options → "Duplicate Transaction Checking"</strong> for this MID. Either:</p>
    <ul>
      <li>Disable duplicate transaction checking, OR</li>
      <li>Shorten the duplicate window, OR</li>
      <li>Use order ID as the deduplication key instead of amount + card</li>
    </ul>
    <p style="font-size:12px;color:#6b6b6b">Note: This application deliberately does not override NMI's <code>dup_seconds</code> setting from code, as doing so caused cascading charge failures.</p>
    <p style="margin-top:12px"><strong>Gateway response:</strong></p>
    ${errorDetailsHtml({ message: responseText })}
  `)

  return send({
    subject,
    html,
    context: { event: 'nmi_duplicate_transaction', invoiceId, transactionId, responseText },
  })
}
