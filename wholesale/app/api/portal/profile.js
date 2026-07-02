// POST /api/portal/profile
//
// Single endpoint for the customer-account profile-update extension.
// Two operations discriminated by `action` in the body:
//
//   • action: "fetch"   → returns the masked profile (for autofill)
//   • action: "update"  → applies a partial update to the WholesaleApplication
//
// Auth: session-token JWT sent as `Authorization: Bearer <jwt>`. The token
// is validated via `authenticate.public.customerAccount(request)`; we read
// the customer GID from the token's `sub` claim. Body's `customerId` is
// accepted as a fallback when token validation can't yield a usable GID
// (e.g. shape variance during early Shopify rollouts).
//
// CORS: every response goes out through `sendResponse` (which already
// carries `Access-Control-Allow-Origin: *`). The OPTIONS preflight is
// answered in BOTH `loader` and `action` — React Router 7 routes OPTIONS
// inconsistently depending on the adapter version, so we belt-and-
// suspenders to guarantee preflight always succeeds.

import { authenticate, unauthenticated } from '../../shopify.server'
import { sendResponse } from '../../services/APIService/api.service'
import connectDB from '../../services/APIService/mongo.service'
import WholesaleApplication from '../../models/wholesaleApplication.server'
import {
  maskedProfileForRead,
  updateProfileApplication,
} from '../../services/profile/profile.service'

// Wildcard preflight response shared by loader + action. sendResponse
// adds the CORS headers automatically — that's all the browser needs
// for the preflight. We use 200 (not 204) because the Response constructor
// rejects a non-empty body with 204 (HTTP spec: 204 = No Content), and
// sendResponse always serializes a JSON envelope. The browser doesn't
// care about the body or specific 2xx code for preflights.
function corsPreflight() {
  return sendResponse(200, 'success', 'CORS preflight', null)
}

// Normalize a customer id. Accepts the full GID
// (`gid://shopify/Customer/123`) or just the numeric id (`"123"`).
function toCustomerGid(raw) {
  const v = String(raw || '').trim()
  if (!v) return null
  if (v.startsWith('gid://shopify/Customer/')) return v
  if (/^\d+$/.test(v)) return `gid://shopify/Customer/${v}`
  return null
}

async function parseBody(request) {
  const contentType = request.headers.get('content-type') || ''
  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData()
    let payload = {}
    const rawPayload = form.get('payload')
    if (typeof rawPayload === 'string') {
      try {
        payload = JSON.parse(rawPayload)
      } catch {
        /* leave payload empty */
      }
    }
    const files = { credentialFiles: {} }
    for (const [key, value] of form.entries()) {
      if (key === 'payload') continue
      if (value instanceof File) {
        if (key === 'w9SignatureFile') {
          files.w9SignatureFile = value
        } else if (key.startsWith('credentialFile:')) {
          files.credentialFiles[key.slice('credentialFile:'.length)] = value
        }
      }
    }
    return { payload, files }
  }
  try {
    return { payload: await request.json(), files: {} }
  } catch {
    return { payload: {}, files: {} }
  }
}

// Try to find the practitioner's application using BOTH token.sub and
// body.customerId. Returns:
//   { application, source, tried: [string], gids: { fromToken, fromBody } }
// `application` is null if no record matches either id.
async function resolveApplication(sessionToken, body) {
  const fromToken = toCustomerGid(sessionToken?.sub)
  const fromBody = toCustomerGid(body?.customerId)
  const candidates = []
  if (fromToken) candidates.push({ gid: fromToken, source: 'token.sub' })
  if (fromBody && fromBody !== fromToken) candidates.push({ gid: fromBody, source: 'body.customerId' })

  await connectDB()
  for (const c of candidates) {
    const application = await WholesaleApplication.findOne({ customerId: c.gid })
    if (application) {
      return {
        application,
        source: c.source,
        tried: candidates.map((x) => x.gid),
        gids: { fromToken, fromBody },
      }
    }
  }
  return {
    application: null,
    source: null,
    tried: candidates.map((x) => x.gid),
    gids: { fromToken, fromBody },
  }
}

export async function action({ request }) {
  // CORS preflight FIRST — preflight carries no Authorization header
  // so the JWT validation below would otherwise reject it.
  if (request.method === 'OPTIONS') return corsPreflight()
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  // ── JWT auth ─────────────────────────────────────────────────────────
  let sessionToken
  try {
    const result = await authenticate.public.customerAccount(request)
    sessionToken = result.sessionToken
  } catch (e) {
    console.warn('[portal/profile] customer-account auth failed:', e?.message || e)
    return sendResponse(401, 'error', 'Please sign in to update your profile.', null)
  }

  const { payload, files } = await parseBody(request)
  const { action: actionType } = payload || {}

  // ── Resolve practitioner — try token.sub first, fall back to body ──
  const resolution = await resolveApplication(sessionToken, payload)
  if (!resolution.application) {
    console.warn('[portal/profile] no application found', {
      tried: resolution.tried,
      tokenSub: sessionToken?.sub,
      bodyCustomerId: payload?.customerId,
    })
    return sendResponse(404, 'error', 'Application not found for this customer', {
      tried: resolution.tried,
      hint:
        'Verify the practitioner has completed the wholesale registration form (WholesaleApplication.customerId must match the customer GID).',
    })
  }
  const application = resolution.application

  if (application.status !== 'approved') {
    return sendResponse(
      403,
      'error',
      'Your account is not an approved practitioner',
      { status: application.status },
    )
  }

  // ── FETCH: return the masked profile for autofill ──────────────────
  if (!actionType || actionType === 'fetch') {
    return sendResponse(200, 'success', 'Profile loaded', maskedProfileForRead(application))
  }

  // ── UPDATE: apply partial changes ──────────────────────────────────
  if (actionType === 'update') {
    let admin = null
    try {
      const targetShop = application.shop
      if (targetShop) {
        const session = await unauthenticated.admin(targetShop)
        admin = session.admin
      }
    } catch (err) {
      console.warn('[portal/profile] admin client unavailable:', err?.message || err)
    }

    const result = await updateProfileApplication({
      application,
      payload,
      admin,
      files,
      performedBy: application.email || String(application._id),
    })

    return sendResponse(
      result.ok ? 200 : 400,
      result.ok ? 'success' : 'partial',
      'Profile updated',
      {
        ok: result.ok,
        profile: result.updatedDoc,
        paymentMethodRealign: result.paymentMethodRealign,
        fileUploads: result.fileUploads,
        errors: result.errors,
        warnings: result.warnings || [],
      },
    )
  }

  return sendResponse(400, 'error', `Unknown action: ${actionType}`, null)
}

// React Router 7 routes OPTIONS to `loader` in some adapter versions
// (and to `action` in others). Handle it in both so the preflight is
// always answered with CORS headers, never a 405.
export async function loader({ request }) {
  if (request.method === 'OPTIONS') return corsPreflight()
  return sendResponse(405, 'error', 'Method not allowed — use POST', null)
}
