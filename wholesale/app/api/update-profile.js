import crypto from 'node:crypto'
import { authenticate } from '../shopify.server'
import connectDB from '../db.server'
import WholesaleApplication from '../models/wholesaleApplication.server'
import { sendResponse } from '../utils/sendResponse'
import { buildShopifyNote } from '../utils/buildShopifyNote'
import { customerUpdateNote } from '../utils/shopifyCustomer'

// POST /api/update-profile
// Content-Type: application/json
//
// email      → find customer in MongoDB (required)
// customer_id → numeric Shopify customer ID, used to update Shopify customer note (optional)
// payment    → card fields (all optional, send only what changed)
// tax        → tax fields (all optional, send only what changed)
//
// Card security: raw card number is hashed with HMAC-SHA256. The PAN is never stored or logged.

export async function action({ request }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let admin
  try {
    const auth = await authenticate.public.appProxy(request)
    admin = auth.admin
  } catch (e) {
    console.error('[proxy/update-profile] appProxy auth failed:', e?.message || e)
    return sendResponse(401, 'error', 'Unauthorized', null)
  }

  if (!admin) {
    console.error('[proxy/update-profile] admin client unavailable from appProxy auth')
    return sendResponse(500, 'error', 'Admin client unavailable', null)
  }

  await connectDB()

  let body
  try {
    body = await request.json()
  } catch (e) {
    console.error('[proxy/update-profile] JSON parse failed:', e?.message || e)
    return sendResponse(400, 'error', 'Invalid JSON payload', null)
  }

  // email   → identify the customer in MongoDB
  // customer_id → identify the customer in Shopify (numeric, e.g. 1234567890)
  const { email, customer_id: rawCustomerId, payment = {}, tax = {} } = body

  if (!email) {
    return sendResponse(400, 'error', 'email is required', null)
  }

  const shopifyGid = rawCustomerId ? `gid://shopify/Customer/${rawCustomerId}` : null

  const doc = await WholesaleApplication.findOne({ email })
  if (!doc) {
    return sendResponse(404, 'error', 'Application not found for this customer', null)
  }

  const $set = {}
  let hasTaxUpdate = false

  // ── Card / payment fields ─────────────────────────────────────────────────
  const { cardNumber: rawCardNumber, ...paymentFields } = payment
  const paymentKeys = ['method', 'cardholderName', 'cardBrand', 'cardLast4', 'cardExpMonth', 'cardExpYear']

  const hasPaymentUpdate = rawCardNumber || paymentKeys.some((k) => payment[k] != null && payment[k] !== '')
  if (hasPaymentUpdate) {
    const numFields = new Set(['cardExpMonth', 'cardExpYear'])
    for (const k of paymentKeys) {
      const v = paymentFields[k]
      if (v != null && v !== '') {
        $set[`payment.${k}`] = numFields.has(k) ? (parseInt(v, 10) || v) : v
      }
    }

    // Hash the raw PAN — never store it.
    if (rawCardNumber) {
      const pan = String(rawCardNumber).replace(/\D/g, '')
      if (pan) {
        const key = process.env.SHOPIFY_API_SECRET || 'card-hash-fallback-key'
        $set['payment.cardNumberHash'] = crypto
          .createHmac('sha256', key)
          .update(`card-pan:${pan}`)
          .digest('hex')
      }
    }
  }

  // ── Tax fields ────────────────────────────────────────────────────────────
  const taxKeys = ['taxIdType', 'taxId', 'salesPermit', 'exemptState', 'itemsToResell', 'businessActivity']

  for (const k of taxKeys) {
    const v = tax[k]
    if (v != null && v !== '') {
      $set[`tax.${k}`] = v
      hasTaxUpdate = true
    }
  }

  if (!hasPaymentUpdate && !hasTaxUpdate) {
    return sendResponse(400, 'error', 'No fields to update', null)
  }

  // ── Persist to MongoDB ────────────────────────────────────────────────────
  try {
    await WholesaleApplication.updateOne({ _id: doc._id }, { $set })
  } catch (e) {
    console.error('[proxy/update-profile] mongo update failed:', e)
    return sendResponse(500, 'error', 'Failed to save update', { detail: e.message })
  }

  // ── Rebuild + push Shopify customer note (tax changes only) ───────────────
  if (hasTaxUpdate) {
    try {
      const merged = {
        ...doc.toObject(),
        tax: {
          ...(doc.tax?.toObject?.() ?? doc.tax ?? {}),
          ...Object.fromEntries(taxKeys.filter((k) => tax[k] != null && tax[k] !== '').map((k) => [k, tax[k]])),
        },
      }
      const note = buildShopifyNote(merged)
      const customerId = shopifyGid || doc.customerId
      if (customerId) {
        await customerUpdateNote(admin, { customerId, note })
      }
    } catch (e) {
      console.error('[proxy/update-profile] shopify note sync failed:', e?.message || e)
    }
  }

  const existingPayment = doc.payment?.toObject?.() ?? doc.payment ?? {}
  const existingTax = doc.tax?.toObject?.() ?? doc.tax ?? {}

  const updatedPayment = { ...existingPayment, ...Object.fromEntries(
    Object.entries($set)
      .filter(([k]) => k.startsWith('payment.'))
      .map(([k, v]) => [k.replace('payment.', ''), v])
  )}
  const updatedTax = { ...existingTax, ...Object.fromEntries(
    Object.entries($set)
      .filter(([k]) => k.startsWith('tax.'))
      .map(([k, v]) => [k.replace('tax.', ''), v])
  )}

  // Never expose the card hash
  delete updatedPayment.cardNumberHash

  return sendResponse(200, 'success', 'Profile updated', {
    payment: updatedPayment,
    tax: updatedTax,
  })
}

export async function loader() {
  return sendResponse(405, 'error', 'Method not allowed', null)
}
