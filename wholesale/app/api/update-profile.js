import { authenticate } from '../shopify.server'
import connectDB from '../services/APIService/mongo.service'
import WholesaleApplication from '../models/wholesaleApplication.server'
import { sendResponse } from '../services/APIService/api.service'
import { buildShopifyNote } from '../services/shopify/shopify.utils'
import { customerUpdateNote, customerUpdateDefaultAddress } from '../utils/shopifyCustomer'
import { normalizePaymentMethod } from '../services/customer/customer.utils'
import { applyPaymentPreferenceToOpenInvoices } from '../services/invoice/paymentPreference.service'
import { encryptField } from '../utils/crypto.utils'

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
    commission,
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
  const $unset = {}
  let hasProfileUpdate = false
  let hasAddressUpdate = false
  let hasPaymentUpdate = false
  let hasTaxUpdate = false
  let hasCommissionUpdate = false

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

  // ── Commission payout (ACH | Check) ──────────────────────────────────────
  //
  // Mirrors `app/api/registration-form.js` lines 216–282. Two branches:
  //   • payoutMethod === 'ach'   → save bank fields; if a new account
  //                                 number is included, AES-256-GCM encrypt
  //                                 it and store last4. Empty bankAccountNumber
  //                                 means "no change" → existing encrypted
  //                                 account is preserved.
  //   • payoutMethod === 'check' → save check.payableTo + mailing address
  //                                 (resolved against billingAddress when
  //                                 useBillingAddress=true).
  // Whichever branch the client picks, the OTHER branch's stored fields
  // are wiped via $unset so the doc only carries the selected method's
  // data (matches registration-form's branch-wipe behavior).
  if (commission && typeof commission === 'object') {
    const c = commission
    const method = c.payoutMethod === 'check' ? 'check' : 'ach'

    $set['commission.payoutMethod'] = method
    $set['commission.enabled'] = c.enabled !== false
    $set['commission.updatedAt'] = new Date()
    hasCommissionUpdate = true

    if (method === 'ach') {
      // ── ACH branch — write bank fields, encrypt new account number ──
      //
      // sourcedFromPaymentAch: when true, derive bank* from the doc's
      // payment.ach.* instead of trusting the client (defense in depth —
      // client mirrors them on tick, but server is the source of truth).
      const useSourceFromPayment = !!c.sourcedFromPaymentAch
      const paymentAch = doc.payment?.ach?.toObject?.() ?? doc.payment?.ach ?? {}

      if (useSourceFromPayment) {
        $set['commission.bankAccountName'] = paymentAch.achAccountName || c.bankAccountName || ''
        $set['commission.bankRoutingNumber'] = paymentAch.achRoutingNumber || c.bankRoutingNumber || ''
        $set['commission.bankAccountType'] = paymentAch.achAccountType || c.bankAccountType || ''
      } else {
        // Treat blank submit as "no change" — preserves existing fields
        // when the user only updates one piece. Empty-string overwrite
        // requires the user to send a NULL (explicit clear) instead.
        if (c.bankAccountName && String(c.bankAccountName).trim()) {
          $set['commission.bankAccountName'] = c.bankAccountName
        }
        if (c.bankRoutingNumber && String(c.bankRoutingNumber).trim()) {
          $set['commission.bankRoutingNumber'] = c.bankRoutingNumber
        }
        if (c.bankAccountType && String(c.bankAccountType).trim()) {
          $set['commission.bankAccountType'] = c.bankAccountType
        }
      }
      $set['commission.sourcedFromPaymentAch'] = useSourceFromPayment

      const rawAccount = String(c.bankAccountNumber || '').replace(/\D/g, '')
      const hasExistingEncrypted = !!doc.commission?.bankAccountEncrypted

      // Integrity guard — block ACH save with no encrypted account on
      // file AND no new account number. Otherwise the doc would carry
      // payoutMethod='ach' with no decryptable account → payout failures.
      // This typically catches the Check→ACH switch flow (the prior $unset
      // wiped the encrypted value, so the user MUST resupply it).
      if (!rawAccount && !hasExistingEncrypted && !useSourceFromPayment) {
        return sendResponse(
          400,
          'error',
          'Bank account number is required when switching to ACH for the first time. ' +
            'Please enter your bank account number.',
          null,
        )
      }

      if (rawAccount) {
        $set['commission.bankAccountLast4'] = rawAccount.slice(-4)
        try {
          $set['commission.bankAccountEncrypted'] = encryptField(rawAccount)
        } catch (err) {
          console.error('[proxy/update-profile] commission.encrypt_failed:', err?.message || err)
          return sendResponse(
            500,
            'error',
            'Could not securely save your commission bank account.',
            null,
          )
        }
      }
      // Empty bankAccountNumber → keep existing encrypted account.

      // Wipe the Check branch — only the selected method's data remains.
      $unset['commission.check'] = ''
    } else {
      // ── Check branch — payableTo + mailing address ──────────────────
      // Require an explicit `check` object — otherwise the doc would
      // be mutated using inferred defaults (firstName+lastName as payableTo,
      // billing address as mailing) without the user opting in.
      if (!c.check || typeof c.check !== 'object') {
        return sendResponse(
          400,
          'error',
          'Check payout details are required (payableTo + mailing address).',
          null,
        )
      }
      const chk = c.check
      const useBilling = chk.useBillingAddress !== false // default true

      // Mailing address: when useBillingAddress=true, copy the billing
      // address that's about to be saved. The incoming `address` body
      // may be PARTIAL (only the fields the user touched), so merge it
      // over the doc's existing billingAddress — the doc is the baseline
      // and any in-flight changes overlay on top. Billing — NOT shipping
      // — is the financial-mail address, matching where 1099s + check
      // stubs go (registration-form precedent).
      let mailing
      if (useBilling) {
        const billingBaseline = doc.billingAddress?.toObject?.() ?? doc.billingAddress ?? {}
        const billingIncoming = address && typeof address === 'object' ? address : {}
        const billingSource = { ...billingBaseline, ...billingIncoming }
        mailing = {
          line1: billingSource.line1 || '',
          line2: billingSource.line2 || '',
          city: billingSource.city || '',
          state: billingSource.state || '',
          zip: billingSource.zip || '',
          country: billingSource.country || '',
        }
      } else {
        const m = chk.mailingAddress || {}
        mailing = {
          line1: m.line1 || '',
          line2: m.line2 || '',
          city: m.city || '',
          state: m.state || '',
          zip: m.zip || '',
          country: m.country || '',
        }
      }

      const payableTo =
        chk.payableTo && String(chk.payableTo).trim()
          ? String(chk.payableTo).trim()
          : `${doc.firstName || ''} ${doc.lastName || ''}`.trim()

      $set['commission.check'] = {
        payableTo,
        useBillingAddress: useBilling,
        mailingAddress: mailing,
      }

      // Wipe the ACH branch — only the selected method's data remains.
      $unset['commission.bankAccountName'] = ''
      $unset['commission.bankRoutingNumber'] = ''
      $unset['commission.bankAccountEncrypted'] = ''
      $unset['commission.bankAccountLast4'] = ''
      $unset['commission.bankAccountType'] = ''
      $unset['commission.sourcedFromPaymentAch'] = ''
    }
  }

  if (
    !hasProfileUpdate &&
    !hasAddressUpdate &&
    !hasPaymentUpdate &&
    !hasTaxUpdate &&
    !hasCommissionUpdate
  ) {
    return sendResponse(400, 'error', 'No fields to update', null)
  }

  // ── Persist to MongoDB ────────────────────────────────────────────────────
  try {
    const update = { $set }
    if (Object.keys($unset).length > 0) update.$unset = $unset
    await WholesaleApplication.updateOne({ _id: doc._id }, update)
  } catch (e) {
    console.error('[proxy/update-profile] mongo update failed:', e)
    return sendResponse(500, 'error', 'Failed to save update', { detail: e.message })
  }

  // ── Sync to Shopify (address + note) ─────────────────────────────────────
  // NOTE: hasCommissionUpdate is intentionally NOT included — buildShopifyNote
  // doesn't write commission fields, so a commission-only update would burn
  // a Shopify Admin API call to re-push the same note.
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
  // Reflect $unset in the projected response so the client sees the same
  // post-save shape Mongo now holds (avoids stale branch leaking into UI).
  for (const key of Object.keys($unset)) {
    const parts = key.split('.')
    if (parts.length === 1) {
      delete updatedDoc[key]
    } else if (updatedDoc[parts[0]]) {
      delete updatedDoc[parts[0]][parts[1]]
    }
  }
  delete updatedDoc.passwordHash
  if (updatedDoc.payment) delete updatedDoc.payment.cardNumber
  // Never echo the encrypted account back to the client.
  if (updatedDoc.commission) delete updatedDoc.commission.bankAccountEncrypted

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
    commission: updatedDoc.commission ?? null,
    paymentMethodRealign,
  })
}

export async function loader() {
  return sendResponse(405, 'error', 'Method not allowed', null)
}
