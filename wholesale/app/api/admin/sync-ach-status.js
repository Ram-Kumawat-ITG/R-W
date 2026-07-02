import mongoose from 'mongoose'
import { authenticate } from '../../shopify.server'
import connectDB from '../../services/APIService/mongo.service'
import ShopifyOrder from '../../models/order.server'
import Invoice from '../../models/invoice.server'
import CustomerMap from '../../models/customerMap.server'
import { manualSyncAchInvoice } from '../../services/payment/achStatusSync.service'
import { sendResponse } from '../../services/APIService/api.service'

// POST /api/admin/orders/:id/sync-ach-status
//
// Manual "Sync ACH status" handler. Runs the SAME reconciliation as the
// dedicated `process-ach-status-sync` CRON, but for a single invoice and
// on demand — so an admin doesn't have to wait for the next scheduled tick
// to see a settlement / return reflected.
//
// It fetches the latest transaction condition directly from NMI (via
// payment.service.checkAchSettlement, the single source of truth for the
// awaiting_settlement → paid/pending/failed transition), updates the
// payment + invoice (+ downstream QBO/Shopify order state on settlement),
// records the change on the achStatusHistory[] audit trail + a remarks[]
// entry, and stores any return code / reason on the invoice.
//
// Safety guards (mirror the UI gating):
//   - order must exist in the caller's shop and have a linked Invoice
//   - invoice.paymentMethod must be 'ach'
//   - invoice must be 'awaiting_settlement' with a pendingSettlementTxnId
//     (otherwise there is no in-flight transaction to reconcile)
//
// Duplicate-request protection: the service takes an atomic per-invoice
// lock (`achSyncInProgress`) before reconciling and releases it in a
// finally block. A second request that arrives while a sync is running
// gets a 409 instead of re-querying NMI / double-applying a settlement.
export async function action({ request, params }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let session
  try {
    const auth = await authenticate.admin(request)
    session = auth.session
  } catch (e) {
    console.error('[admin/sync-ach-status] auth failed:', e?.message || e)
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

  // ACH only — the sync reconciles ACH settlement state; there is nothing
  // to poll for card / cheque invoices.
  if (invoice.paymentMethod !== 'ach') {
    return sendResponse(
      409,
      'error',
      `ACH status sync is only available for ACH invoices (this invoice's method is "${invoice.paymentMethod}")`,
      null,
    )
  }

  // Must have an in-flight transaction to reconcile. Once an ACH invoice
  // has settled (paid) or been returned (pending/failed) there is no live
  // NMI transaction to poll — the original id is cleared on resolution.
  if (invoice.paymentStatus !== 'awaiting_settlement' || !invoice.pendingSettlementTxnId) {
    return sendResponse(
      409,
      'error',
      'No in-flight ACH transaction to synchronize — this invoice has no transaction awaiting settlement.',
      null,
    )
  }

  // checkAchSettlement needs the CustomerMap to propagate a confirmed
  // settlement downstream (QBO payment + Shopify mark-paid). Resolve it via
  // the invoice's customerMapRef, falling back to a shop+email lookup.
  const customerMap = invoice.customerMapRef
    ? await CustomerMap.findById(invoice.customerMapRef)
    : order.customerEmail
      ? await CustomerMap.findOne({ shop: session.shop, email: order.customerEmail })
      : null

  const initiatedBy =
    session.onlineAccessInfo?.associated_user?.email || session.shop

  console.log(
    `[admin/sync-ach-status] manual sync by shop=${session.shop} order=${order.shopifyOrderId} ` +
      `invoice=${invoice._id} txn=${invoice.pendingSettlementTxnId} by=${initiatedBy}`,
  )

  const result = await manualSyncAchInvoice({
    invoiceId: invoice._id,
    customerMap,
    initiatedBy,
  })

  if (!result.ok) {
    if (result.reason === 'in_progress') {
      return sendResponse(
        409,
        'error',
        'A status sync is already in progress for this invoice — please wait for it to finish.',
        null,
      )
    }
    if (result.reason === 'not_found') {
      return sendResponse(404, 'error', 'Invoice not found', null)
    }
    return sendResponse(
      502,
      'error',
      `ACH status sync failed: ${result.error || 'unknown error'}`,
      null,
    )
  }

  // Build a human-readable message from the reconciliation outcome.
  let message
  switch (result.action) {
    case 'settled':
      message = `Settlement confirmed — $${Number(result.amount || 0).toFixed(2)} applied; invoice is now ${result.newStatus}.`
      break
    case 'returned':
      message =
        `ACH ${result.normalizedStatus}${result.returnCode ? ` (return code ${result.returnCode})` : ''}: ` +
        `${result.reason || result.condition}. Invoice reset to ${result.newStatus}.`
      break
    case 'still_pending':
      message = `Still settling — NMI condition "${result.condition || 'pendingsettlement'}". No change yet (day ${result.ageDays} of the typical 1–3 business day window).`
      break
    default:
      message = `NMI did not return a definitive status (${result.condition || 'unknown'}). No change applied — try again shortly.`
  }

  return sendResponse(200, 'success', message, {
    action: result.action,
    status: result.normalizedStatus,
    condition: result.condition,
    newStatus: result.newStatus,
    returnCode: result.returnCode,
    amount: result.amount,
    transactionId: result.transactionId,
    lastSyncAt: result.lastSyncAt,
  })
}
