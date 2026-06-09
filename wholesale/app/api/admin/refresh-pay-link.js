import mongoose from 'mongoose'
import { authenticate } from '../../shopify.server'
import connectDB from '../../services/APIService/mongo.service'
import ShopifyOrder from '../../models/order.server'
import Invoice from '../../models/invoice.server'
import { refreshImmediatePayLink } from '../../services/payment/payLink.service'
import { appendInvoiceRemark } from '../../services/invoice/invoice.service'
import { sendResponse } from '../../services/APIService/api.service'

// POST /api/admin/orders/:id/refresh-pay-link
//
// "Refresh payment link" button on the Order Details page (Immediate Payment
// invoices). Re-stamps the QBO invoice CustomerMemo with the pay link built
// from the CURRENT configured base URL (PAY_LINK_BASE_URL / SHOPIFY_APP_URL).
//
// Why this exists: the link is baked into the QBO invoice at creation, frozen
// at whatever the app's public URL was then. In dev, `shopify app dev` rotates
// the trycloudflare tunnel on every restart, so previously-issued links point
// at a dead host. This endpoint rewrites the memo to the live URL (the token
// — and thus the /pay/<token> path — never changes).
export async function action({ request, params }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let session
  try {
    const auth = await authenticate.admin(request)
    session = auth.session
  } catch (e) {
    console.error('[admin/refresh-pay-link] auth failed:', e?.message || e)
    return sendResponse(401, 'error', 'Unauthorized', null)
  }

  const { id } = params
  if (!id || !mongoose.isValidObjectId(id)) {
    return sendResponse(400, 'error', 'Invalid order id', null)
  }

  await connectDB()

  const order = await ShopifyOrder.findOne({ _id: id, shop: session.shop })
  if (!order) return sendResponse(404, 'error', 'Order not found in this shop', null)
  if (!order.invoiceRef) {
    return sendResponse(409, 'error', 'No invoice exists for this order yet', null)
  }

  const invoice = await Invoice.findById(order.invoiceRef)
  if (!invoice) return sendResponse(409, 'error', 'Linked invoice record is missing', null)
  if (invoice.paymentMethod !== 'immediate') {
    return sendResponse(409, 'error', 'This invoice is not an Immediate Payment invoice', null)
  }
  if (!invoice.qboInvoiceId) {
    return sendResponse(409, 'error', 'QBO invoice not created yet', null)
  }

  const initiatedBy = session.onlineAccessInfo?.associated_user?.email || session.shop

  let payLinkUrl
  try {
    payLinkUrl = await refreshImmediatePayLink(invoice)
  } catch (e) {
    console.error('[admin/refresh-pay-link] refresh failed:', e?.message || e)
    return sendResponse(502, 'error', e?.message || 'Failed to refresh the payment link', null)
  }

  await appendInvoiceRemark(invoice._id, {
    kind: 'admin_action',
    message: `Payment link refreshed by ${initiatedBy}`,
    source: 'admin',
  })

  return sendResponse(200, 'success', 'Payment link refreshed', { payLinkUrl })
}
