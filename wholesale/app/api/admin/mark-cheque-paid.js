import mongoose from 'mongoose'
import { authenticate } from '../../shopify.server'
import connectDB from '../../services/APIService/mongo.service'
import ShopifyOrder from '../../models/order.server'
import Invoice from '../../models/invoice.server'
import CustomerMap from '../../models/customerMap.server'
import { recordManualPayment } from '../../services/invoice/invoice.service'
import { sendResponse } from '../../services/APIService/api.service'

// POST /api/admin/orders/:id/mark-cheque-paid
//
// Manual cheque-receipt handler. Admin enters a cheque reference (+
// optional amount, defaults to the outstanding balance) and we:
//   1. Append a manualPayments[] ledger entry on the Invoice
//   2. Record a PaymentAttempt with outcome='manual_paid'
//   3. Bump amountPaid, set paidAt + paymentStatus
//   4. Run propagateSuccessfulPayment so QBO records the payment and
//      Shopify marks the order paid (cheque ref flows through as the
//      QBO paymentRef)
//
// Body: { reference: string, amount?: number, receivedAt?: ISO date,
//         kind?: 'cheque'|'ach', note?: string }
//
// Safe to retry: the underlying propagateSuccessfulPayment is idempotent
// per-side. Callers should still wait for the response and surface any
// partial sync errors to the admin.
export async function action({ request, params }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let session
  try {
    const auth = await authenticate.admin(request)
    session = auth.session
  } catch (e) {
    console.error('[admin/mark-cheque-paid] auth failed:', e?.message || e)
    return sendResponse(401, 'error', 'Unauthorized', null)
  }

  const { id } = params
  if (!id || !mongoose.isValidObjectId(id)) {
    return sendResponse(400, 'error', 'Invalid order id', null)
  }

  let body
  try {
    body = await request.json()
  } catch {
    return sendResponse(400, 'error', 'Request body must be valid JSON', null)
  }

  const reference = (body?.reference || '').toString().trim()
  if (!reference) {
    return sendResponse(400, 'error', 'Cheque reference is required', null)
  }
  // Tolerate both 'check' and 'cheque' spellings (case insensitive). The
  // manualPayments ledger stores the canonical 'cheque' value; ACH stays
  // 'ach'. Anything unrecognized falls through to 'cheque' since this
  // endpoint is gated to non-card invoices.
  const rawKind = String(body?.kind || '').trim().toLowerCase()
  const kind = rawKind === 'ach' ? 'ach' : 'cheque'
  const note = body?.note ? String(body.note).slice(0, 500) : undefined
  let receivedAt
  if (body?.receivedAt) {
    const d = new Date(body.receivedAt)
    if (!Number.isFinite(d.getTime())) {
      return sendResponse(400, 'error', 'receivedAt is not a valid date', null)
    }
    receivedAt = d
  }

  await connectDB()

  const order = await ShopifyOrder.findOne({ _id: id, shop: session.shop })
  if (!order) return sendResponse(404, 'error', 'Order not found in this shop', null)
  if (!order.invoiceRef) {
    return sendResponse(409, 'error', 'No invoice exists for this order yet', null)
  }

  const invoice = await Invoice.findById(order.invoiceRef)
  if (!invoice) return sendResponse(409, 'error', 'Linked invoice record is missing', null)

  // Only cheque / ACH invoices use this endpoint. Card invoices have a
  // different action (the existing retry-payment endpoint).
  if (invoice.paymentMethod === 'card') {
    return sendResponse(
      409,
      'error',
      'Invoice payment method is "card" — use Retry payment instead of Mark cheque paid',
      null,
    )
  }

  const customerMap = order.customerEmail
    ? await CustomerMap.findOne({ shop: session.shop, email: order.customerEmail })
    : null
  if (!customerMap) {
    return sendResponse(409, 'error', 'Customer mapping missing — cannot record QBO payment', null)
  }

  const amountRaw = body?.amount
  const parsedAmount =
    amountRaw === undefined || amountRaw === null || amountRaw === ''
      ? undefined
      : Number(amountRaw)
  if (parsedAmount !== undefined && (!Number.isFinite(parsedAmount) || parsedAmount <= 0)) {
    return sendResponse(400, 'error', 'amount must be a positive number', null)
  }

  console.log(
    `[admin/mark-cheque-paid] shop=${session.shop} order=${order.shopifyOrderId} ` +
      `invoice=${invoice._id} kind=${kind} ref="${reference}" amount=${parsedAmount ?? '(outstanding)'}`,
  )

  let result
  try {
    result = await recordManualPayment({
      invoice,
      customerMap,
      kind,
      reference,
      amount: parsedAmount,
      receivedAt,
      recordedBy: session?.onlineAccessInfo?.associated_user?.email || session?.shop || undefined,
      note,
    })
  } catch (e) {
    console.error('[admin/mark-cheque-paid] recordManualPayment threw:', e?.message || e)
    // Validation errors thrown from recordManualPayment map to 400.
    const isValidation =
      /already (paid|cancelled)|in progress|exceeds outstanding|positive number|reference is required/i.test(
        e?.message || '',
      )
    return sendResponse(
      isValidation ? 400 : 500,
      'error',
      e?.message || 'Failed to record cheque payment',
      null,
    )
  }

  return sendResponse(200, 'success', 'Cheque payment recorded', {
    paymentStatus: result.invoice.paymentStatus,
    amountPaid: result.invoice.amountPaid,
    amountDue: result.invoice.amountDue,
    paidAt: result.invoice.paidAt,
    reference,
    kind,
    syncErrors: result.syncErrors || [],
  })
}
