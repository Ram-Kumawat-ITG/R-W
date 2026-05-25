import mongoose from 'mongoose'
import { authenticate } from '../../shopify.server'
import connectDB from '../../services/APIService/mongo.service'
import ShopifyOrder from '../../models/order.server'
import Invoice from '../../models/invoice.server'
import CustomerMap from '../../models/customerMap.server'
import { chargeInvoice } from '../../services/payment/payment.service'
import { appendInvoiceRemark } from '../../services/invoice/invoice.service'
import { resolveCustomerVaultId } from '../../services/customer/customer.service'
import { sendResponse } from '../../services/APIService/api.service'

// POST /api/admin/orders/:id/retry-payment
//
// Manual "Retry Now" handler. Synchronously runs one charge attempt against
// the invoice linked to this order and returns the outcome to the caller so
// the admin UI can show approved/declined/error inline without polling.
//
// Why synchronous: an NMI sale call typically takes 2–5s, which is fine UX
// for an admin action and avoids the complexity of a background-job +
// polling channel. If we ever need bulk retries (>10 orders), revisit.
//
// Safety guards (mirror the eligibility check in the UI):
//   - order must exist in the caller's shop
//   - order must have a linked Invoice
//   - invoice.paymentStatus must be 'pending' or 'failed'
//     ('paid' / 'cancelled' / 'in_progress' would be a footgun)
//   - linked CustomerMap must have an nmiCustomerVaultId
//
// If attemptCount has already reached maxAttempts (which is why the auto
// retry path stopped trying), this handler bumps maxAttempts by 1 so the
// downstream chargeInvoice doesn't short-circuit with "max attempts reached".
// We do not reset attemptCount — the PaymentAttempt audit trail must remain
// strictly append-only.
export async function action({ request, params }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let session
  try {
    const auth = await authenticate.admin(request)
    session = auth.session
  } catch (e) {
    console.error('[admin/retry-payment] auth failed:', e?.message || e)
    return sendResponse(401, 'error', 'Unauthorized', null)
  }

  const { id } = params
  if (!id || !mongoose.isValidObjectId(id)) {
    return sendResponse(400, 'error', 'Invalid order id', null)
  }

  // Optional partial-charge amount. When omitted, chargeInvoice falls
  // back to charging the full remaining balance (the legacy behavior
  // the CRON also uses). When present, it's clipped against the
  // remaining outstanding by the service layer.
  let requestedAmount
  try {
    const body = await request.clone().json()
    if (body?.amount !== undefined && body?.amount !== null && body?.amount !== '') {
      const amt = Number(body.amount)
      if (!Number.isFinite(amt) || amt <= 0) {
        return sendResponse(400, 'error', 'amount must be a positive number', null)
      }
      requestedAmount = amt
    }
  } catch {
    // No body / non-JSON body = full-balance charge.
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

  if (invoice.paymentStatus === 'paid' || invoice.paymentStatus === 'cancelled') {
    return sendResponse(409, 'error', `Invoice is already ${invoice.paymentStatus}`, null)
  }
  if (invoice.paymentStatus === 'in_progress') {
    return sendResponse(409, 'error', 'A charge is already in progress for this invoice', null)
  }
  // Cheque / ACH invoices use the dedicated mark-cheque-paid + charge-card
  // endpoints. Retrying card-charge logic against a cheque invoice would
  // bypass the per-method workflow on the Order Details page.
  if (invoice.paymentMethod && invoice.paymentMethod !== 'card') {
    return sendResponse(
      409,
      'error',
      `Invoice payment method is "${invoice.paymentMethod}" — use the cheque or charge-card actions instead`,
      null,
    )
  }

  const customerMap = order.customerEmail
    ? await CustomerMap.findOne({ shop: session.shop, email: order.customerEmail })
    : null
  // customer_maps is a cache populated at order intake; consult
  // wholesale_applications (source of truth) as a fallback in case the
  // customer captured a card after the order ran through customer.service.
  const resolvedVaultId = order.customerEmail
    ? await resolveCustomerVaultId({
        shop: session.shop,
        email: order.customerEmail,
        customerMap,
      })
    : null
  if (!resolvedVaultId) {
    return sendResponse(
      409,
      'error',
      'No NMI vault on file for this customer — collect a payment method before retrying',
      null,
    )
  }
  if (customerMap && !customerMap.nmiCustomerVaultId) {
    customerMap.nmiCustomerVaultId = resolvedVaultId
  }

  // Bump the ceiling so chargeInvoice's `attemptCount >= maxAttempts` guard
  // doesn't reject us. This is the *manual* override path — admin took
  // responsibility by clicking the button.
  if (invoice.attemptCount >= invoice.maxAttempts) {
    invoice.maxAttempts = invoice.attemptCount + 1
  }
  // If the prior auto-retries marked it failed, flip back to pending so
  // chargeInvoice will run. (It would also accept 'failed' since the guard
  // only excludes 'paid'/'cancelled', but pending matches the semantics
  // we want for the in-progress lock.)
  if (invoice.paymentStatus === 'failed') {
    invoice.paymentStatus = 'pending'
  }
  await invoice.save()

  console.log(
    `[admin/retry-payment] manual retry by shop=${session.shop} order=${order.shopifyOrderId} invoice=${invoice._id}`,
  )

  const initiatedBy =
    session.onlineAccessInfo?.associated_user?.email || session.shop

  let result
  try {
    result = await chargeInvoice({ invoice, customerMap, requestedAmount })
  } catch (e) {
    console.error('[admin/retry-payment] chargeInvoice threw:', e?.message || e)
    const isValidation = /requestedAmount/i.test(e?.message || '')
    return sendResponse(
      isValidation ? 400 : 500,
      'error',
      e?.message || 'Charge failed',
      null,
    )
  }

  // Surface the retry outcome on the Order List "Remarks" column so
  // admins see follow-up activity without opening the Order Details
  // page. Failure-mode messages mirror what the CRON's PASS 1 writes
  // so the same column reads consistently across origins.
  let remarkMsg
  if (result.skipped) {
    remarkMsg = `Admin retry skipped: ${result.reason}`
  } else if (result.outcome === 'approved') {
    remarkMsg = `Admin retry approved (NMI txn ${result.transactionId || '?'})`
  } else if (result.outcome === 'declined') {
    remarkMsg = `Admin retry declined: ${result.responseText || 'no reason given'}`
  } else {
    remarkMsg = `Admin retry errored: ${result.error || result.responseText || 'unknown'}`
  }
  await appendInvoiceRemark(invoice._id, {
    kind: 'admin_action',
    message: `${remarkMsg} by ${initiatedBy}`,
    amount: result.amount,
    currency: invoice.currency,
    source: 'admin',
  })

  return sendResponse(200, 'success', 'Retry processed', result)
}
