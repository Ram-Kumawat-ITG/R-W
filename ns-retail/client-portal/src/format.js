// Display formatters. Ported verbatim from wholesale/practitioner-portal/
// src/format.js — no platform-specific code (Intl is available everywhere).

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
  return String(s)
    .split(/[_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}
