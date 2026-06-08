import mongoose from 'mongoose'
import { authenticate } from '../../shopify.server'
import connectDB from '../../services/APIService/mongo.service'
import ShopifyOrder from '../../models/order.server'
import Invoice from '../../models/invoice.server'
import { appendInvoiceRemark } from '../../services/invoice/invoice.service'
import { sendResponse } from '../../services/APIService/api.service'

// POST /api/admin/orders/:id/resume-reminders
//
// Clears the `Invoice.reminderPaused` flag so the Check-payment reminder
// CRON includes the invoice again on the next run. Symmetric counterpart
// to pause-reminders.js — see that file for the broader rationale.
//
// Body (all optional):
//   { note: string }   — free-text remark appended to remarks[]
//
// Idempotent: resuming an already-resumed invoice just refreshes the
// `reminderResumeAt` / `reminderResumedBy` timestamps. The pause-side
// fields (`reminderPausedAt` / `reminderPausedBy` / `reminderPauseNote`)
// are preserved as the "last paused" audit trail.
//
// Resume does NOT send a reminder immediately — the invoice just becomes
// eligible for the next CRON run, which then evaluates the ladder.
export async function action({ request, params }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let session
  try {
    const auth = await authenticate.admin(request)
    session = auth.session
  } catch (e) {
    console.error('[admin/resume-reminders] auth failed:', e?.message || e)
    return sendResponse(401, 'error', 'Unauthorized', null)
  }

  const { id } = params
  if (!id || !mongoose.isValidObjectId(id)) {
    return sendResponse(400, 'error', 'Invalid order id', null)
  }

  let note
  try {
    const body = await request.clone().json()
    if (body?.note != null) {
      note = String(body.note).slice(0, 500).trim() || undefined
    }
  } catch {
    // No body / non-JSON body = no remark.
  }

  await connectDB()

  const order = await ShopifyOrder.findOne({ _id: id, shop: session.shop })
  if (!order) return sendResponse(404, 'error', 'Order not found in this shop', null)
  if (!order.invoiceRef) {
    return sendResponse(409, 'error', 'No invoice exists for this order yet', null)
  }

  const invoice = await Invoice.findById(order.invoiceRef)
  if (!invoice) return sendResponse(409, 'error', 'Linked invoice record is missing', null)

  // No guard against resume-when-not-paused — the operation is a no-op in
  // that state, but we still refresh the resume timestamp so the audit
  // trail captures the admin's intent.
  const wasPaused = invoice.reminderPaused === true

  const initiatedBy =
    session.onlineAccessInfo?.associated_user?.email || session.shop

  invoice.reminderPaused = false
  invoice.reminderResumeAt = new Date()
  invoice.reminderResumedBy = initiatedBy
  await invoice.save()

  console.log(
    `[admin/resume-reminders] shop=${session.shop} order=${order.shopifyOrderId} ` +
      `invoice=${invoice._id} by=${initiatedBy}${wasPaused ? '' : ' (was already running)'}`,
  )

  const remarkPrefix = wasPaused
    ? 'Email reminders resumed'
    : 'Email reminders resume confirmed (were already running)'
  const remarkMsg = note
    ? `${remarkPrefix} by ${initiatedBy} — ${note}`
    : `${remarkPrefix} by ${initiatedBy}`
  await appendInvoiceRemark(invoice._id, {
    kind: 'admin_action',
    message: remarkMsg,
    source: 'admin',
  })

  return sendResponse(200, 'success', 'Email reminders resumed', {
    reminderPaused: invoice.reminderPaused,
    reminderResumeAt: invoice.reminderResumeAt,
    reminderResumedBy: invoice.reminderResumedBy,
    wasAlreadyRunning: !wasPaused,
  })
}
