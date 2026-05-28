import mongoose from 'mongoose'
import { authenticate } from '../../shopify.server'
import connectDB from '../../services/APIService/mongo.service'
import ShopifyOrder from '../../models/order.server'
import Invoice from '../../models/invoice.server'
import { appendInvoiceRemark } from '../../services/invoice/invoice.service'
import { sendResponse } from '../../services/APIService/api.service'

// POST /api/admin/orders/:id/pause-auto-charge
//
// Sets `Invoice.autoChargePaused = true` so the CRON scheduler's PASS 1
// (card charge) and PASS 1.5 (cheque/ACH reminder) sweeps skip this
// invoice. Admin settlement actions (Retry payment / Charge card on
// file / Mark cheque paid) remain available — pause is CRON-only.
//
// Body (all optional):
//   { note: string }   — free-text remark stored on the invoice and
//                        echoed into the remarks[] ledger
//
// Gating mirrors the UI: the button is only surfaced for invoices whose
// `customerPaymentPreference === 'card'`, but we re-check server-side
// here so an out-of-band POST can't pause a cheque/ACH invoice (where
// pausing would be a silent no-op since PASS 1 already skips them).
//
// Idempotent: pausing an already-paused invoice refreshes the
// `autoChargePausedAt` / `autoChargePausedBy` fields but does not
// duplicate the remarks ledger entry's effect (one append per call —
// the caller decides whether to retry).
export async function action({ request, params }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let session
  try {
    const auth = await authenticate.admin(request)
    session = auth.session
  } catch (e) {
    console.error('[admin/pause-auto-charge] auth failed:', e?.message || e)
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

  // Card-preference guard — same condition the UI uses to render the
  // Pause button. Cheque/ACH invoices are already skipped by CRON; a
  // pause flag there would mislead admins into thinking the invoice is
  // doing something different than its peers when nothing changed.
  const preference = invoice.customerPaymentPreference || invoice.paymentMethod
  if (preference !== 'card') {
    return sendResponse(
      409,
      'error',
      `Auto-charge pause is only available for card-preferred invoices (this invoice's preference is "${preference}")`,
      null,
    )
  }

  // Settled / cancelled invoices have nothing to pause.
  if (invoice.paymentStatus === 'paid' || invoice.paymentStatus === 'cancelled') {
    return sendResponse(
      409,
      'error',
      `Invoice is already ${invoice.paymentStatus} — nothing to pause`,
      null,
    )
  }

  const initiatedBy =
    session.onlineAccessInfo?.associated_user?.email || session.shop

  const wasPaused = invoice.autoChargePaused === true
  invoice.autoChargePaused = true
  invoice.autoChargePausedAt = new Date()
  invoice.autoChargePausedBy = initiatedBy
  if (note !== undefined) invoice.autoChargePauseNote = note
  await invoice.save()

  console.log(
    `[admin/pause-auto-charge] shop=${session.shop} order=${order.shopifyOrderId} ` +
      `invoice=${invoice._id} by=${initiatedBy}${wasPaused ? ' (re-pause)' : ''}`,
  )

  const remarkPrefix = wasPaused
    ? 'Auto-charge pause refreshed'
    : 'Auto-charge paused'
  const remarkMsg = note
    ? `${remarkPrefix} by ${initiatedBy} — ${note}`
    : `${remarkPrefix} by ${initiatedBy}`
  await appendInvoiceRemark(invoice._id, {
    kind: 'admin_action',
    message: remarkMsg,
    source: 'admin',
  })

  return sendResponse(200, 'success', 'Auto-charge paused', {
    autoChargePaused: invoice.autoChargePaused,
    autoChargePausedAt: invoice.autoChargePausedAt,
    autoChargePausedBy: invoice.autoChargePausedBy,
    autoChargePauseNote: invoice.autoChargePauseNote,
    reapplied: wasPaused,
  })
}
