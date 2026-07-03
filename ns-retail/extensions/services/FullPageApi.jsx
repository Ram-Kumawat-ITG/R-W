// ─────────────────────────────────────────────────────────────────────────────
// FullPageApi — centralized HTTP client for the ns-retail app backend, shared
// across the ns-retail UI extensions.
//
// This is the ns-retail analog of wholesale/extensions/services/FullPageApi.jsx.
// It lives OUTSIDE any single extension (in extensions/services/) so every
// extension can import it via a relative path and reuse one consistent API
// surface instead of re-inlining fetch() plumbing:
//
//   import FullPageApi from "../../services/FullPageApi.jsx"
//   const api = new FullPageApi()
//   const profile = await api.getProfile()
//
// Or use the exported low-level primitives directly for ad-hoc endpoints:
//
//   import { apiGet, apiPost, ApiError } from "../../services/FullPageApi.jsx"
//
// Every call:
//   1. Builds the absolute URL `${SERVER_URL}/api/portal/<name>`.
//   2. Attaches a fresh session-token JWT as `Authorization: Bearer <token>`.
//   3. Fetches it.
//   4. Returns the parsed `result` payload, or throws a typed `ApiError`.
//
// Auth — Customer Account UI extension surface. Identity is NEVER sent from the
// client. Each call requests a fresh session token (they expire in ~5 min, so
// one per call; Shopify caches it) and the backend verifies it via
// `authenticate.public.customerAccount` and reads the `sub` claim to identify
// the practitioner.
//
// SERVER_URL — the absolute base URL of the ns-retail app backend, baked in
// here (the extension's Web Worker sandbox has no `process.env`, so the URL
// must live in the source). `npm run sync:extension-app-url` (wired into the
// `predev`/`predeploy` hooks — see scripts/sync-extension-app-url.js) keeps
// this literal in sync with the current dev tunnel / production application_url
// automatically; you should not need to hand-edit it.
// ─────────────────────────────────────────────────────────────────────────────

const SERVER_URL = "https://issn-sole-slot-definition.trycloudflare.com" 
// Typed error so callers can branch on the HTTP status (e.g. 401 → sign in,
// 403 → access restricted) and still read the server message + body.
export class ApiError extends Error {
  /**
   * @param {number} httpStatus
   * @param {string} [message]
   * @param {any} [body]
   */
  constructor(httpStatus, message, body) {
    super(message || `Request failed (${httpStatus})`)
    this.name = 'ApiError'
    this.httpStatus = httpStatus
    this.body = body
  }
}

function baseUrl() {
  return String(SERVER_URL || '').replace(/\/+$/, '')
}

/**
 * @param {string} path                       endpoint name under /api/portal/
 * @param {Record<string, any>} [params]      query-string params (empties dropped)
 * @returns {string}
 */
function buildUrl(path, params) {
  const base = baseUrl()
  if (!base) {
    throw new ApiError(0, 'Portal is not configured (missing app backend URL).')
  }
  const url = new URL(`${base}/api/portal/${path}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }
  }
  return url.toString()
}

/** @returns {Promise<string>} a fresh session-token JWT */
async function getSessionToken() {
  try {
    return await shopify.sessionToken.get()
  } catch {
    throw new ApiError(401, 'Could not authenticate your session. Please sign in again.')
  }
}

/**
 * @param {Response} res
 * @returns {Promise<any>} the response `result`, or throws ApiError on !ok
 */
async function parseResponse(res) {
  let body = null
  try {
    body = await res.json()
  } catch {
    // non-JSON response
  }
  if (!res.ok) {
    throw new ApiError(res.status, body?.message || `Request failed (${res.status})`, body)
  }
  return body?.result ?? null
}

// ── Low-level primitives ─────────────────────────────────────────────────────
// Exported standalone so callers can use them directly for any endpoint not
// covered by a named method (and so the portal's generic data hook can fetch by
// a dynamic path).

/**
 * GET a portal endpoint.
 * @param {string} path
 * @param {Record<string, any>} [params]
 * @returns {Promise<any>}
 */
export async function apiGet(path, params) {
  const url = buildUrl(path, params)
  const token = await getSessionToken()

  let res
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
  } catch (err) {
    throw new ApiError(0, 'Network error. Please try again.', { err: String(err) })
  }
  return parseResponse(res)
}

/**
 * GET a PUBLIC endpoint under a custom sub-path (e.g. `/api/cdo/fee-tiers`).
 * Unlike `apiGet`, no session-token is attached — for endpoints that expose
 * public, non-PII data (or ones that need to be callable from checkout UI
 * extensions where the customer-account session token isn't available).
 *
 * @param {string} fullPath  absolute path under the app backend, e.g. "/api/cdo/fee-tiers"
 * @param {Record<string, any>} [params]  query-string params (empties dropped)
 * @returns {Promise<any>}  the response `result`, or throws ApiError on !ok
 */
export async function apiPublicGet(fullPath, params) {
  const base = baseUrl()
  if (!base) {
    throw new ApiError(0, 'App backend URL is not configured.')
  }
  const url = new URL(`${base}${fullPath.startsWith('/') ? fullPath : `/${fullPath}`}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }
  }

  let res
  try {
    res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
  } catch (err) {
    throw new ApiError(0, 'Network error. Please try again.', { err: String(err) })
  }
  return parseResponse(res)
}

