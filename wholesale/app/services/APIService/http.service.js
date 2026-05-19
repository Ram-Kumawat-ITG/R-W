// Generic HTTP client used by per-integration api files (qbo.apis.js,
// nmi.apis.js, etc). Wraps native fetch with:
//   - retry + exponential backoff via retry.utils
//   - undici TypeError unwrapping (so logs show ENOTFOUND / ECONNREFUSED
//     instead of the opaque "fetch failed")
//   - response-status → PermanentError / TransientError classification
//
// Per-integration clients are still responsible for URL construction,
// auth header injection, and body encoding (form vs JSON). This file
// only handles the network round-trip + classification.

import { retry, PermanentError, TransientError } from '../../utils/retry.utils'

// Status codes that mean "retry me" rather than "give up". 408 + 429
// + 5xx are transient. 4xx (other than 408/429) is permanent.
function isTransientStatus(status) {
  return status === 408 || status === 429 || status >= 500
}

// Unwrap Node's undici TypeError wrapper to expose the real cause code.
function describeFetchFailure(err) {
  const cause = err?.cause
  const code = cause?.code || err?.code
  const msg = err?.message || String(err)
  return code ? `${code}: ${msg}` : msg
}

// Body parsing — try JSON first, fall back to text so callers can switch
// on the shape themselves. NMI returns key=value strings, QBO returns JSON.
function tryParse(text, contentType = '') {
  if (!text) return null
  if (contentType.includes('json')) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  // Heuristic: try JSON anyway if it looks like JSON
  const trimmed = text.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

// Single HTTP round-trip with retry. Returns the parsed response on 2xx.
// Throws PermanentError on non-retryable failures, TransientError if all
// retries exhausted.
//
// Usage:
//   const { body, status, headers } = await httpRequest({
//     url: 'https://api.example.com/widgets',
//     method: 'POST',
//     headers: { Authorization: `Bearer ${token}` },
//     body: JSON.stringify({ name: 'foo' }),
//     retryOpts: { attempts: 4 },
//   })
export async function httpRequest({
  url,
  method = 'GET',
  headers = {},
  body,
  retryOpts,
  // Optional hook so callers can classify protocol-specific errors as
  // permanent (e.g. NMI response=3, QBO Fault.type='AuthenticationFault').
  classifyResponse,
}) {
  return retry(async (attempt) => {
    let res
    try {
      res = await fetch(url, { method, headers, body })
    } catch (err) {
      throw new TransientError(`fetch failed: ${describeFetchFailure(err)}`, {
        cause: err?.cause || err,
      })
    }

    const contentType = res.headers.get('content-type') || ''
    const raw = await res.text()
    const parsed = tryParse(raw, contentType)

    if (res.ok) {
      // Give callers a chance to reject 200s with bad-payload semantics
      // (NMI is the canonical case — response=3 inside a 200 body).
      const verdict = classifyResponse?.({ status: res.status, body: parsed, raw, attempt })
      if (verdict?.permanent) {
        throw new PermanentError(verdict.message || 'Response classified permanent', {
          status: res.status,
          body: parsed,
        })
      }
      if (verdict?.transient) {
        throw new TransientError(verdict.message || 'Response classified transient', {
          status: res.status,
          body: parsed,
        })
      }
      return { status: res.status, body: parsed, raw, headers: res.headers }
    }

    if (isTransientStatus(res.status)) {
      throw new TransientError(`HTTP ${res.status}`, { status: res.status, body: parsed })
    }
    throw new PermanentError(`HTTP ${res.status}`, { status: res.status, body: parsed })
  }, retryOpts)
}
