// NMI-specific pure helpers — form encoding, response parsing, outcome
// classification. No I/O here; that's nmi.apis.js.

import { RESPONSE_OUTCOME } from './nmi.constants'

// NMI accepts application/x-www-form-urlencoded. Drop undefined/null/empty
// so optional fields don't poison the request.
export function encodeForm(params) {
  const out = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    out.append(k, String(v))
  }
  return out
}

// NMI Direct Post returns key=value pairs joined by '&'. URLSearchParams
// happily parses that even though it's nominally a query string.
export function parseResponseBody(text) {
  return Object.fromEntries(new URLSearchParams(text).entries())
}

// Normalize a raw NMI response into our app's payment outcome shape.
// `response` is the headline result: 1=approved, 2=declined, 3=error.
export function classifyNmiResponse(res) {
  return {
    outcome: RESPONSE_OUTCOME[res.response] || 'error',
    transactionId: res.transactionid,
    responseCode: res.response_code,
    responseText: res.responsetext,
    authCode: res.authcode,
    avsResponse: res.avsresponse,
    cvvResponse: res.cvvresponse,
    raw: res,
  }
}

// Redact sensitive fields for logging without mutating the original.
export function redactParams(params, sensitiveKeys) {
  const safe = { ...params }
  for (const k of sensitiveKeys) {
    if (safe[k]) safe[k] = '***redacted***'
  }
  return safe
}
