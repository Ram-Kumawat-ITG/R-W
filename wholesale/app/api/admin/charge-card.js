import mongoose from 'mongoose'
import { authenticate } from '../../shopify.server'
import connectDB from '../../services/APIService/mongo.service'
import ShopifyOrder from '../../models/order.server'
import Invoice from '../../models/invoice.server'
import CustomerMap from '../../models/customerMap.server'
import { chargeInvoice } from '../../services/payment/payment.service'
import { appendInvoiceRemark } from '../../services/invoice/invoice.service'
import {
  resolveCustomerVaultId,
  resolveCustomerCardBillingId,
} from '../../services/customer/customer.service'
import { sendResponse } from '../../services/APIService/api.service'

// POST /api/admin/orders/:id/charge-card
//
// Cheque → card fallback. Used when a customer's preferred payment method
// is cheque/ACH but the admin needs to actually collect by charging the
// card on file (e.g. cheque never arrived). The action:
//   1. Flips invoice.paymentMethod from 'check'|'ach' → 'card'
//      (per-invoice override; CustomerMap preference stays untouched)
//   2. Runs the same chargeInvoice() flow as Retry payment
//
// Guards mirror retry-payment.js. The endpoint stays separate so the
// per-invoice override is explicit and auditable in logs.
export async function action({ request, params }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let session
  try {
    const auth = await authenticate.admin(request)
    session = auth.session
  } catch (e) {
    console.error('[admin/charge-card] auth failed:', e?.message || e)
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

  if (invoice.paymentStatus === 'paid' || invoice.paymentStatus === 'cancelled') {
    return sendResponse(409, 'error', `Invoice is already ${invoice.paymentStatus}`, null)
  }
  if (invoice.paymentStatus === 'in_progress') {
    return sendResponse(409, 'error', 'A charge is already in progress for this invoice', null)
  }
  // Charging the card on top of an in-flight ACH would risk double-
  // billing the customer if the ACH eventually settles. Force the
  // admin to wait for the settlement decision (or void the ACH
  // transaction directly in NMI) before running a card fallback.
  if (invoice.paymentStatus === 'awaiting_settlement') {
    return sendResponse(
      409,
      'error',
      `An ACH transaction is awaiting settlement (NMI txn ${invoice.pendingSettlementTxnId || '?'}). Wait for the bank to confirm or return it, or void the ACH transaction in NMI first, before charging the card on file.`,
      null,
    )
  }

  const customerMap = order.customerEmail
    ? await CustomerMap.findOne({ shop: session.shop, email: order.customerEmail })
    : null
  // Resolve via the customer_maps cache OR wholesale_applications source
  // of truth — covers the case where the customer captured a card after
  // their order was already in flight (cache hasn't been refreshed yet).
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
      'No NMI vault on file for this customer — collect a payment method before charging',
      null,
    )
  }
  // Reflect any lazy sync back onto the in-memory map so chargeInvoice's
  // own `customerMap.nmiCustomerVaultId` read sees the resolved id.
  if (customerMap && !customerMap.nmiCustomerVaultId) {
    customerMap.nmiCustomerVaultId = resolvedVaultId
  }

  // Re-resolve the CARD billing id from the source of truth too — this is the
  // "charge the card on file" path, so a card the practitioner updated/added
  // after their last order must be the one hit. Best-effort + non-fatal: when
  // absent, chargeInvoice leaves billingId undefined and NMI charges the
  // vault's default billing (pre-existing behavior). Especially relevant here
  // since this flips an ACH/cheque invoice to card — without the card billing
  // id an ACH customer's vault would otherwise target its priority-1 (ACH)
  // billing instead of the card.
  const resolvedCardBillingId = order.customerEmail
    ? await resolveCustomerCardBillingId({
        shop: session.shop,
        email: order.customerEmail,
        customerMap,
      })
    : null
  if (customerMap && resolvedCardBillingId && !customerMap.nmiCardBillingId) {
    customerMap.nmiCardBillingId = resolvedCardBillingId
  }

  // Per-order override: flip method to card so the scheduler will also
  // pick this invoice up on subsequent ticks if this attempt declines.
  const originalMethod = invoice.paymentMethod
  if (invoice.paymentMethod !== 'card') {
    console.log(
      `[admin/charge-card] flipping invoice ${invoice._id} paymentMethod ${originalMethod} → card (per-order override)`,
    )
    invoice.paymentMethod = 'card'
  }
  // Same maxAttempts / failed→pending unblocking as retry-payment.js.
  if (invoice.attemptCount >= invoice.maxAttempts) {
    invoice.maxAttempts = invoice.attemptCount + 1
  }
  if (invoice.paymentStatus === 'failed') {
    invoice.paymentStatus = 'pending'
  }
  await invoice.save()

  console.log(
    `[admin/charge-card] shop=${session.shop} order=${order.shopifyOrderId} ` +
      `invoice=${invoice._id} originalMethod=${originalMethod} → charging card`,
  )

  const initiatedBy =
    session.onlineAccessInfo?.associated_user?.email || session.shop

  let result
  try {
    result = await chargeInvoice({ invoice, customerMap })
  } catch (e) {
    console.error('[admin/charge-card] chargeInvoice threw:', e?.message || e)
    return sendResponse(500, 'error', e?.message || 'Charge failed', null)
  }

  // Log the cheque → card fallback attempt for the Order List "Remarks"
  // column. Distinct from a normal retry — the originalMethod field
  // makes the override traceable.
  let remarkMsg
  if (result.skipped) {
    remarkMsg = `Charge card on file skipped: ${result.reason}`
  } else if (result.outcome === 'approved') {
    remarkMsg = `Charge card on file approved (NMI txn ${result.transactionId || '?'})`
  } else if (result.outcome === 'declined') {
    remarkMsg = `Charge card on file declined: ${result.responseText || 'no reason given'}`
  } else {
    remarkMsg = `Charge card on file errored: ${result.error || result.responseText || 'unknown'}`
  }
  await appendInvoiceRemark(invoice._id, {
    kind: 'admin_action',
    message: `${remarkMsg} (was ${originalMethod} → card) by ${initiatedBy}`,
    amount: result.amount,
    currency: invoice.currency,
    source: 'admin',
  })

  return sendResponse(200, 'success', 'Charge attempted', {
    ...result,
    originalMethod,
    newMethod: invoice.paymentMethod,
  })
}
