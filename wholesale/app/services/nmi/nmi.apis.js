// NMI HTTP client — form-encoded POST to transact.php and query.php,
// with retry, timeout classification, and undici-error unwrapping.
//
// Higher-level vault/charge methods are in nmi.service.js. This file is
// pure transport.

import { nmiConfig, assertNmiConfigured } from './nmi.config'
import { paymentConfig } from '../payment/payment.config'
import { encodeForm, parseResponseBody } from './nmi.utils'
import { createLogger } from '../../utils/logger.utils'
import { retry, PermanentError, TransientError } from '../../utils/retry.utils'

const log = createLogger('nmi.apis')

// Common interface for all NMI transact.php calls. Keeps key injection and
// response parsing in one place.
//
// `sensitiveKeys` — parameter names to redact in logs (card numbers, CVV).
export async function nmiTransact(params, { sensitiveKeys = [] } = {}) {
  assertNmiConfigured()

  const body = encodeForm({ security_key: nmiConfig.securityKey, ...params })

  const safeParams = { ...params }
  for (const k of sensitiveKeys) {
    if (safeParams[k]) safeParams[k] = '***redacted***'
  }

  // NMI APIs are split: transactions use `type` (sale, auth, refund, …)
  // and Customer Vault operations use `customer_vault` (add_customer, …).
  // Log whichever is set so you can tell at a glance what was called.
  const op = params.type || params.customer_vault || '(unknown)'
  console.log(`\n[NMI →] ${nmiConfig.apiUrl}`)
  console.log(`        op: ${op}`)
  console.log(`        params: ${JSON.stringify(safeParams)}`)
  log.debug('request', { op, customer_vault_id: params.customer_vault_id })

  const exec = async () => {
    const startedAt = Date.now()
    let res
    try {
      res = await fetch(nmiConfig.apiUrl, {
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
      console.error(`[NMI ✗] fetch to ${nmiConfig.apiUrl} failed: ${reason}`)
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
    attempts: paymentConfig.httpRetryAttempts,
    baseMs: paymentConfig.httpRetryBaseMs,
    maxMs: paymentConfig.httpRetryMaxMs,
    onAttempt: ({ attempt, err, nextDelayMs }) => {
      log.warn('request.retry', { attempt, nextDelayMs, err })
    },
  })
}

// query.php returns XML, not the key=value form transact.php uses.
// Server-side helpers in nmi.utils.js extract fields via regex block
// matching — that approach works for the shallow report shapes NMI
// emits but is sensitive to wrapper-element variations across gateway
// versions. The truncated response log below is the diagnostic for
// "list shows empty" bugs — compare what the parser expects against
// what NMI actually returned.
export async function nmiQuery(params) {
  assertNmiConfigured()
  const body = encodeForm({ security_key: nmiConfig.securityKey, ...params })
  // Safe to log — the only sensitive value (security_key) was added by
  // us and is already known. Echoing params helps correlate request →
  // response in logs without leaking PAN/CVV (transact.php sensitive
  // values aren't relevant on this code path).
  const op = params.report_type || '(unknown)'
  console.log(`\n[NMI query →] ${nmiConfig.queryUrl}`)
  console.log(`            report: ${op}`)
  console.log(`            params: ${JSON.stringify({ ...params, security_key: '***redacted***' })}`)
  let res
  try {
    res = await fetch(nmiConfig.queryUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
  } catch (err) {
    const cause = err?.cause
    const reason = cause?.code || cause?.message || err.message
    console.error(`[NMI ✗] query fetch to ${nmiConfig.queryUrl} failed: ${reason}`)
    throw new TransientError(`NMI query fetch failed: ${reason}`, { cause: err })
  }
  const text = await res.text()
  // Always log the status + a truncated preview so we can verify the
  // parser is working against the wrapper shape NMI actually returned.
  // 1.5KB is enough to see the wrapper element + a few fields without
  // flooding the console on multi-thousand-row responses.
  console.log(`[NMI query ←] status=${res.status}  bytes=${text.length}`)
  console.log(`            body: ${text.length > 1500 ? `${text.slice(0, 1500)}… (+${text.length - 1500} chars)` : text}`)
  if (!res.ok) {
    const ErrorClass = res.status >= 500 ? TransientError : PermanentError
    throw new ErrorClass(`NMI query HTTP ${res.status}`, { status: res.status, body: text })
  }
  return text
}
