// HTTP client for the Client Portal backend (ns-retail app's
// /api/client-portal/* routes), reached via Shopify App Proxy from the
// storefront — `fetch('/apps/<proxyBase>/api/client-portal/<path>')`.
// Shopify's edge signs the request and injects `logged_in_customer_id`
// server-side; there is NO Authorization header and NO session token to
// manage here.
//
// PROXY_BASE must MATCH the subpath in ns-retail/shopify.app.toml
// ([app_proxy] subpath = "retail-signup"). Read from a build-time env var
// so it can't drift out of sync — mirrors practitioner-code-form/src/
// services/ApiService.js's VITE_RETAIL_PROXY_SUBPATH convention (not a
// runtime Liquid-block setting, per this repo's zero-merchant-settings law).
const PROXY_BASE = import.meta.env.VITE_RETAIL_PROXY_SUBPATH || 'retail-signup'

// Typed error so callers can branch on the HTTP status (e.g. 401 → sign in)
// and still read the server message + body.
export class ApiError extends Error {
  constructor(httpStatus, message, body) {
    super(message || `Request failed (${httpStatus})`)
    this.name = 'ApiError'
    this.httpStatus = httpStatus
    this.body = body
  }
}

function buildUrl(path, params) {
  const url = new URL(`/apps/${PROXY_BASE}/api/client-portal/${path}`, window.location.origin)
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
