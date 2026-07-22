import mongoose from 'mongoose'
import { authenticate } from '../../shopify.server'
import connectDB from '../../services/APIService/mongo.service'
import ShopifyOrder from '../../models/order.server'
import Invoice from '../../models/invoice.server'
import CustomerMap from '../../models/customerMap.server'
import { enqueueInvoiceEmail } from '../../services/email/emailQueue.service'
import { sendResponse } from '../../services/APIService/api.service'

// POST /api/admin/orders/:id/send-invoice
//
// "Send invoice" button on the Order Details page → QuickBooks invoice
// section. Manually fires QBO's `/invoice/<id>/send` endpoint and stamps
// the local email-tracking baseline so the next CRON / payment-driven
// re-send only fires when something actually changes.
//
// QBO's `/send` always mails the CURRENT invoice document, so the
// customer sees the up-to-date balance + payments list automatically.
// This endpoint is the same call the lifecycle dispatcher uses on
// creation / payment events (services/invoice/invoice.service.dispatch-
// InvoiceLifecycleEmails) — surfacing it for manual operator-driven
// sends covers cases like "the customer says they never got it" or
// "we just amended the QBO invoice".
//
// Recipient resolution mirrors the dispatcher: customerMap.email is
// preferred (live value, can be updated via /api/update-profile);
// invoice.customerEmail is the fallback for legacy rows.
export async function action({ request, params }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let session
  try {
    const auth = await authenticate.admin(request)
    session = auth.session
  } catch (e) {
    console.error('[admin/send-invoice] auth failed:', e?.message || e)
    return sendResponse(401, 'error', 'Unauthorized', null)
  }

  const { id } = params
  if (!id || !mongoose.isValidObjectId(id)) {
    return sendResponse(400, 'error', 'Invalid order id', null)
  }

  await connectDB()

  const order = await ShopifyOrder.findOne({ _id: id, shop: session.shop })
  if (!order) {
    return sendResponse(404, 'error', 'Order not found in this shop', null)
  }
  if (!order.invoiceRef) {
    return sendResponse(409, 'error', 'No invoice exists for this order yet', null)
  }

  const invoice = await Invoice.findById(order.invoiceRef)
  if (!invoice) {
    return sendResponse(409, 'error', 'Linked invoice record is missing', null)
  }
  if (!invoice.qboInvoiceId) {
    return sendResponse(
      409,
      'error',
      'QBO invoice not yet created for this order — wait for the create-invoice job to finish',
      null,
    )
  }

  const customerMap = order.customerEmail
    ? await CustomerMap.findOne({ shop: session.shop, email: order.customerEmail })
    : null
  const sendTo = customerMap?.email || invoice.customerEmail
  if (!sendTo) {
    return sendResponse(
      409,
      'error',
      'No email on file for this customer — update the profile before sending',
      null,
    )
  }

  const initiatedBy =
    session.onlineAccessInfo?.associated_user?.email || session.shop

  console.log(
    `[admin/send-invoice] shop=${session.shop} order=${order.shopifyOrderId} ` +
      `invoice=${invoice._id} qboInvoice=${invoice.qboInvoiceId} sendTo=${sendTo} by=${initiatedBy}`,
  )

  // Hand the QBO send off to the durable background job instead of blocking
  // this request on the QBO round-trip. The job reloads the invoice, sends,
  // advances the lifecycle-dispatcher baseline, and writes the emailEvents[]
  // audit ledger (success OR failure) — so the Order Details page still
  // surfaces the outcome, just moments later. Delivery is retried across
  // process restarts.
  const queued = await enqueueInvoiceEmail({
    shop: session.shop,
    invoiceId: invoice._id,
    sendTo,
    triggerType: 'manual',
    triggeredBy: initiatedBy,
    source: 'manual_resend',
    remark: `Admin sent invoice email to ${sendTo} by ${initiatedBy}`,
  })

  if (!queued.success) {
    return sendResponse(502, 'error', 'Could not queue the invoice email — please try again', null)
  }

  return sendResponse(202, 'success', `Invoice email queued for ${sendTo}`, {
    sentTo: sendTo,
    qboInvoiceId: invoice.qboInvoiceId,
    queued: true,
  })
}
