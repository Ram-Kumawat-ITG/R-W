/* global shopify */
// Fetch client for the Practitioner Portal backend (/api/portal/*).
//
// Auth: each call attaches a fresh session-token JWT as a Bearer token
// (tokens expire in ~5 min, so we request one per call — shopify caches it).
// The backend verifies the token via authenticate.public.customerAccount and
// reads the `sub` claim to identify the practitioner. Identity is never sent
// from the client.
//
// Base URL comes from the merchant-configured `api_base_url` extension setting,
// or, in dev, from the manual `DEV_API_BASE_URL` override in ./config.js (which
// wins when set — see that file for the per-session workflow).

import { DEV_API_BASE_URL } from './config.js'

export class ApiError extends Error {
  constructor(httpStatus, message, body) {
    super(message || `Request failed (${httpStatus})`)
    this.name = 'ApiError'
    this.httpStatus = httpStatus
    this.body = body
  }
}

function baseUrl() {
  // Dev override (config.js) wins when set; otherwise the merchant-set setting.
  const configured = DEV_API_BASE_URL || shopify?.settings?.value?.api_base_url
  return String(configured || '').replace(/\/+$/, '')
}

function buildUrl(path, params) {
  const base = baseUrl()
  if (!base) {
    throw new ApiError(0, 'Portal is not configured (missing app backend URL).')
  }
  const url = new URL(`${base}/api/portal/${path}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v)
    }
  }
  return url.toString()
}

export async function apiGet(path, params) {
  const url = buildUrl(path, params)

  let token
  try {
    token = await shopify.sessionToken.get()
  } catch {
    throw new ApiError(401, 'Could not authenticate your session. Please sign in again.')
  }

  let res
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
  } catch (err) {
    throw new ApiError(0, 'Network error. Please try again.', { err: String(err) })
  }

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
