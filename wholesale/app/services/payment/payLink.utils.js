// Immediate-Payment pay-link helpers — token minting, public URL building,
// and the QBO-memo pay-link block. Server-only (buildPayLinkUrl reads
// shopifyConfig). Keep out of client render code; the pay routes use these
// from loaders/actions only.

import crypto from 'node:crypto'
import { shopifyConfig } from '../shopify/shopify.config'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

// Encode a byte buffer as base62 (URL-safe, fully alphanumeric — NO `-`/`_`).
function bytesToBase62(buf) {
  let n = 0n
  for (const b of buf) n = (n << 8n) | BigInt(b)
  if (n === 0n) return '0'
  let out = ''
  while (n > 0n) {
    out = BASE62[Number(n % 62n)] + out
    n /= 62n
  }
  return out
}

// Opaque, unguessable bearer token stored on the Invoice (Invoice.payToken)
// and embedded in the public /pay/<token> URL.
//
// IMPORTANT: this is **base62 (alphanumeric only)**, not base64url. The link
// is written as plain text into the QBO invoice CustomerMemo and relies on
// the PDF/email client auto-linkifying it. base64url's `-` and `_` (and any
// punctuation) are exactly the characters those linkifiers — and line-wrap —
// drop, producing the "hyphens/characters missing → invalid link" bug. A
// purely alphanumeric token can't be truncated that way. 16 random bytes =
// 128-bit entropy (≈22 chars) — unguessable for a per-invoice pay link, and
// short enough to minimise wrapping. The amount is always recomputed
// server-side, so the token is the only secret and carries nothing else.
export function mintPayToken() {
  return bytesToBase62(crypto.randomBytes(16))
}

// Build the durable public pay URL for a token. Uses the configured stable
// base URL (PAY_LINK_BASE_URL, falling back to SHOPIFY_APP_URL — see
// shopify.config). Trailing slash on the base is tolerated. The token is
// alphanumeric so encodeURIComponent is a no-op, but we keep it defensively.
//
// Throws if the base is missing or not an absolute http(s) URL: without a
// host we'd emit a relative "/pay/<token>" — a structurally INCOMPLETE link
// that renders as a dead/invalid URL in the emailed invoice. Failing loudly
// here (rather than baking a broken link into a QBO memo for days) is the
// guarantee that every issued link is a complete, absolute URL. Callers that
// build a link for display (vs. for baking) should guard with try/catch.
export function buildPayLinkUrl(token, baseUrl = shopifyConfig.payLinkBaseUrl) {
  if (!token) throw new Error('buildPayLinkUrl: token is required')
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^/\s]+/i.test(base)) {
    throw new Error(
      `buildPayLinkUrl: pay-link base URL is not a complete absolute URL (got "${base || '(empty)'}"). ` +
        'Set PAY_LINK_BASE_URL (or SHOPIFY_APP_URL) to a stable https:// host so the full /pay link can be built.',
    )
  }
  return `${base}/pay/${encodeURIComponent(token)}`
}

// ── QBO CustomerMemo pay-link block ──────────────────────────────────
//
// The pay link is appended to the invoice memo as its own block. The URL
// sits ALONE on the final line (full width, nothing after it) so the
// auto-linkifier captures the whole URL and a line-wrap can't split it from
// trailing text. Shared by createInvoiceForOrder (at creation) and
// qbo.service.setInvoicePayLinkMemo (refresh) so the two never drift.

export const PAY_LINK_LABEL = 'Pay your invoice online:'

// QBO CustomerMemo max length. We must never exceed it, and — critically —
// when trimming we trim the BASE memo, never the appended pay-link block, so
// the URL is always written in full (see appendPayLinkToMemo).
export const QBO_MEMO_MAX_LEN = 1000

// Strips the managed pay-link block (matches the current label AND the legacy
// "Pay online:" label) from an existing memo so a refresh replaces, never
// duplicates. The block is always last, so we cut from the label to the end.
export const PAY_LINK_MEMO_REGEX = /\n+Pay (?:online:|your invoice online:)[\s\S]*$/i

// The block appended after the base memo: a blank line, the label, then the
// URL alone on its own line.
export function buildPayLinkMemoSuffix(url) {
  return `\n\n${PAY_LINK_LABEL}\n${url}`
}

// Append the pay-link block to a base memo, guaranteeing the FULL URL survives
// the QBO length cap. The previous code built `base + suffix` then sliced the
// whole string to 1000 chars — which truncated from the END, i.e. it chopped
// the pay URL itself (producing the reported "URL cut off / link invalid"
// bug whenever the base memo was long). Here we instead trim only the base so
// the entire pay-link block (label + complete URL) is always preserved intact.
// Shared by createInvoiceForOrder (creation) and setInvoicePayLinkMemo
// (refresh) so the two paths can never drift.
export function appendPayLinkToMemo(baseMemo, url) {
  const suffix = buildPayLinkMemoSuffix(url)
  let base = String(baseMemo || '').trimEnd()
  const budget = QBO_MEMO_MAX_LEN - suffix.length
  if (base.length > budget) base = base.slice(0, Math.max(0, budget)).trimEnd()
  return `${base}${suffix}`
}
