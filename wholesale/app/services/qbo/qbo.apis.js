// QBO HTTP client — handles OAuth2 token rotation, refresh coalescing,
// 401 retry-once, and Fault-structured error classification.
//
// Higher-level domain methods (customer / invoice / payment) live in
// qbo.service.js. This file is pure transport.

import { randomUUID } from 'node:crypto'
import { qboConfig, assertQboConfigured } from './qbo.config'
import { paymentConfig } from '../payment/payment.config'
import { ACCESS_TOKEN_SAFETY_MS } from './qbo.constants'
import { truncate } from './qbo.utils'
import { createLogger } from '../../utils/logger.utils'
import { retry, PermanentError, TransientError } from '../../utils/retry.utils'
import QboToken from '../../models/qboToken.server'

const log = createLogger('qbo.apis')

// Access tokens last 60 min; refresh tokens last 100 days and ROTATE on
// every refresh. We persist the rotated refresh token immediately so
// crash-after-refresh does not strand us with an expired access token
// and a stale refresh token.

let inFlightRefresh = null

async function readTokenDoc() {
  return QboToken.findOne({ realmId: qboConfig.realmId }).lean()
}

async function bootstrapTokenDocFromEnv() {
  // First run: no token doc exists yet. Seed from the env-provided refresh
  // token, then immediately refresh to populate access token + new refresh.
  if (!qboConfig.bootstrapRefreshToken) {
    throw new PermanentError(
      'QBO has no stored token and QBO_REFRESH_TOKEN is empty. ' +
        'Seed an initial refresh token via the Intuit OAuth Playground.',
    )
  }
  const seedDoc = await QboToken.findOneAndUpdate(
    { realmId: qboConfig.realmId },
    {
      $setOnInsert: {
        realmId: qboConfig.realmId,
        refreshToken: qboConfig.bootstrapRefreshToken,
        accessToken: 'pending',
        accessTokenExpiresAt: new Date(0),
      },
    },
    { upsert: true, new: true },
  ).lean()
  return seedDoc
}

async function refreshAccessToken(currentRefreshToken) {
  // Coalesce concurrent refreshes so we don't burn through Intuit's
  // refresh-rate limit when many jobs trigger at once (e.g. the 15th tick).
  if (inFlightRefresh) return inFlightRefresh
  inFlightRefresh = (async () => {
    const basic = Buffer.from(
      `${qboConfig.clientId}:${qboConfig.clientSecret}`,
    ).toString('base64')

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: currentRefreshToken,
    })

    const res = await fetch(qboConfig.oauthTokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    })

    const text = await res.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new TransientError(`QBO token refresh non-JSON response (${res.status})`, { status: res.status, body: text })
    }

    if (!res.ok) {
      // 400 invalid_grant → refresh token expired/revoked. Permanent.
      if (res.status === 400 || res.status === 401) {
        throw new PermanentError(`QBO token refresh failed: ${json.error || res.status}`, { status: res.status, body: json })
      }
      throw new TransientError(`QBO token refresh failed: ${json.error || res.status}`, { status: res.status, body: json })
    }

    const now = Date.now()
    const accessTokenExpiresAt = new Date(now + (json.expires_in ?? 3600) * 1000)
    const refreshTokenExpiresAt = new Date(now + (json.x_refresh_token_expires_in ?? 8726400) * 1000)

    const updated = await QboToken.findOneAndUpdate(
      { realmId: qboConfig.realmId },
      {
        $set: {
          accessToken: json.access_token,
          accessTokenExpiresAt,
          refreshToken: json.refresh_token,
          refreshTokenExpiresAt,
          tokenType: json.token_type || 'bearer',
        },
      },
      { upsert: true, new: true },
    ).lean()

    log.info('token.refreshed', { expiresAt: accessTokenExpiresAt })
    return updated
  })()
  try {
    return await inFlightRefresh
  } finally {
    inFlightRefresh = null
  }
}

async function getAccessToken() {
  assertQboConfigured()

  let doc = await readTokenDoc()
  if (!doc) doc = await bootstrapTokenDocFromEnv()

  const nowMs = Date.now()
  const expiresAt = doc.accessTokenExpiresAt?.getTime?.() ?? 0
  if (doc.accessToken && doc.accessToken !== 'pending' && expiresAt - ACCESS_TOKEN_SAFETY_MS > nowMs) {
    return doc.accessToken
  }

  const refreshed = await refreshAccessToken(doc.refreshToken)
  return refreshed.accessToken
}

