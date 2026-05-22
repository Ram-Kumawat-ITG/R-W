import crypto from 'node:crypto'
import { authenticate } from '../shopify.server'
import connectDB from '../services/APIService/mongo.service'
import WholesaleApplication from '../models/wholesaleApplication.server'
import { sendResponse } from '../services/APIService/api.service'
import { buildShopifyNote } from '../services/shopify/shopify.utils'
import {
  createCustomer,
  sendCustomerInvite,
  uploadFileToShopify,
  ShopifyUserError,
} from '../services/shopify/shopify.service'
import { createCustomerVault } from '../services/nmi/nmi.service'

// POST /api/registration-form
// Storefront-proxied wholesale application submit. Parses the multipart
// form, uploads attached files to Shopify Files, hashes the card / password,
// persists the application, then creates a Pending Shopify customer + sends
// the "received" acknowledgement email.
export async function action({ request }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let session, admin
  try {
    const auth = await authenticate.public.appProxy(request)
    session = auth.session
    admin = auth.admin
  } catch (e) {
    console.error('[proxy/submit] appProxy auth failed:', e?.message || e)
    return sendResponse(401, 'error', 'Unauthorized', null)
  }

  if (!admin) {
    console.error('[proxy/submit] admin client unavailable from appProxy auth')
    return sendResponse(500, 'error', 'Admin client unavailable', null)
  }

  const shop = session?.shop || new URL(request.url).searchParams.get('shop') || null

  await connectDB()

  let formData
  try {
    formData = await request.formData()
  } catch (e) {
    console.error('[proxy/submit] formData parse failed:', e?.message || e)
    return sendResponse(400, 'error', 'Invalid form payload', null)
  }

  // Build nested payload from bracketed keys; collect files separately
  const payload = {}
  const fileEntries = []
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'object' && value && typeof value.arrayBuffer === 'function') {
      if (value.size > 0) fileEntries.push({ key, file: value })
      setNested(payload, key, null)
    } else {
      setNested(payload, key, coerce(value))
    }
  }

  // Upload each file to Shopify Files → get a permanent CDN URL → put it in
  // payload. Files upload in parallel; sequential awaits would multiply
  // round-trips.
  try {
    const results = await Promise.all(
      fileEntries.map(async ({ key, file }) => {
        const url = await uploadFileToShopify(admin, file)
        return { key, url }
      })
    )
    for (const { key, url } of results) {
      setNested(payload, key, url)
    }
  } catch (e) {
    console.error('[proxy/submit] upload failed:', e?.message || e)
    return sendResponse(502, 'error', 'File upload failed', {
      detail: e?.message || String(e),
    })
  }

  // Hash password before storage
  const plain = payload.password
  delete payload.password
  if (plain) {
    const salt = crypto.randomBytes(16).toString('hex')
    const derived = crypto.scryptSync(plain, salt, 64).toString('hex')
    payload.passwordHash = `scrypt:${salt}:${derived}`
  }

  // Normalise signature: prefer uploaded PNG file URL, fall back to typed text
  const signedAt = new Date()
  if (payload.signatureFile) {
    payload.signature = {
      type: 'drawn',
      value: payload.signatureFile,
      signedAt,
    }
  } else if (payload.signatureType === 'typed' && payload.signatureValue) {
    payload.signature = {
      type: 'typed',
      value: payload.signatureValue,
      signedAt,
    }
  }
  delete payload.signatureFile
  delete payload.signatureType
  delete payload.signatureValue

  payload.shop = shop

  // Reject duplicate submissions before touching Shopify
  const existing = await WholesaleApplication.findOne({ email: payload.email }).lean()
  if (existing) {
    return sendResponse(409, 'error', 'An account with this email already exists.', {
      fieldErrors: [{ field: 'email', message: 'An account with this email already exists.' }],
    })
  }

  let app
  try {
    app = await WholesaleApplication.create(payload)
  } catch (e) {
    console.error('[proxy/submit] WholesaleApplication.create failed:', e)
    return sendResponse(500, 'error', 'Failed to save application', {
      detail: e.message,
    })
  }

  // Create the customer in Shopify with the Pending tag and send the
  // "received" acknowledgement email. Approval (Approved tag + invite email)
  // happens later via the admin review action.
  let customerId = null
  try {
    if (!admin) throw new Error('admin client unavailable from appProxy auth')
    const note = buildShopifyNote(payload)
    customerId = await createCustomer(admin, {
      application: payload,
      note,
      tags: ['Pending'],
      subscribeNews: Boolean(payload.subscribeNews),
    })

    try {
      await sendCustomerInvite(admin, {
        customerId,
        subject: 'We received your wholesale application',
        message:
          "Thank you for applying to Natural Solutions Wholesale. Our team is reviewing your application and you'll hear back from us shortly.",
      })
      await WholesaleApplication.updateOne(
        { _id: app._id },
        {
          $set: {
            customerId,
            shopifyCreateFailed: false,
            shopifyCreateError: null,
          },
        }
      )
    } catch (inviteErr) {
      console.error('[proxy/submit] received email failed:', inviteErr?.message || inviteErr)
      await WholesaleApplication.updateOne(
        { _id: app._id },
        { $set: { customerId } }
      )
    }
  } catch (e) {
    console.error('[proxy/submit] customerCreate failed:', e?.message || e)

    // Shopify returned structured field errors (e.g., email/phone already taken).
    // Delete the doc we just created so the user can fix and resubmit cleanly.
    if (e instanceof ShopifyUserError) {
      await WholesaleApplication.deleteOne({ _id: app._id })
      const fieldErrors = e.userErrors.map((ue) => {
        const rawField = Array.isArray(ue.field) ? ue.field[ue.field.length - 1] : ue.field
        const field = rawField === 'phone' ? 'phone' : 'email'
        return { field, message: ue.message }
      })
      return sendResponse(409, 'error', e.userErrors[0].message, { fieldErrors })
    }

    await WholesaleApplication.updateOne(
      { _id: app._id },
      {
        $set: {
          shopifyCreateFailed: true,
          shopifyCreateError: e?.message || String(e),
        },
      }
    )
  }

  // Create NMI Customer Vault using the Collect.js payment token so the card
  // can be charged later. Non-fatal — application proceeds even if this fails.
  let nmiCustomerVaultId = null
  if (payload.payment?.paymentToken) {
    try {
      nmiCustomerVaultId = await createCustomerVault({
        profile: {
          firstName: payload.firstName,
          lastName: payload.lastName,
          email: payload.email,
          phone: payload.phone,
          companyName: payload.businessName,
          billingAddress: payload.billingAddress,
        },
        paymentDetails: { paymentToken: payload.payment.paymentToken },
      })
      await WholesaleApplication.updateOne(
        { _id: app._id },
        { $set: { nmiCustomerVaultId } },
      )
    } catch (vaultErr) {
      console.error('[proxy/submit] NMI vault create failed:', vaultErr?.message || vaultErr)
    }
  }

  return sendResponse(200, 'success', 'Application submitted', {
    id: app._id.toString(),
    customerId,
    nmiCustomerVaultId,
  })
}

export async function loader() {
  return sendResponse(405, 'error', 'Method not allowed', null)
}

// ── Form-parsing helpers (not Shopify-specific) ──────────────────────

function setNested(obj, path, value) {
  const keys = parsePath(path)
  let cur = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {}
    cur = cur[k]
  }
  cur[keys[keys.length - 1]] = value
}

function parsePath(path) {
  const out = []
  const re = /([^[\]]+)/g
  let m
  while ((m = re.exec(path)) !== null) out.push(m[1])
  return out
}

function coerce(v) {
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null') return null
  return v
}