/**
 * POST a JSON body to a PUBLIC endpoint under a custom sub-path
 * (e.g. `/api/cdo/fee-variant`). No session-token attached — matches
 * the auth surface of `apiPublicGet`.
 *
 * @param {string} fullPath  absolute path under the app backend
 * @param {Record<string, any>} [payload]
 * @returns {Promise<any>}
 */
export async function apiPublicPost(fullPath, payload) {
  const base = baseUrl()
  if (!base) {
    throw new ApiError(0, 'App backend URL is not configured.')
  }
  const url = `${base}${fullPath.startsWith('/') ? fullPath : `/${fullPath}`}`

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload || {}),
    })
  } catch (err) {
    throw new ApiError(0, 'Network error. Please try again.', { err: String(err) })
  }
  return parseResponse(res)
}

/**
 * POST a JSON body to a portal endpoint. Same Bearer-token auth as apiGet; the
 * Authorization header + JSON content-type make this a "non-simple" request, so
 * the browser sends a CORS preflight first (answered by the backend guard).
 * @param {string} path
 * @param {Record<string, any>} [payload]
 * @returns {Promise<any>}
 */
export async function apiPost(path, payload) {
  const url = buildUrl(path)
  const token = await getSessionToken()

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload || {}),
    })
  } catch (err) {
    throw new ApiError(0, 'Network error. Please try again.', { err: String(err) })
  }
  return parseResponse(res)
}

// ─────────────────────────────────────────────────────────────────────────────
// FullPageApi — one method per Practitioner-Portal backend endpoint.
//
//   const api = new FullPageApi()
//   const summary = await api.getSummary()
// ─────────────────────────────────────────────────────────────────────────────
export default class FullPageApi {
  // Static helper exposed so non-API callers can build URLs to the same backend.
  static getAppBaseUrl() {
    return baseUrl()
  }

  // ── Generic escape hatches ─────────────────────────────────────────────────
  /**
   * @param {string} path
   * @param {Record<string, any>} [params]
   */
  get(path, params) {
    return apiGet(path, params)
  }

  /**
   * @param {string} path
   * @param {Record<string, any>} [payload]
   */
  post(path, payload) {
    return apiPost(path, payload)
  }

  // ── Profile / identity ─────────────────────────────────────────────────────
  // Resolves the signed-in practitioner; throws ApiError(403) when the customer
  // is not an approved practitioner, ApiError(401) when not signed in.
  getProfile() {
    return apiGet('me')
  }

  // ── Dashboard ──────────────────────────────────────────────────────────────
  getSummary() {
    return apiGet('summary')
  }

  /**
   * @param {{ from?: string, to?: string }} [range] YYYY-MM-DD window; omit for default
   */
  getRevenue(range) {
    return apiGet('revenue', range)
  }

  // ── Patients (referred customers) ──────────────────────────────────────────
  /**
   * @param {{ search?: string, page?: number, pageSize?: number }} [params]
   */
  getCustomers(params) {
    return apiGet('customers', params)
  }

  // ── Commissions ────────────────────────────────────────────────────────────
  /**
   * @param {{ pendingOnly?: string, from?: string, to?: string, page?: number, pageSize?: number }} [params]
   */
  getCommissions(params) {
    return apiGet('commissions', params)
  }

  // ── Payouts ────────────────────────────────────────────────────────────────
  /**
   * @param {{ status?: string, from?: string, to?: string, page?: number, pageSize?: number }} [params]
   */
  getPayouts(params) {
    return apiGet('payouts', params)
  }

  // ── Referral codes (read) ──────────────────────────────────────────────────
  getReferrals() {
    return apiGet('referrals')
  }

  // ── Discounts (read) ───────────────────────────────────────────────────────
  getDiscounts() {
    return apiGet('discounts')
  }

  // ── Referral codes (self-service writes) ───────────────────────────────────
  // Create a new referral code at the given discount percentage (0–1 or whole
  // percent — the backend normalizes; callers pass what the portal collects).
  /**
   * @param {{ code: string, discountPercent: number | string }} args
   */
  createReferral({ code, discountPercent }) {
    return apiPost('referrals', { op: 'create', code, discountPercent })
  }

  /** @param {string} codeId */
  pauseReferral(codeId) {
    return apiPost('referrals', { op: 'pause', codeId })
  }

  /** @param {string} codeId */
  resumeReferral(codeId) {
    return apiPost('referrals', { op: 'resume', codeId })
  }

  // ── Processing Fee variant — on-demand (PUBLIC, no auth) ───────────────────
  // Resolves (or creates) a Processing Fee variant at EXACTLY the requested
  // cent-precise price. Backend caches an in-memory price → GID map and
  // creates a new variant via Admin API on cache miss (LRU-evicting the
  // oldest variant when the product hits its variant-count cap).
  //
  /**
   * @param {number} price   e.g. 28.42
   * @returns {Promise<{ price: number, gid: string, source: string }>}
   */
  getFeeVariant(price) {
    return apiPublicPost('/api/cdo/fee-variant', { price })
  }
}
