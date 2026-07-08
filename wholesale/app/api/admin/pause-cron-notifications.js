import { authenticate } from '../../shopify.server'
import { pauseEmailNotifications } from '../../services/scheduler/cronNotificationSettings.service'
import { sendResponse } from '../../services/APIService/api.service'

// POST /api/admin/cron-notifications/pause
//
// Global (not per-invoice) — pauses BOTH the customer "Payment Failed"
// email and the admin "Batch Processing Summary" email sent by the
// process-pending-payments CRON. Charge processing itself is completely
// unaffected; only these two emails are silenced.
//
// Body (all optional):
//   { note: string }   — free-text reason, stored on the singleton doc
//
// Idempotent: pausing an already-paused state refreshes the timestamp/by
// fields and reports `reapplied: true`.
export async function action({ request }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let session
  try {
    const auth = await authenticate.admin(request)
    session = auth.session
  } catch (e) {
    console.error('[admin/pause-cron-notifications] auth failed:', e?.message || e)
    return sendResponse(401, 'error', 'Unauthorized', null)
  }

  let note
  try {
    const body = await request.clone().json()
    if (body?.note != null) {
      note = String(body.note).slice(0, 500).trim() || undefined
    }
  } catch {
    // No body / non-JSON body = no note.
  }

  const initiatedBy = session.onlineAccessInfo?.associated_user?.email || session.shop
  const settings = await pauseEmailNotifications({ by: initiatedBy, note })

  console.log(`[admin/pause-cron-notifications] shop=${session.shop} by=${initiatedBy}`)

  return sendResponse(200, 'success', 'CRON email notifications paused', settings)
}

export async function loader() {
  return sendResponse(405, 'error', 'Method not allowed', null)
}
