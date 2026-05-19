import { config, assertNmiConfigured } from '../config.server'
import { createLogger } from '../logger.server'
import { retry, PermanentError, TransientError } from '../retry.server'

const log = createLogger('nmi.client')

function encodeForm(params) {
  const out = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    out.append(k, String(v))
  }
  return out
}

function parseResponseBody(text) {
  // NMI Direct Post returns key=value pairs joined by '&'. URLSearchParams
  // happily parses that even though it's nominally a query string.
  const parsed = Object.fromEntries(new URLSearchParams(text).entries())
  // `response` is the headline result: 1=approved, 2=declined, 3=error.
  return parsed
}

// Common interface for all NMI transact.php calls. Keeps key injection and
// response parsing in one place.
export async function nmiTransact(params, { sensitiveKeys = [] } = {}) {
  assertNmiConfigured()

  const body = encodeForm({ security_key: config.nmi.securityKey, ...params })

  const safeParams = { ...params }
  for (const k of sensitiveKeys) {
    if (safeParams[k]) safeParams[k] = '***redacted***'
  }

  // NMI APIs are split: transactions use `type` (sale, auth, refund, …)
  // and Customer Vault operations use `customer_vault` (add_customer, …).
  // Log whichever is set so you can tell at a glance what was called.
  const op = params.type || params.customer_vault || '(unknown)'
  console.log(`\n[NMI →] ${config.nmi.apiUrl}`)
  console.log(`        op: ${op}`)
  console.log(`        params: ${JSON.stringify(safeParams)}`)
  log.debug('request', { op, customer_vault_id: params.customer_vault_id })

  const exec = async () => {
    const startedAt = Date.now()
    let res
    try {
      res = await fetch(config.nmi.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
    } catch (err) {
      // undici wraps DNS/TLS/connection errors as `TypeError: fetch failed`
      // with the real reason on `.cause`. Surface it so logs actually
      // explain what went wrong.
      const cause = err?.cause
      const reason = cause?.code || cause?.message || err.message
      console.error(`[NMI ✗] fetch to ${config.nmi.apiUrl} failed: ${reason}`)
      if (cause) console.error(`        cause: ${cause.stack || cause.message || cause}`)
      throw new TransientError(`NMI fetch failed: ${reason}`, { cause: err })
    }
    const text = await res.text()
    const elapsedMs = Date.now() - startedAt
    console.log(`[NMI ←] status=${res.status}  ${elapsedMs}ms`)
    console.log(`        body: ${text}`)

    if (res.status >= 500) {
      throw new TransientError(`NMI HTTP ${res.status}`, { status: res.status, body: text })
    }
    if (!res.ok) {
      throw new PermanentError(`NMI HTTP ${res.status}`, { status: res.status, body: text })
    }
    return parseResponseBody(text)
  }

  return retry(exec, {
    attempts: config.payments.httpRetryAttempts,
    baseMs: config.payments.httpRetryBaseMs,
    maxMs: config.payments.httpRetryMaxMs,
    onAttempt: ({ attempt, err, nextDelayMs }) => {
      log.warn('request.retry', { attempt, nextDelayMs, err })
    },
  })
}

export async function nmiQuery(params) {
  assertNmiConfigured()
  const body = encodeForm({ security_key: config.nmi.securityKey, ...params })
  let res
  try {
    res = await fetch(config.nmi.queryUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
  } catch (err) {
    const cause = err?.cause
    const reason = cause?.code || cause?.message || err.message
    console.error(`[NMI ✗] query fetch to ${config.nmi.queryUrl} failed: ${reason}`)
    throw new TransientError(`NMI query fetch failed: ${reason}`, { cause: err })
  }
  const text = await res.text()
  if (!res.ok) {
    const ErrorClass = res.status >= 500 ? TransientError : PermanentError
    throw new ErrorClass(`NMI query HTTP ${res.status}`, { status: res.status, body: text })
  }
  return text
}
