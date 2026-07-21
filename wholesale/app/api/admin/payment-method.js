import mongoose from 'mongoose'
import { authenticate } from '../../shopify.server'
import connectDB from '../../services/APIService/mongo.service'
import WholesaleApplication from '../../models/wholesaleApplication.server'
import { sendResponse } from '../../services/APIService/api.service'
import { normalizePaymentMethod } from '../../services/customer/customer.utils'
import { applyPaymentPreferenceToOpenInvoices } from '../../services/invoice/paymentPreference.service'
import { notifyProfileUpdated } from '../../services/notifications/accountNotification.service'

// POST /api/admin/customers/:id/payment-method   body: { method }
//
// Admin-driven payment-preference change. Updates the customer's preference
// on their wholesale application and realigns ALL their unpaid/open invoices
// to the new method (recompute per-method processing fee + due date, sync
// QBO, audit) via the shared service. CustomerMap mirroring + the audit
// history entry happen inside applyPaymentPreferenceToOpenInvoices.
//
// `:id` is the WholesaleApplication _id (same id the customer detail page
// loads). The customer self-service counterpart lives in
// app/api/update-profile.js.
export async function action({ request, params }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let session
  try {
    const auth = await authenticate.admin(request)
    session = auth.session
  } catch (e) {
    console.error('[admin/payment-method] auth failed:', e?.message || e)
    return sendResponse(401, 'error', 'Unauthorized', null)
  }

  const { id } = params
  if (!id || !mongoose.isValidObjectId(id)) {
    return sendResponse(400, 'error', 'Invalid customer id', null)
  }

  let body
  try {
    body = await request.json()
  } catch {
    return sendResponse(400, 'error', 'Invalid JSON payload', null)
  }

  const rawMethod = body?.method
  if (!rawMethod) {
    return sendResponse(400, 'error', 'method is required', null)
  }
  const newMethod = normalizePaymentMethod(rawMethod)

  await connectDB()

  const doc = await WholesaleApplication.findById(id)
  if (!doc) return sendResponse(404, 'error', 'Customer not found', null)

  const shop = doc.shop || session.shop
  if (!doc.email) {
    return sendResponse(409, 'error', 'Customer has no email on file', null)
  }

  const previousMethod = normalizePaymentMethod(doc.payment?.method)
  const adminEmail = session.onlineAccessInfo?.associated_user?.email || session.shop

  // Persist the new preference on the application first (so future orders
  // pick it up via ensureCustomerForOrder), then realign open invoices.
  try {
    await WholesaleApplication.updateOne({ _id: doc._id }, { $set: { 'payment.method': newMethod } })
  } catch (e) {
    console.error('[admin/payment-method] preference save failed:', e?.message || e)
    return sendResponse(500, 'error', 'Failed to save payment preference', { detail: e.message })
  }

  let realign = null
  try {
    realign = await applyPaymentPreferenceToOpenInvoices({
      shop,
      email: doc.email,
      newMethod,
      performedBy: adminEmail,
      source: 'admin',
    })
  } catch (e) {
    // Preference is already saved; surface the realign failure but don't
    // pretend the whole action failed. Open invoices can be re-aligned by
    // re-submitting.
    console.error('[admin/payment-method] invoice realign failed:', e?.message || e)
    return sendResponse(502, 'error', `Preference saved, but invoice realignment failed: ${e?.message || e}`, {
      previousMethod,
      newMethod,
    })
  }

  // Best-effort + FIRE-AND-FORGET — never blocks the response. Awaiting this
  // meant a slow/unreachable SMTP (e.g. staging → Ethereal) hung the admin
  // request ~32s (10s connection timeout × retries) before responding.
  notifyProfileUpdated({
    email: doc.email,
    firstName: doc.firstName,
    lastName: doc.lastName,
    businessName: doc.businessName,
    changes: [`Payment method changed to ${newMethod.toUpperCase()}`],
    source: 'admin',
  }).catch((e) => console.error('[admin/payment-method] notification failed:', e?.message || e))

  return sendResponse(200, 'success', 'Payment preference updated', {
    previousMethod,
    newMethod,
    ...realign,
  })
}
