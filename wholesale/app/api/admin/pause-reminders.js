import mongoose from 'mongoose'
import { authenticate } from '../../shopify.server'
import connectDB from '../../services/APIService/mongo.service'
import ShopifyOrder from '../../models/order.server'
import Invoice from '../../models/invoice.server'
import { appendInvoiceRemark } from '../../services/invoice/invoice.service'
import { sendResponse } from '../../services/APIService/api.service'

// POST /api/admin/orders/:id/pause-reminders
//
// Sets `Invoice.reminderPaused = true` so the Check-payment reminder CRON
// (services/reminder) skips this invoice — no further automated reminder
// emails (Day 9 / 11 / 13) are sent until an admin resumes. This is the
// server side of the "Pause auto email notifications" control on Order
// Details. It is independent of `autoChargePaused` (which gates the card
// auto-charge sweep, not email reminders).
//
// Body (all optional):
//   { note: string }   — free-text remark stored on the invoice and
//                        echoed into the remarks[] ledger
//
// Gating mirrors the UI: reminders only fire for Check-method invoices,
// so we re-check server-side that this is a cheque invoice — pausing a
// card/ACH invoice would be a silent no-op (the CRON already skips them
// via its `paymentMethod: 'check'` filter).
//
// Idempotent: pausing an already-paused invoice refreshes the
// `reminderPausedAt` / `reminderPausedBy` fields.
export async function action({ request, params }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let session
  try {
    const auth = await authenticate.admin(request)
    session = auth.session
  } catch (e) {
    console.error('[admin/pause-reminders] auth failed:', e?.message || e)
    return sendResponse(401, 'error', 'Unauthorized', null)
  }

  const { id } = params
  if (!id || !mongoose.isValidObjectId(id)) {
    return sendResponse(400, 'error', 'Invalid order id', null)
  }

  // Best-effort JSON body parse — pause requires no payload, so an
  // empty / non-JSON body is fine. Only `note` is honored.
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

  // Cheque-method guard — reminders only run for Check invoices, so a
  // pause flag elsewhere would mislead admins into thinking the invoice
  // behaves differently than its peers when nothing changed.
  if (invoice.paymentMethod !== 'check') {
    return sendResponse(
      409,
      'error',
      `Email reminders only run for cheque invoices (this invoice's method is "${invoice.paymentMethod}")`,
      null,
    )
  }

  // Settled / cancelled invoices already drop out of the reminder sweep.
  if (invoice.paymentStatus === 'paid' || invoice.paymentStatus === 'cancelled') {
    return sendResponse(
      409,
      'error',
      `Invoice is already ${invoice.paymentStatus} — reminders have stopped`,
      null,
    )
  }

  const initiatedBy =
    session.onlineAccessInfo?.associated_user?.email || session.shop

  const wasPaused = invoice.reminderPaused === true
  invoice.reminderPaused = true
  invoice.reminderPausedAt = new Date()
  invoice.reminderPausedBy = initiatedBy
  if (note !== undefined) invoice.reminderPauseNote = note
  await invoice.save()

  console.log(
    `[admin/pause-reminders] shop=${session.shop} order=${order.shopifyOrderId} ` +
      `invoice=${invoice._id} by=${initiatedBy}${wasPaused ? ' (re-pause)' : ''}`,
  )

  const remarkPrefix = wasPaused
    ? 'Email reminders pause refreshed'
    : 'Email reminders paused'
  const remarkMsg = note
    ? `${remarkPrefix} by ${initiatedBy} — ${note}`
    : `${remarkPrefix} by ${initiatedBy}`
  await appendInvoiceRemark(invoice._id, {
    kind: 'admin_action',
    message: remarkMsg,
    source: 'admin',
  })

  return sendResponse(200, 'success', 'Email reminders paused', {
    reminderPaused: invoice.reminderPaused,
    reminderPausedAt: invoice.reminderPausedAt,
    reminderPausedBy: invoice.reminderPausedBy,
    reminderPauseNote: invoice.reminderPauseNote,
    reapplied: wasPaused,
  })
}
