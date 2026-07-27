// Admin-only alert email for the Wholesale → Retail drop-ship fulfillment
// mirror (services/sync/fulfillmentSync.service.notifyRetailOfDropshipChange).
// Same SMTP utility (services/email/email.service.sendEmail) and
// best-effort-never-throws convention as every other notification module in
// this app — an alert-send failure must never make the underlying sync
// failure worse by throwing a second error on top of it. Fires on BOTH
// failure modes that function already tracks (network failure reaching
// ns-retail, and a non-2xx HTTP response from it) — never on a successful
// or skipped (unchanged-signature) sync.
//
// No customer recipient — `to` is the admin address, no `cc` (same shape as
// qboAlertNotification / nmiAlertNotification).

import { enqueueEmail } from '../email/emailQueue.service'
import { fulfillmentSyncNotificationConfig as config } from './fulfillmentSyncNotification.config'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('fulfillmentSyncNotification')

function wrapHtml(bodyHtml) {
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.5">
      ${bodyHtml}
      <p style="margin-top:24px;color:#6b6b6b;font-size:12px">Natural Solutions Wholesale — automated system alert</p>
    </div>
  `
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

// Drop-ship Fulfillment Sync to Retail Store Failed.
//
//   event              'fulfillment' | 'cancelled' — which mirror this was
//   wholesaleOrderId   the wholesale ShopifyOrder's id
//   wholesaleOrderName order # on the wholesale store (e.g. "#1287")
//   retailOrderId      the linked retail order id (from the DropshipMapping)
//   retailOrderName    order # on the retail store, when known
//   fulfillmentStatus  the wholesale order's current fulfillment status
//   reason             'network' | 'http' | 'unhandled' — the failure mode
//   error              the error message / HTTP status detail captured by
//                       notifyRetailOfDropshipChange
//   attempts           how many times this mapping has attempted this sync
export async function notifyFulfillmentSyncFailed({
  event,
  wholesaleOrderId,
  wholesaleOrderName,
  retailOrderId,
  retailOrderName,
  fulfillmentStatus,
  reason,
  error,
  attempts,
}) {
  const subject = `Drop-ship Fulfillment Sync to Retail Store Failed — Order ${wholesaleOrderName || wholesaleOrderId}`
  const html = wrapHtml(`
    <p style="color:#b00020;font-weight:bold;font-size:16px">Drop-ship order fulfillment sync to retail store failed.</p>
    <p>The retail customer's order will NOT reflect this ${event === 'cancelled' ? 'cancellation' : 'fulfillment/shipping'} update until the sync succeeds. This is best-effort and will retry automatically on the next fulfillment event or the resync CRON.</p>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">
      <tbody>
        <tr><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Field</th><th style="text-align:left;padding:8px;border:1px solid #ddd;background:#f4f4f4">Value</th></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Wholesale order</td><td style="padding:8px;border:1px solid #ddd">${wholesaleOrderName || '—'} (${wholesaleOrderId || '—'})</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Linked retail order</td><td style="padding:8px;border:1px solid #ddd">${retailOrderName || retailOrderId || '—'}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Event type</td><td style="padding:8px;border:1px solid #ddd">${event || '—'}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Fulfillment status</td><td style="padding:8px;border:1px solid #ddd">${fulfillmentStatus || '—'}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd">Failure reason</td><td style="padding:8px;border:1px solid #ddd"><strong style="color:#d9534f">${reason || '—'}</strong></td></tr>
        ${attempts != null ? `<tr><td style="padding:8px;border:1px solid #ddd">Sync attempts</td><td style="padding:8px;border:1px solid #ddd">${attempts}</td></tr>` : ''}
      </tbody>
    </table>
    <p style="margin-top:16px"><strong>Error detail:</strong></p>
    <pre style="background:#f4f4f4;padding:12px;border-radius:4px;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere">${error || 'no error detail captured'}</pre>
  `)

  return send({
    subject,
    html,
    context: { event: 'fulfillment_sync_failed', wholesaleOrderId, retailOrderId, reason },
  })
}
