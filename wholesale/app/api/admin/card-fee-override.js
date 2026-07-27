import mongoose from 'mongoose'
import { authenticate } from '../../shopify.server'
import connectDB from '../../services/APIService/mongo.service'
import WholesaleApplication from '../../models/wholesaleApplication.server'
import CustomerMap from '../../models/customerMap.server'
import { sendResponse } from '../../services/APIService/api.service'
import { normalizePaymentMethod } from '../../services/customer/customer.utils'
import { applyPaymentPreferenceToOpenInvoices } from '../../services/invoice/paymentPreference.service'

// POST /api/admin/customers/:id/card-fee-override   body: { percent }
//
// Admin-driven per-practitioner CARD-fee override. `percent` is the card fee
// as a PERCENT (e.g. 1.5 = 1.5%, 0 = charge no card fee). Send null / "" /
// omit `percent` to CLEAR the override (revert to the default card rate, 3%).
//
// Stored on wholesale_applications.cardFeeOverridePercent as a FRACTION
// (1.5% → 0.015; 0% → 0; cleared → null — null and 0 are distinct), mirrored
// onto customer_maps for fast read at charge/creation time. When the
// practitioner currently pays by CARD, open (unpaid) invoices are re-priced to
// the new card rate immediately (forceFeeRecompute). ACH/cheque invoices are
// never touched — the override is card-only, so an ACH-preferred practitioner
// keeps the standard 1% ACH fee.
//
// `:id` is the WholesaleApplication _id (same id the customer detail page loads).
export async function action({ request, params }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let session
  try {
    const auth = await authenticate.admin(request)
    session = auth.session
  } catch (e) {
    console.error('[admin/card-fee-override] auth failed:', e?.message || e)
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

  // Resolve the requested override. Empty / null / undefined → clear.
  // Otherwise a percent in [0, 100] → fraction. Reject anything else so a
  // bad value can never silently store a wrong fee.
  const raw = body?.percent
  let overrideFraction // null = clear, else a number >= 0
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    overrideFraction = null
  } else {
    const pct = Number(raw)
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return sendResponse(400, 'error', 'percent must be a number between 0 and 100 (or empty to clear)', null)
    }
    overrideFraction = Number((pct / 100).toFixed(6)) // 1.5 → 0.015, 0 → 0
  }

  await connectDB()

  const doc = await WholesaleApplication.findById(id)
  if (!doc) return sendResponse(404, 'error', 'Customer not found', null)
  const shop = doc.shop || session.shop
  if (!doc.email) return sendResponse(409, 'error', 'Customer has no email on file', null)

  const adminEmail = session.onlineAccessInfo?.associated_user?.email || session.shop
  const previousFraction =
    doc.cardFeeOverridePercent === null || doc.cardFeeOverridePercent === undefined
      ? null
      : Number(doc.cardFeeOverridePercent)

  // Persist on the application (source of truth) + mirror onto the customer
  // map so future invoice creation / charges read it without a lookup, and so
  // the realign below (which reads the map) sees the new value.
  try {
    await WholesaleApplication.updateOne(
      { _id: doc._id },
      {
        $set: {
          cardFeeOverridePercent: overrideFraction,
          cardFeeOverrideUpdatedAt: new Date(),
          cardFeeOverrideUpdatedBy: adminEmail,
        },
      },
    )
    await CustomerMap.updateOne(
      { shop, email: doc.email },
      { $set: { cardFeeOverridePercent: overrideFraction } },
    )
  } catch (e) {
    console.error('[admin/card-fee-override] save failed:', e?.message || e)
    return sendResponse(500, 'error', 'Failed to save card fee override', { detail: e.message })
  }

  // Re-price the practitioner's OPEN invoices only when they currently pay by
  // card (the override is card-only). ACH/cheque-preferred practitioners keep
  // their open invoices untouched; the override still applies to any future
  // card invoice or if they later switch to card.
  const currentMethod = normalizePaymentMethod(doc.payment?.method)
  let realign = null
  if (currentMethod === 'card') {
    try {
      realign = await applyPaymentPreferenceToOpenInvoices({
        shop,
        email: doc.email,
        newMethod: 'card',
        performedBy: adminEmail,
        source: 'admin',
        forceFeeRecompute: true,
      })
    } catch (e) {
      // Override is saved; surface the realign failure without claiming the
      // whole action failed (open invoices can be re-priced by re-submitting).
      console.error('[admin/card-fee-override] invoice realign failed:', e?.message || e)
      return sendResponse(502, 'error', `Override saved, but re-pricing open invoices failed: ${e?.message || e}`, {
        previousPercent: previousFraction == null ? null : previousFraction * 100,
        newPercent: overrideFraction == null ? null : overrideFraction * 100,
      })
    }
  }

  return sendResponse(200, 'success', overrideFraction == null ? 'Card fee override cleared' : 'Card fee override saved', {
    previousPercent: previousFraction == null ? null : Number((previousFraction * 100).toFixed(4)),
    newPercent: overrideFraction == null ? null : Number((overrideFraction * 100).toFixed(4)),
    currentMethod,
    reprice: realign ? { updated: realign.updated, skipped: realign.skipped, failed: realign.failed } : null,
  })
}
