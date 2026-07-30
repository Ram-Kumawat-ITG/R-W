import { authenticate } from '../../shopify.server'
import { resumeEmailNotifications } from '../../services/scheduler/cronNotificationSettings.service'
import { sendResponse } from '../../services/APIService/api.service'

// POST /api/admin/cron-notifications/resume
//
// Symmetric counterpart to pause-cron-notifications.js — clears the
// global pause flag so the next process-pending-payments tick's emails
// (customer "Payment Failed" + admin "Batch Processing Summary") send
// again. No immediate email is triggered by resuming.
export async function action({ request }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let session
  try {
    const auth = await authenticate.admin(request)
    session = auth.session
  } catch (e) {
    console.error('[admin/resume-cron-notifications] auth failed:', e?.message || e)
    return sendResponse(401, 'error', 'Unauthorized', null)
  }

  const initiatedBy = session.onlineAccessInfo?.associated_user?.email || session.shop
  const settings = await resumeEmailNotifications({ by: initiatedBy })

  console.log(`[admin/resume-cron-notifications] shop=${session.shop} by=${initiatedBy}`)

  return sendResponse(200, 'success', 'CRON email notifications resumed', settings)
}

export async function loader() {
  return sendResponse(405, 'error', 'Method not allowed', null)
}