function buildUrl(path, query, { requestId, method } = {}) {
  const base = `${qboConfig.apiBaseUrl}/v3/company/${qboConfig.realmId}`
  const url = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`)
  url.searchParams.set('minorversion', qboConfig.minorVersion)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    }
  }
  // QBO's `requestid` idempotency token. If the same id is sent twice
  // (e.g. our retry layer re-firing after a transient response error
  // even though QBO already committed the create), QBO returns the
  // original response instead of creating a duplicate document. The
  // id is generated ONCE per logical qboRequest() call (so all
  // internal retries share it) and only applied to mutating verbs —
  // GET / query are inherently idempotent and don't need it.
  // Docs: https://developer.intuit.com/app/developer/qbo/docs/develop/rest-api-features#idempotent-requests
  if (requestId && method !== 'GET') {
    url.searchParams.set('requestid', requestId)
  }
  return url.toString()
}

async function rawRequest({ method, path, query, body, contentType, requestId, retryOn401 = true }) {
  const accessToken = await getAccessToken()
  const url = buildUrl(path, query, { requestId, method })

  console.log(`\n[QBO →] ${method} ${path}${requestId ? ` (requestid=${requestId})` : ''}`)
  console.log(`        url: ${url}`)
  if (body) console.log(`        body: ${truncate(JSON.stringify(body), 1000)}`)

  // QBO's `/invoice/<id>/send` and `/payment/<id>/send` endpoints require
  // Content-Type: application/octet-stream on an empty POST. Callers pass
  // `contentType` explicitly for that. Default for JSON POSTs is set
  // automatically below.
  const effectiveContentType =
    contentType || (body ? 'application/json' : undefined)

  const startedAt = Date.now()
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(effectiveContentType ? { 'Content-Type': effectiveContentType } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const elapsedMs = Date.now() - startedAt

  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    if (!res.ok) throw new TransientError(`QBO ${method} ${path} non-JSON (${res.status})`, { status: res.status, body: text })
    json = null
  }

  console.log(`[QBO ←] ${method} ${path}  status=${res.status}  ${elapsedMs}ms`)
  if (!res.ok || process.env.LOG_PRETTY === 'true') {
    console.log(`        response: ${truncate(text, 1500)}`)
  }

  if (res.status === 401 && retryOn401) {
    // Token might have been invalidated mid-flight (e.g. revoked
    // elsewhere). Force-refresh once and retry. We pass the SAME
    // requestId through so the post-refresh retry stays idempotent
    // (a previous attempt with that id, if it actually committed
    // before the 401, won't be duplicated).
    console.log('[QBO]   401 received — force-refreshing token and retrying once')
    log.warn('token.invalid_retry', { path })
    const doc = await readTokenDoc()
    if (doc) await refreshAccessToken(doc.refreshToken)
    return rawRequest({ method, path, query, body, contentType, requestId, retryOn401: false })
  }

  if (!res.ok) {
    // QBO returns a structured `Fault` block for business errors.
    const fault = json?.Fault || json?.fault
    const errorDetail = fault?.Error?.[0] || fault?.error?.[0]
    const msg = errorDetail?.Message || errorDetail?.message || `QBO ${method} ${path} failed: ${res.status}`
    const ErrorClass = res.status >= 500 || res.status === 429 ? TransientError : PermanentError
    throw new ErrorClass(msg, { status: res.status, body: json ?? text })
  }

  return json
}

export async function qboRequest(opts) {
  // Generate a single idempotency token for the WHOLE logical operation
  // before entering the retry loop. Every retry attempt (including the
  // 401-refresh recursion inside rawRequest) reuses this same id, so
  // QBO can dedup retries that succeeded server-side but failed to
  // return a response to us — the classic "QBO created Payment 323
  // but our retry created Payment 324 because the first 200 never
  // arrived" duplicate.
  //
  // Callers can pin a specific id via opts.requestId if they want
  // cross-process idempotency (e.g. resuming a crashed job); otherwise
  // we make one up.
  //
  const requestId = opts.requestId || randomUUID()
  return retry(() => rawRequest({ ...opts, requestId }), {
    attempts: paymentConfig.httpRetryAttempts,
    baseMs: paymentConfig.httpRetryBaseMs,
    maxMs: paymentConfig.httpRetryMaxMs,
    onAttempt: ({ attempt, err, nextDelayMs }) => {
      log.warn('request.retry', { attempt, nextDelayMs, err, requestId })
    },
  })
}

// Same auth + 401-retry-once dance as rawRequest, but returns the raw
// bytes for non-JSON endpoints (e.g. /invoice/<id>/pdf which returns a
// PDF stream). Keeps PDF transport inside services/qbo/ so the
// "no QBO calls outside services/qbo/" rule is preserved.
async function rawBinaryRequest({ path, accept, retryOn401 = true }) {
  const accessToken = await getAccessToken()
  const url = buildUrl(path)

  console.log(`\n[QBO →] GET ${path}  (binary, accept=${accept})`)
  const startedAt = Date.now()
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: accept,
      Authorization: `Bearer ${accessToken}`,
    },
  })
  const elapsedMs = Date.now() - startedAt
  console.log(`[QBO ←] GET ${path}  status=${res.status}  ${elapsedMs}ms`)

  if (res.status === 401 && retryOn401) {
    console.log('[QBO]   401 received — force-refreshing token and retrying once')
    log.warn('token.invalid_retry', { path })
    const doc = await readTokenDoc()
    if (doc) await refreshAccessToken(doc.refreshToken)
    return rawBinaryRequest({ path, accept, retryOn401: false })
  }

  if (!res.ok) {
    const text = await res.text()
    const ErrorClass = res.status >= 500 || res.status === 429 ? TransientError : PermanentError
    throw new ErrorClass(`QBO GET ${path} failed: ${res.status}`, { status: res.status, body: truncate(text, 500) })
  }

  const arrayBuffer = await res.arrayBuffer()
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: res.headers.get('content-type') || accept,
  }
}

export async function qboGetBinary(path, { accept = 'application/octet-stream' } = {}) {
  return retry(() => rawBinaryRequest({ path, accept }), {
    attempts: paymentConfig.httpRetryAttempts,
    baseMs: paymentConfig.httpRetryBaseMs,
    maxMs: paymentConfig.httpRetryMaxMs,
    onAttempt: ({ attempt, err, nextDelayMs }) => {
      log.warn('binary.retry', { attempt, nextDelayMs, err })
    },
  })
}

// Multipart upload to QBO's /upload endpoint (Attachable + file content in
// one request). Used to attach the Immediate-Payment QR PNG to an invoice
// with IncludeOnSend=true so it rides with the emailed invoice. QBO expects
// a multipart/form-data body with two parts:
//   file_metadata_01 — JSON Attachable metadata (application/json)
//   file_content_01  — the raw file bytes
// We must NOT set Content-Type ourselves — fetch derives the multipart
// boundary from the FormData body. The FormData is rebuilt on each attempt
// (incl. the 401-refresh retry) so the stream is always fresh.
async function rawUploadRequest({ metadata, fileBuffer, fileName, contentType, retryOn401 = true }) {
  const accessToken = await getAccessToken()
  const url = buildUrl('/upload')

  const form = new FormData()
  form.append(
    'file_metadata_01',
    new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
  )
  form.append(
    'file_content_01',
    new Blob([fileBuffer], { type: contentType }),
    fileName,
  )

  console.log(`\n[QBO →] POST /upload  (multipart, file=${fileName})`)
  const startedAt = Date.now()
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      // Content-Type intentionally omitted — fetch sets the boundary.
    },
    body: form,
  })
  const elapsedMs = Date.now() - startedAt
  const text = await res.text()
  console.log(`[QBO ←] POST /upload  status=${res.status}  ${elapsedMs}ms`)

  if (res.status === 401 && retryOn401) {
    console.log('[QBO]   401 received — force-refreshing token and retrying once')
    log.warn('token.invalid_retry', { path: '/upload' })
    const doc = await readTokenDoc()
    if (doc) await refreshAccessToken(doc.refreshToken)
    return rawUploadRequest({ metadata, fileBuffer, fileName, contentType, retryOn401: false })
  }

  let json
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }

  if (!res.ok) {
    console.log(`        response: ${truncate(text, 1000)}`)
    const ErrorClass = res.status >= 500 || res.status === 429 ? TransientError : PermanentError
    throw new ErrorClass(`QBO POST /upload failed: ${res.status}`, { status: res.status, body: json ?? text })
  }
  // /upload returns { AttachableResponse: [{ Attachable: {...} } | { Fault }] }.
  const entry = json?.AttachableResponse?.[0]
  if (entry?.Fault) {
    const detail = entry.Fault?.Error?.[0]?.Message || 'QBO upload Fault'
    throw new PermanentError(`QBO /upload returned a Fault: ${detail}`, { body: entry.Fault })
  }
  return entry?.Attachable || null
}

export async function qboUpload({ metadata, fileBuffer, fileName, contentType }) {
  return retry(() => rawUploadRequest({ metadata, fileBuffer, fileName, contentType }), {
    attempts: paymentConfig.httpRetryAttempts,
    baseMs: paymentConfig.httpRetryBaseMs,
    maxMs: paymentConfig.httpRetryMaxMs,
    onAttempt: ({ attempt, err, nextDelayMs }) => {
      log.warn('upload.retry', { attempt, nextDelayMs, err })
    },
  })
}

// Convenience helpers used by qbo.service.js.
export const qbo = {
  get: (path, query) => qboRequest({ method: 'GET', path, query }),
  post: (path, body, query) => qboRequest({ method: 'POST', path, body, query }),
  // QBO uses POST for updates with a sparse=true flag.
  update: (path, body) => qboRequest({ method: 'POST', path, body }),
  // QBO's email-send endpoints (/invoice/<id>/send, /payment/<id>/send)
  // require an empty POST body with Content-Type: application/octet-stream.
  // Routed through this helper so the special content type is the only
  // difference from a normal post().
  send: (path, query) =>
    qboRequest({
      method: 'POST',
      path,
      query,
      contentType: 'application/octet-stream',
    }),
  query: async (statement) => {
    // /query?query=<sql-like>
    return qboRequest({ method: 'GET', path: '/query', query: { query: statement } })
  },
}
