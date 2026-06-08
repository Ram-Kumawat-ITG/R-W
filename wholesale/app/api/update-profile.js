import { authenticate } from '../shopify.server'
import connectDB from '../services/APIService/mongo.service'
import WholesaleApplication from '../models/wholesaleApplication.server'
import { sendResponse } from '../services/APIService/api.service'
import { buildShopifyNote } from '../services/shopify/shopify.utils'
import { customerUpdateNote, customerUpdateDefaultAddress } from '../utils/shopifyCustomer'
import { normalizePaymentMethod } from '../services/customer/customer.utils'
import { applyPaymentPreferenceToOpenInvoices } from '../services/invoice/paymentPreference.service'

// POST /api/update-profile  (Shopify App Proxy)
// Content-Type: application/json
//
// Accepts any combination of: profile, address, payment, tax.
// Send only the fields that changed — everything is optional except email.
// Address: one address only (mirrors Shopify customer default address).
// Card: raw cardNumber is HMAC-SHA256 hashed server-side, never stored raw.

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

  const {
    email,
    customer_id: rawCustomerId,
    profile = {},
    address,
    payment = {},
    tax = {},
  } = body

  if (!email) {
    return sendResponse(400, 'error', 'email is required', null)
  }

  const shopifyGid = rawCustomerId ? `gid://shopify/Customer/${rawCustomerId}` : null

  const doc = await WholesaleApplication.findOne({ email })
  if (!doc) {
    return sendResponse(404, 'error', 'Application not found for this customer', null)
  }

  const $set = {}
  let hasProfileUpdate = false
  let hasAddressUpdate = false
  let hasPaymentUpdate = false
  let hasTaxUpdate = false

  // ── Profile fields ────────────────────────────────────────────────────────
  const profileKeys = ['firstName', 'lastName', 'phone', 'businessName']
  for (const k of profileKeys) {
    const v = profile[k]
    if (v != null && v !== '') {
      $set[k] = v
      hasProfileUpdate = true
    }
  }

  // ── Address (single — mirrors Shopify customer default address) ───────────
  let addressToSync = null
  if (address && typeof address === 'object') {
    const addressFields = ['line1', 'line2', 'city', 'state', 'zip', 'country']
    for (const k of addressFields) {
      if (address[k] != null) {
        $set[`billingAddress.${k}`] = address[k]
        hasAddressUpdate = true
      }
    }
    if (hasAddressUpdate) {
      $set['shippingAddress'] = null
      $set['shippingSameAsBilling'] = true
      addressToSync = address
    }
  }

  // ── Card / payment fields ─────────────────────────────────────────────────
  const paymentKeys = ['method', 'cardholderName', 'cardBrand', 'cardLast4', 'paymentToken']

  hasPaymentUpdate = paymentKeys.some((k) => payment[k] != null && payment[k] !== '')
  if (hasPaymentUpdate) {
    for (const k of paymentKeys) {
      const v = payment[k]
      if (v != null && v !== '') {
        $set[`payment.${k}`] = v
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

  if (!hasProfileUpdate && !hasAddressUpdate && !hasPaymentUpdate && !hasTaxUpdate) {
    return sendResponse(400, 'error', 'No fields to update', null)
  }

  // ── Persist to MongoDB ────────────────────────────────────────────────────
  try {
    await WholesaleApplication.updateOne({ _id: doc._id }, { $set })
  } catch (e) {
    console.error('[proxy/update-profile] mongo update failed:', e)
    return sendResponse(500, 'error', 'Failed to save update', { detail: e.message })
  }

  // ── Sync to Shopify (address + note) ─────────────────────────────────────
  if (hasTaxUpdate || hasAddressUpdate || hasProfileUpdate) {
    const customerId = shopifyGid || doc.customerId
    if (customerId) {
      // Push updated default address to Shopify
      if (addressToSync) {
        try {
          await customerUpdateDefaultAddress(admin, { customerId, address: addressToSync })
        } catch (e) {
          console.error('[proxy/update-profile] shopify address update failed:', e?.message || e)
        }
      }

      // Rebuild and push customer note
      try {
        const merged = {
          ...doc.toObject(),
          tax: {
            ...(doc.tax?.toObject?.() ?? doc.tax ?? {}),
            ...Object.fromEntries(taxKeys.filter((k) => tax[k] != null && tax[k] !== '').map((k) => [k, tax[k]])),
          },
        }
        const note = buildShopifyNote(merged)
        await customerUpdateNote(admin, { customerId, note })
      } catch (e) {
        console.error('[proxy/update-profile] shopify note sync failed:', e?.message || e)
      }
    }
  }

  // ── Realign open invoices to the new payment preference ──────────────────
  //
  // `doc` is the PRE-update snapshot, so doc.payment.method is the old
  // method. If the customer actually changed their method, realign all of
  // their unpaid/open invoices (recompute fee + due date, sync QBO, audit).
  // Best-effort: a QBO hiccup must never fail the profile save the customer
  // just made — we already persisted above. The summary rides along in the
  // response so the storefront can surface "N invoices updated".
  let paymentMethodRealign = null
  if (hasPaymentUpdate && payment.method != null && payment.method !== '') {
    const oldMethod = normalizePaymentMethod(doc.payment?.method)
    const requestedMethod = normalizePaymentMethod(payment.method)
    if (oldMethod !== requestedMethod) {
      if (!doc.shop) {
        console.warn('[proxy/update-profile] cannot realign invoices — application has no shop')
      } else {
        try {
          paymentMethodRealign = await applyPaymentPreferenceToOpenInvoices({
            shop: doc.shop,
            email,
            newMethod: requestedMethod,
            performedBy: email,
            source: 'customer',
          })
        } catch (e) {
          console.error('[proxy/update-profile] invoice realign failed:', e?.message || e)
        }
      }
    }
  }

  // ── Build response ────────────────────────────────────────────────────────
  const updatedDoc = doc.toObject()
  for (const [key, val] of Object.entries($set)) {
    const parts = key.split('.')
    if (parts.length === 1) {
      updatedDoc[key] = val
    } else {
      updatedDoc[parts[0]] = { ...(updatedDoc[parts[0]] ?? {}), [parts[1]]: val }
    }
  }
  delete updatedDoc.passwordHash
  if (updatedDoc.payment) delete updatedDoc.payment.cardNumber

  return sendResponse(200, 'success', 'Profile updated', {
    profile: {
      firstName: updatedDoc.firstName,
      lastName: updatedDoc.lastName,
      phone: updatedDoc.phone,
      businessName: updatedDoc.businessName,
    },
    address: updatedDoc.billingAddress ?? null,
    payment: updatedDoc.payment ?? null,
    tax: updatedDoc.tax ?? null,
    paymentMethodRealign,
  })
}

export async function loader() {
  return sendResponse(405, 'error', 'Method not allowed', null)
}
