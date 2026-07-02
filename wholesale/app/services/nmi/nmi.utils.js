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


// ── Pure helpers used by both server and client ──────────────────────
//
// These deliberately live in nmi.utils.js (NOT nmi.service.js) so
// client-side route renders can import them without dragging in the
// nmi.config / nmi.apis transitive chain. nmi.config.js calls
// `readEnv()` at module init, which references `process.env` —
// referencing that in the browser bundle is a hydration-breaking
// `ReferenceError: process is not defined`.
//
// React Router 7's Vite plugin already strips loader/action-only
// imports from the client bundle, so `listNmiTransactions` and friends
// (which live in nmi.service.js) never reach the browser. But the
// moment a render function imports ANY symbol from nmi.service.js —
// even a pure one like `fromNmiDate` — the entire module + its side-
// effectful imports come along. The split here keeps the render-time
// helpers in a module with no config dependency.

// NMI uses a contiguous YYYYMMDDhhmmss timestamp on both the date filters
// and the action <date> field.
const NMI_DATE_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/

export function toNmiDate(d) {
  if (!d) return null
  const date = d instanceof Date ? d : new Date(d)
  if (!Number.isFinite(date.getTime())) return null
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const h = String(date.getHours()).padStart(2, '0')
  const mi = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${y}${m}${day}${h}${mi}${s}`
}

export function fromNmiDate(str) {
  if (!str || typeof str !== 'string') return null
  const m = NMI_DATE_RE.exec(str.trim())
  if (!m) return null
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  )
  return Number.isFinite(d.getTime()) ? d : null
}

// Last-action helper — most UI views want the latest action's outcome
// (success/failure, response_text, batch_id) on the transaction row
// without exploding it into one row per action. By NMI convention
// actions are ordered chronologically inside the <transaction>, so
// the latest one is what the operator cares about.
export function latestAction(transaction) {
  const actions = transaction?.actions || []
  if (actions.length === 0) return null
  return actions[actions.length - 1]
}

// ── XML extractor — server-side only, but pure ───────────────────────
//
// Kept in utils (not service) because they have no I/O and no config
// dependency. nmi.service.js consumes them via re-import. Stays out of
// client bundles only because no render code imports them.

// Pull the inner text of every immediate `<field>value</field>` pair
// inside `block`. Skips fields with nested children (those have their
// own `<sub>` tags inside and the lazy `.*?` would mis-capture them) —
// callers extract nested blocks separately via `extractBlocks`.
function extractFlatFields(block) {
  const out = {}
  const re = /<([a-zA-Z0-9_]+)>([^<]*)<\/\1>/g
  let match
  while ((match = re.exec(block)) !== null) {
    const key = match[1]
    const value = match[2]
    // Last-write-wins is fine — NMI's flat fields don't repeat. Repeated
    // container tags (like <action>) are handled by extractBlocks.
    out[key] = decodeXmlEntities(value)
  }
  return out
}

function decodeXmlEntities(s) {
  if (!s) return s
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

// Pull every `<tag>…</tag>` block (NOT just leaves) out of the XML.
function extractBlocks(xml, tagName) {
  const blocks = []
  const re = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'g')
  let match
  while ((match = re.exec(xml)) !== null) {
    blocks.push(match[1])
  }
  return blocks
}

// Top-level parser for `report_type=transaction` responses. Returns an
// array of `{ ...flatFields, actions: [...] }`.
export function parseNmiTransactions(xml) {
  if (!xml || typeof xml !== 'string') return []
  // NMI returns <error_response> on bad security key / malformed date
  // range — surface as empty list, callers can render their own banner
  // when they detect that downstream.
  if (/<error_response>/i.test(xml)) return []
  const txBlocks = extractBlocks(xml, 'transaction')
  return txBlocks.map((block) => {
    const actionBlocks = extractBlocks(block, 'action')
    const blockWithoutActions = block.replace(
      /<action>[\s\S]*?<\/action>/g,
      '',
    )
    const flat = extractFlatFields(blockWithoutActions)
    const actions = actionBlocks.map((ab) => extractFlatFields(ab))
    return { ...flat, actions }
  })
}

// Top-level parser for `report_type=customer_vault` responses.
//
// NMI's customer_vault XML wrapper varies by gateway version:
//   A: <customer_vault> root + <customer> entries
//   B: <nm_response> root + <customer_vault> entries
//   C: <customer_vault> root + nested <customer_vault> entries (same tag!)
//
// We previously tried wrapper-detection (probe each pattern, max wins).
// That broke on the actual response shape this codebase's account
// returns — same-name nesting plus subtle whitespace and extra inner
// elements meant pattern probes returned the wrong block count.
//
// SPLIT-BASED EXTRACTION (this version) is wrapper-agnostic:
//
//   1. Split the whole XML on either `</customer_vault>` or `</customer>`.
//      Each resulting chunk contains AT MOST one entry's fields plus
//      surrounding whitespace, regardless of which wrapper NMI used.
//   2. Filter to chunks containing a `<customer_vault_id>` element —
//      that's the entry-unique anchor that every real entry has.
//      Trailing whitespace / wrapper-tail chunks get dropped here.
//
// Same `<billing>` / `<shipping>` stripping as before — those sub-blocks
// duplicate top-level field names and the last-write-wins behavior of
// `extractFlatFields` would otherwise let billing data overwrite the
// customer's own contact info.
export function parseNmiCustomerVaults(xml) {
  if (!xml || typeof xml !== 'string') return []
  if (/<error_response>/i.test(xml)) return []

  // The split regex consumes EITHER close tag. The (?:...) is a
  // non-capturing group so the split returns alternating
  // content / separator items as just content.
  const chunks = xml.split(/<\/(?:customer_vault|customer)>/i)
  const entryChunks = chunks.filter((chunk) =>
    /<customer_vault_id>[^<]+<\/customer_vault_id>/i.test(chunk),
  )

  // Diagnostic — surfaced in the server console for parser-mismatch
  // triage. Compare against the raw response logged by nmiQuery.
  const probeA = extractBlocks(xml, 'customer').length
  const probeB = extractBlocks(xml, 'customer_vault').length
  console.log(
    `[NMI parse] customer_vault — split=${entryChunks.length} entries ` +
      `(legacy probes: <customer>=${probeA}, <customer_vault>=${probeB}, xmlBytes=${xml.length})`,
  )

  return entryChunks.map((chunk) => {
    const stripped = chunk
      .replace(/<billing>[\s\S]*?<\/billing>/g, '')
      .replace(/<shipping>[\s\S]*?<\/shipping>/g, '')
    return extractFlatFields(stripped)
  })
}
