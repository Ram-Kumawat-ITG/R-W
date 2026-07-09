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

import { sendEmail } from '../email/email.service'
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
  const result = await sendEmail({ to: config.adminEmail, subject, html })
  if (!result.success) {
    log.error('send.failed', { ...context, error: result.error })
  } else {
    log.info('send.success', { ...context, messageId: result.messageId })
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
    <p style="color:#b00020;font-weight:bold">Syncing a drop-ship order's fulfillment status to the retail store failed.</p>
    <p>The retail customer's order will NOT reflect this ${event === 'cancelled' ? 'cancellation' : 'fulfillment/shipping'}
    update until the sync succeeds. This is best-effort and will retry automatically on the next fulfillment event or
    the resync CRON — no immediate action is required unless the error below persists.</p>
    <p>
      <strong>Wholesale order:</strong> ${wholesaleOrderName || 'unknown'} (${wholesaleOrderId || 'unknown'})<br/>
      <strong>Linked retail order:</strong> ${retailOrderName || retailOrderId || 'unknown'}<br/>
      <strong>Event:</strong> ${event || 'unknown'}<br/>
      <strong>Fulfillment status:</strong> ${fulfillmentStatus || 'unknown'}<br/>
      ${attempts != null ? `<strong>Sync attempts so far:</strong> ${attempts}<br/>` : ''}
    </p>
    <p><strong>Failure reason:</strong> ${reason || 'unknown'}</p>
    <pre style="background:#f4f4f4;padding:12px;border-radius:4px;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere">${error || 'no error detail captured'}</pre>
  `)

  return send({
    subject,
    html,
    context: { event: 'fulfillment_sync_failed', wholesaleOrderId, retailOrderId, reason },
  })
}
