// Display-side formatters used across admin routes. Pure functions; no
// React, no Polaris — so they can be imported by both loaders (server
// side) and components (client side) without pulling UI dependencies.
//
// Anything that returns *JSX* belongs in `app/components/`, not here.

// Format a number as a currency string for display. Falls back to a
// plain "<CURRENCY> <amount>" rendering if the runtime's Intl data
// doesn't recognize the code (e.g. some sandbox / test currency).
//
// Returns null for null/undefined input so callers can render a
// placeholder like "—" themselves instead of getting "$NaN".
export function formatAmount(amount, currency) {
  if (amount == null) return null
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
    }).format(amount)
  } catch {
    return `${currency || ''} ${Number(amount).toFixed(2)}`.trim()
  }
}

// Parse a QBO "YYYY-MM-DD" date-only string into a local Date at
// midnight. Returns null for unparseable input. QBO's DueDate / TxnDate
// fields are stored as date-only strings (no time component) to avoid
// timezone drift — see `Invoice.qboDueDate` in `models/invoice.server.js`.
export function parseDateOnly(s) {
  if (!s || typeof s !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isFinite(d.getTime()) ? d : null
}

// Clone a Date and clamp its time-of-day to 00:00:00.000 in the local
// timezone. Useful for "is this date before today?" comparisons that
// must ignore the time component.
export function startOfDay(d) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

// Render an ISO date/datetime as a locale string. Returns null for
// null/undefined input so callers can supply their own placeholder.
export function fmtDateTime(d) {
  if (!d) return null
  const date = d instanceof Date ? d : new Date(d)
  if (!Number.isFinite(date.getTime())) return null
  return date.toLocaleString()
}

// "YYYY-MM-DD" → human-readable short date ("Jun 20, 2026"). Used in
// list rows where vertical density matters. Returns the original input
// unchanged if it isn't a parseable date-only string.
export function fmtDueDate(qboDueDate) {
  const due = parseDateOnly(qboDueDate)
  if (!due) return qboDueDate || null
  return due.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

// First letter of the first two words of a name, for an <s-avatar>
// fallback. "?" for empty/missing names.
export function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase()
}
