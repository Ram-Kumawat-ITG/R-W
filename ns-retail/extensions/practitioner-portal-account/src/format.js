// Display formatters (Intl is available in the extension runtime).

export function formatMoney(amount, currency = 'USD') {
  const n = Number(amount)
  if (!Number.isFinite(n)) return '—'
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(n)
  } catch {
    return `$${n.toFixed(2)}`
  }
}

export function formatPercent(fraction) {
  const n = Number(fraction)
  if (!Number.isFinite(n)) return '—'
  const pct = n * 100
  return `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1)}%`
}

export function formatDate(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

export function formatNumber(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '0'
  return new Intl.NumberFormat('en-US').format(v)
}

export function titleCase(s) {
  if (!s) return '—'
  return String(s).charAt(0).toUpperCase() + String(s).slice(1)
}

// Extract a concise, human-readable message from a stored payout-failure
// reason. Pipeline reasons are often a prefix + a raw provider JSON blob, e.g.
//   Dwolla createTransfer failed (400): {"code":"ValidationError","message":
//   "Validation error(s) present…","_embedded":{"errors":[{"message":
//   "Insufficient funds."}]}}
// Show only the most specific message (embedded error → top-level message →
// the prefix before the JSON), never the full JSON dump.
export function payoutReasonMessage(reason) {
  if (!reason) return ''
  const str = String(reason).trim()
  const braceIdx = str.indexOf('{')
  if (braceIdx === -1) return str
  const prefix = str.slice(0, braceIdx).replace(/[:\s]+$/, '').trim()
  try {
    const obj = JSON.parse(str.slice(braceIdx))
    const embedded = obj?._embedded?.errors?.[0]?.message
    return embedded || obj?.message || prefix || str
  } catch {
    // JSON unparseable (e.g. truncated) — fall back to the human prefix.
    return prefix || str
  }
}
