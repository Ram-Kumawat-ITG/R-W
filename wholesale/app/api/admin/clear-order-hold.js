import mongoose from 'mongoose'
import { authenticate } from '../../shopify.server'
import connectDB from '../../services/APIService/mongo.service'
import WholesaleApplication from '../../models/wholesaleApplication.server'
import { sendResponse } from '../../services/APIService/api.service'
import { setCustomerOrderHoldMetafield } from '../../services/shopify/shopify.service'
import { hasOutstandingFailedInvoice } from '../../services/order/orderHold.service'

// POST /api/admin/customers/:id/clear-order-hold
//
// Admin manual override to lift a practitioner's PAYMENT order hold (the
// checkout block from an exhausted/failed invoice) — e.g. the admin has agreed
// to let them order while the invoice is resolved out-of-band. Clears the
// `orderHold` flag AND removes the Shopify customer metafield the checkout
// Function reads, so the block lifts immediately.
//
// NOTE this is an OVERRIDE, not a resolution: it does not change any invoice.
// If an outstanding failed invoice remains, the auto-reconciler may re-apply
// the hold on the next payment event — pay/resolve the invoice to remove it
// permanently. The response flags this via `stillOutstanding`.
//
// Distinct from the admin `Blocked` flow (api/admin/block.js) — that is a
// separate manual block and is untouched here.
export async function action({ request, params }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let session
  try {
    const auth = await authenticate.admin(request)
    session = auth.session
  } catch (e) {
    console.error('[admin/clear-order-hold] auth failed:', e?.message || e)
    return sendResponse(401, 'error', 'Unauthorized', null)
  }

  const { id } = params
  if (!id || !mongoose.isValidObjectId(id)) {
    return sendResponse(400, 'error', 'Invalid customer id', null)
  }

  await connectDB()
  const doc = await WholesaleApplication.findById(id)
  if (!doc) return sendResponse(404, 'error', 'Customer not found', null)
  const shop = doc.shop || session.shop
  const adminEmail = session.onlineAccessInfo?.associated_user?.email || session.shop

  doc.orderHold = false
  doc.orderHoldReason = null
  doc.orderHoldClearedAt = new Date()
  doc.orderHoldClearedBy = adminEmail
  await doc.save()

  // Remove the checkout-block metafield (best-effort — the flag is already off).
  if (doc.customerId) {
    try {
      await setCustomerOrderHoldMetafield({ shop, customerId: doc.customerId, held: false })
    } catch (e) {
      console.error('[admin/clear-order-hold] metafield clear failed:', e?.message || e)
      return sendResponse(502, 'error', `Hold flag cleared, but removing the checkout block failed: ${e?.message || e}`, null)
    }
  }

  const stillOutstanding = doc.email
    ? await hasOutstandingFailedInvoice({ shop, email: doc.email })
    : false

  return sendResponse(200, 'success', 'Order hold cleared', {
    orderHold: false,
    clearedBy: adminEmail,
    stillOutstanding,
  })
}
