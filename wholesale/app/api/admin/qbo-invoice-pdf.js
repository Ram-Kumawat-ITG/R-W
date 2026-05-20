import mongoose from 'mongoose'
import { authenticate } from '../../shopify.server'
import connectDB from '../../services/APIService/mongo.service'
import ShopifyOrder from '../../models/order.server'
import Invoice from '../../models/invoice.server'
import { getInvoicePdf } from '../../services/qbo/qbo.service'
import { sendResponse } from '../../services/APIService/api.service'

// POST /api/admin/orders/:id/qbo-invoice-pdf
//
// Proxies the QBO `GET /invoice/:id/pdf` endpoint so the admin can view
// the rendered invoice document inside our app without holding QBO
// credentials. We hold the OAuth token; the admin doesn't.
//
// Returns the PDF as base64 inside the standard `{ status, message, result }`
// envelope so the fetcher-driven UI can convert it to a blob URL and
// open it in a new tab. (We can't reliably return a raw binary Response
// here because fetcher.submit auto-parses the body as JSON — the
// base64-in-JSON shape keeps the same auth + transport path as every
// other admin action endpoint in this app.)
export async function action({ request, params }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let session
  try {
    const auth = await authenticate.admin(request)
    session = auth.session
  } catch (e) {
    console.error('[admin/qbo-invoice-pdf] auth failed:', e?.message || e)
    return sendResponse(401, 'error', 'Unauthorized', null)
  }

  const { id } = params
  if (!id || !mongoose.isValidObjectId(id)) {
    return sendResponse(400, 'error', 'Invalid order id', null)
  }

  await connectDB()

  const order = await ShopifyOrder.findOne({ _id: id, shop: session.shop }).lean()
  if (!order) {
    return sendResponse(404, 'error', 'Order not found in this shop', null)
  }
  if (!order.invoiceRef) {
    return sendResponse(409, 'error', 'No invoice exists for this order yet', null)
  }

  const invoice = await Invoice.findById(order.invoiceRef)
    .select('qboInvoiceId qboDocNumber')
    .lean()
  if (!invoice?.qboInvoiceId) {
    return sendResponse(
      409,
      'error',
      'This order has no QBO invoice id on file (creation may have failed)',
      null,
    )
  }

  let pdf
  try {
    pdf = await getInvoicePdf(invoice.qboInvoiceId)
  } catch (e) {
    console.error('[admin/qbo-invoice-pdf] QBO PDF fetch failed:', e?.message || e)
    return sendResponse(502, 'error', `Failed to fetch QBO PDF: ${e?.message || e}`, null)
  }

  const filename = `invoice-${invoice.qboDocNumber || invoice.qboInvoiceId}.pdf`
  return sendResponse(200, 'success', 'PDF fetched', {
    base64: pdf.buffer.toString('base64'),
    contentType: pdf.contentType || 'application/pdf',
    filename,
    size: pdf.buffer.length,
  })
}
