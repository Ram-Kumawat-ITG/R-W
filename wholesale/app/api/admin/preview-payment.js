import mongoose from 'mongoose'
import { authenticate } from '../../shopify.server'
import connectDB from '../../services/APIService/mongo.service'
import ShopifyOrder from '../../models/order.server'
import Invoice from '../../models/invoice.server'
import CustomerMap from '../../models/customerMap.server'
import { sendResponse } from '../../services/APIService/api.service'
import { invoiceConfig } from '../../services/invoice/invoice.config'
import { computeProcessingFee, effectiveFeeRates, processingFeeLabel } from '../../services/invoice/invoice.utils'

// POST /api/admin/orders/:id/preview-payment
//
// Read-only preview of what an invoice will look like when settled via a
// given payment method. Powers the "confirm before charge" flow required
// when the admin is about to change the payment method on an invoice —
// the UI calls this to show the new total (base + per-method fee) before
// the actual charge / receipt is recorded.
//
// Body: { method: 'card' | 'ach' | 'check' }
//
// Response: {
//   method, baseAmount, feeAmount, feeRate, feeLabel, newTotal,
//   currentAmountDue, alreadyPaid, currency, processingFeeAlreadyApplied
// }
//
// No QBO writes, no DB writes — purely informational. The actual fee is
// applied to the QBO invoice only when the admin confirms via the
// existing settle endpoints (retry-payment / charge-card / mark-cheque-paid).
export async function action({ request, params }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let session
  try {
    const auth = await authenticate.admin(request)
    session = auth.session
  } catch (e) {
    console.error('[admin/preview-payment] auth failed:', e?.message || e)
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
    return sendResponse(400, 'error', 'Invalid JSON body', null)
  }
  const method = body?.method
  if (!['card', 'ach', 'check'].includes(method)) {
    return sendResponse(400, 'error', 'method must be one of: card, ach, check', null)
  }

  await connectDB()

  const order = await ShopifyOrder.findOne({ _id: id, shop: session.shop })
  if (!order) return sendResponse(404, 'error', 'Order not found in this shop', null)
  if (!order.invoiceRef) {
    return sendResponse(409, 'error', 'No invoice exists for this order yet', null)
  }
  const invoice = await Invoice.findById(order.invoiceRef)
  if (!invoice) return sendResponse(409, 'error', 'Linked invoice record is missing', null)

  // Base = remaining balance on the invoice. If a fee was already
  // applied on a prior settlement attempt, the current amountDue
  // already includes it and no additional fee should be quoted.
  const alreadyApplied = Boolean(invoice.processingFeeAppliedAt)
  const currentAmountDue = Number((invoice.amountDue ?? 0).toFixed(2))
  const alreadyPaid = Number((invoice.amountPaid ?? 0).toFixed(2))
  const baseAmount = Number((currentAmountDue - alreadyPaid).toFixed(2))

  // Apply this practitioner's CARD-fee override (card-only) so the quote
  // matches what will actually be charged. Read from the mirrored customer map.
  const customerMap = invoice.customerEmail
    ? await CustomerMap.findOne({ shop: session.shop, email: invoice.customerEmail }).select('cardFeeOverridePercent').lean()
    : null
  const rates = effectiveFeeRates(invoiceConfig.processingFeeRates, customerMap?.cardFeeOverridePercent)

  const fee = alreadyApplied
    ? null
    : computeProcessingFee({
        baseAmount,
        method,
        rates,
      })

  const feeAmount = fee ? fee.amount : 0
  const feeRate = fee ? fee.rate : rates?.[method] || 0
  const newTotal = Number((baseAmount + feeAmount).toFixed(2))

  return sendResponse(200, 'success', 'Preview computed', {
    method,
    feeRate,
    feeAmount,
    feeLabel: processingFeeLabel(method),
    baseAmount,
    newTotal,
    currency: invoice.currency,
    currentAmountDue,
    alreadyPaid,
    processingFeeAlreadyApplied: alreadyApplied,
  })
}
