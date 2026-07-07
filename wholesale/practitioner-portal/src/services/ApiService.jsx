// HTTP client for the Practitioner Portal backend (wholesale app's
// /api/portal/* routes), reached via Shopify App Proxy from the storefront —
// `fetch('/apps/<proxyBase>/api/portal/<path>')`. Shopify's edge signs the
// request and injects `logged_in_customer_id` server-side; there is NO
// Authorization header and NO session token to manage here (unlike the
// ns-retail Customer Account extension this was ported from, which used
// shopify.sessionToken.get()). Mirrors registration-form/src/services/
// ApiService.jsx's proxy-relative fetch pattern.

let PROXY_BASE = 'wholesale-application'

// Called once at boot (see main.jsx) with the block-setting value.
export function configureApi({ proxyBase } = {}) {
  if (proxyBase) PROXY_BASE = proxyBase
}

// Typed error so callers can branch on the HTTP status (e.g. 401 → sign in,
// 403 → access restricted) and still read the server message + body.
export class ApiError extends Error {
  constructor(httpStatus, message, body) {
    super(message || `Request failed (${httpStatus})`)
    this.name = 'ApiError'
    this.httpStatus = httpStatus
    this.body = body
  }
}

function buildUrl(path, params) {
  const url = new URL(`/apps/${PROXY_BASE}/api/portal/${path}`, window.location.origin)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }
  }
  return url.toString()
}

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

export async function apiGet(path, params) {
  let res
  try {
    res = await fetch(buildUrl(path, params), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
  } catch (err) {
    throw new ApiError(0, 'Network error. Please try again.', { err: String(err) })
  }
  return parseResponse(res)
}

export async function apiPost(path, payload) {
  let res
  try {
    res = await fetch(buildUrl(path), {
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
