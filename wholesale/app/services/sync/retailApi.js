import { syncConfig } from './sync.config'
import { PermanentError, TransientError } from '../../utils/retry.utils'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('sync.retail_api')

// Lightweight fetch wrapper for the retail store's Admin REST API.
// GraphQL is used for wholesale (via the Shopify app session), but REST
// is simpler here since we hold a direct access token for retail.
//
// Resilience (added 2026-07-15): every call retries transient failures —
// 429 rate limits (honoring Shopify's Retry-After header), 5xx responses,
// and network errors — with exponential backoff + jitter, up to MAX_ATTEMPTS.
// Other 4xx responses (bad payload, 404, auth) are permanent and thrown
// immediately. This matters because sync callers are fire-and-forget off
// webhooks: without retries, a single rate-limit response during a bulk
// catalog operation silently dropped that sync event forever (Shopify has
// already received our 200, so it never redelivers).
const MAX_ATTEMPTS = 5
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 8000

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function callOnce(path, { method = 'GET', body } = {}) {
  const { retailShop, retailAccessToken, apiVersion } = syncConfig
  const url = `https://${retailShop}/admin/api/${apiVersion}/${path}`
  let res
  try {
    res = await fetch(url, {
      method,
      headers: {
        'X-Shopify-Access-Token': retailAccessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    // DNS / connection / abort — always worth retrying.
    throw new TransientError(`Retail API ${method} /${path} network error: ${err?.message || err}`, { cause: err })
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const message = `Retail API ${method} /${path} → ${res.status}: ${text.slice(0, 300)}`
    if (res.status === 429) {
      // Shopify's Retry-After is in seconds (may be fractional).
      const retryAfterSec = Number(res.headers.get('retry-after'))
      const err = new TransientError(message, { status: 429 })
      err.retryAfterMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? Math.min(Math.round(retryAfterSec * 1000), MAX_DELAY_MS * 2)
        : null
      throw err
    }
    if (res.status >= 500) throw new TransientError(message, { status: res.status })
    throw new PermanentError(message, { status: res.status })
  }

  const ct = res.headers.get('content-type') || ''
  if (!ct.includes('json') || res.status === 204) return null
  return res.json()
}

async function call(path, opts = {}) {
  let lastErr
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await callOnce(path, opts)
    } catch (err) {
      lastErr = err
      if (err?.permanent || attempt === MAX_ATTEMPTS) throw err
      // Prefer the server-provided Retry-After (429), else backoff + jitter.
      const backoff = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1))
      const delay = err?.retryAfterMs ?? Math.round(backoff * (0.75 + Math.random() * 0.5))
      log.warn('retry', {
        path,
        method: opts.method || 'GET',
        attempt,
        status: err?.status ?? null,
        nextDelayMs: delay,
        err: err?.message,
      })
      await sleep(delay)
    }
  }
  throw lastErr
}

export const retailClient = {
  get: (path) => call(path),
  post: (path, body) => call(path, { method: 'POST', body }),
  put: (path, body) => call(path, { method: 'PUT', body }),
  delete: (path) => call(path, { method: 'DELETE' }),
}
