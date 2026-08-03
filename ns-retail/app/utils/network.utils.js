// Pure, isomorphic helpers for making Node's opaque network failures readable.
//
// Node's `fetch` (undici) collapses EVERY transport-level failure into the
// message "fetch failed" and hides the real reason on `err.cause`. Worse,
// when happy-eyeballs is in play (multiple resolved addresses — typically an
// IPv4 and an IPv6 one) the cause is an `AggregateError` whose own message is
// EMPTY: the per-address failures live on its `.errors[]` array, which
// nothing prints by default. That is why a broken egress path logs as:
//
//   TypeError: fetch failed
//   Caused by:
//     AggregateError:
//
// ...telling you nothing about whether it was DNS, a refused connection, a
// TLS failure, a timeout, or an unroutable address family.
//
// `describeFetchError` walks both the cause chain AND the AggregateError
// sub-errors so the log names the code and the address that actually failed:
//
//   fetch failed (ETIMEDOUT 2600:1f18::1:443 | ETIMEDOUT 54.209.1.2:443)
//
// An address family visible in that output is the fastest way to spot the
// classic "DNS returns AAAA but the host has no IPv6 route" case.

const MAX_CAUSE_DEPTH = 4
const MAX_SUB_ERRORS = 6

function describeOne(err) {
  if (!err) return ''
  const addr = err.address ? `${err.address}${err.port ? `:${err.port}` : ''}` : ''
  // Prefer code + address (actionable); fall back to the message.
  return [err.code, addr || null, !err.code ? err.message : null].filter(Boolean).join(' ')
}

/**
 * Render a network error into a single line that names the real cause.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function describeFetchError(err) {
  const head = err?.message || String(err)
  const parts = []

  let node = err?.cause
  for (let depth = 0; node && depth < MAX_CAUSE_DEPTH; depth += 1) {
    // AggregateError (happy-eyeballs): the useful detail is in .errors[].
    if (Array.isArray(node.errors) && node.errors.length) {
      const subs = node.errors.slice(0, MAX_SUB_ERRORS).map(describeOne).filter(Boolean)
      if (subs.length) parts.push(subs.join(' | '))
      if (node.errors.length > MAX_SUB_ERRORS) {
        parts.push(`+${node.errors.length - MAX_SUB_ERRORS} more`)
      }
    } else {
      const one = describeOne(node)
      if (one) parts.push(one)
    }
    node = node.cause
  }

  // AbortSignal.timeout surfaces as a TimeoutError with no cause chain at all.
  if (!parts.length && err?.name === 'TimeoutError') parts.push('request timed out')

  return parts.length ? `${head} (${parts.join(' <- ')})` : head
}
