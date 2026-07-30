// Admin-only critical alert emails for the QBO/accounting integration.
// Same SMTP utility (services/email/email.service.sendEmail) and
// best-effort-never-throws convention as every other notification module
// in this app — an alert-send failure must never make the underlying QBO
// failure worse by throwing a second error on top of it.
//
// Unlike applicationLifecycleNotification / accountNotification, these
// have NO customer recipient — `to` is the admin address, no `cc`.

import { enqueueEmail } from '../email/emailQueue.service'
import { qboAlertNotificationConfig as config } from './qboAlertNotification.config'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('qboAlertNotification')

function wrapHtml(bodyHtml) {
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.5">
      ${bodyHtml}
      <p style="margin-top:24px;color:#6b6b6b;font-size:12px">Natural Solutions Wholesale — automated system alert</p>
    </div>
  `
}

// Renders an error's message + stack + any structured `.status`/`.body`
// captured by PermanentError/TransientError (app/utils/retry.utils.js) as
// a preformatted troubleshooting block. Never throws on a malformed error.
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

// ── 1. QBO OAuth Token Refresh Failed (critical — blocks all invoicing) ─
//
// Fires when Intuit rejects the refresh_token grant (expired/revoked —
// see qbo.apis.js:88's PermanentError) or when there's no stored/seedable
// token at all. Every QBO call in this app goes through getAccessToken(),
// so this is a hard stop for invoicing, payment sync, and customer sync
// until an admin re-authorizes the QBO connection.
export async function notifyQboTokenRefreshFailed({ error, realmId }) {
  const subject = '🚨 CRITICAL: QuickBooks Token Refresh Failed — Invoicing Blocked'
  const html = wrapHtml(`
    <p style="color:#b00020;font-weight:bold;font-size:16px">QuickBooks Online OAuth token refresh failed.</p>
    <p>Every QBO operation (invoice creation, customer sync, payment recording) will fail until this is resolved. <strong>This is a critical, complete blocker for all invoicing.</strong></p>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">
      <tbody>
        <tr><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Field</th><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Value</th></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Realm ID</td><td style="padding:8px;border:1px solid #ddd"><code style="background:#f4f4f4;padding:2px 4px">${realmId || '—'}</code></td></tr>
      </tbody>
    </table>
    <p style="margin-top:16px;color:#d9534f;font-weight:bold">Admin action required immediately:</p>
    <ol>
      <li>Open the Natural Solutions QBO app authorization in QuickBooks Online</li>
      <li>Re-authorize the connection using Intuit OAuth</li>
      <li>Update the stored refresh token with the new credentials</li>
    </ol>
    <p style="margin-top:12px"><strong>Error details:</strong></p>
    ${errorDetailsHtml(error)}
  `)

  return send({ subject, html, context: { event: 'qbo_token_refresh_failed', realmId } })
}

// ── 2. QBO Invoice Creation Permanently Failed ──────────────────────────
//
// Fires from invoice.service.js's createInvoiceForOrder catch block, once
// the QBO POST has already exhausted qboRequest's internal transient
// retries (or thrown a PermanentError outright) — by the time this fires
// the failure is final; no automatic retry job revisits it.
export async function notifyQboInvoiceCreationFailed({ shop, shopifyOrderId, orderName, customerEmail, error }) {
  const subject = `QBO Invoice Creation Failed — Order ${orderName || shopifyOrderId}`
  const html = wrapHtml(`
    <p>QuickBooks invoice creation permanently failed for a Shopify order. <strong>No invoice was created</strong> and the customer has not been billed. No automatic retry will happen — this needs manual attention.</p>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">
      <tbody>
        <tr><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Field</th><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Value</th></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Shop</td><td style="padding:8px;border:1px solid #ddd">${shop || '—'}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Order</td><td style="padding:8px;border:1px solid #ddd">${orderName || '—'} (${shopifyOrderId || '—'})</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Customer</td><td style="padding:8px;border:1px solid #ddd">${customerEmail || '—'}</td></tr>
      </tbody>
    </table>
    <p style="margin-top:16px;color:#d9534f"><strong>Admin action:</strong> Review the error details and manually create the invoice in QuickBooks Online.</p>
    <p style="margin-top:12px"><strong>Error details:</strong></p>
    ${errorDetailsHtml(error)}
  `)

  return send({
    subject,
    html,
    context: { event: 'qbo_invoice_creation_failed', shop, shopifyOrderId, orderName },
  })
}

// ── 3. QBO Customer Synchronization Failed ──────────────────────────────
//
// Fires when findOrCreateCustomer (via ensureCustomerForOrder /
// ensureDropshipCustomerMap) fails to find-or-create the QBO Customer
// record for a wholesale/drop-ship order. This aborts the whole order's
// processing (customer.service.js has no catch of its own — it propagates
// to order.service.js's outer catch), so invoicing never even starts.
export async function notifyQboCustomerSyncFailed({ shop, email, businessName, shopifyOrderId, error }) {
  const subject = `QBO Customer Sync Failed — ${businessName || email || 'unknown customer'}`
  const html = wrapHtml(`
    <p>Failed to find-or-create the QuickBooks Customer record needed to invoice this order. <strong>Order processing was aborted</strong> — no invoice was created.</p>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">
      <tbody>
        <tr><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Field</th><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Value</th></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Shop</td><td style="padding:8px;border:1px solid #ddd">${shop || '—'}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Customer</td><td style="padding:8px;border:1px solid #ddd">${businessName || '—'} (${email || '—'})</td></tr>
        ${shopifyOrderId ? `<tr><td style="padding:8px;border:1px solid #ddd">Shopify order</td><td style="padding:8px;border:1px solid #ddd">${shopifyOrderId}</td></tr>` : ''}
      </tbody>
    </table>
    <p style="margin-top:16px;color:#d9534f"><strong>Admin action:</strong> Review the error details and either create the customer manually in QuickBooks or investigate the sync configuration.</p>
    <p style="margin-top:12px"><strong>Error details:</strong></p>
    ${errorDetailsHtml(error)}
  `)

  return send({
    subject,
    html,
    context: { event: 'qbo_customer_sync_failed', shop, email, shopifyOrderId },
  })
}
