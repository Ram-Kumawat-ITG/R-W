// Invoice-domain pure helpers — line-item shaping + a small retry
// wrapper used by the downstream sync legs. No I/O here.

import { retry } from '../../utils/retry.utils'

// Compute an invoice due date as "YYYY-MM-DD" — order date + N days.
// Returns null if `baseDate` is unparseable; callers omit DueDate from
// the QBO payload in that case so QBO falls back to its own SalesTerm
// calculation.
//
// Uses local-date components (not toISOString()) to avoid the UTC
// midnight drift that turns a 23:59 timestamp into the next day's date
// when sliced.
export function computeInvoiceDueDate(baseDate, termsDays) {
  if (baseDate == null) return null
  const d = baseDate instanceof Date ? new Date(baseDate) : new Date(baseDate)
  if (!Number.isFinite(d.getTime())) return null
  const n = Number.isFinite(termsDays) ? Math.trunc(termsDays) : 0
  d.setDate(d.getDate() + n)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

// Each downstream sync gets its own retry. Failures are isolated so one
// dead system doesn't block the others. PermanentError bypasses retry.
export async function syncWithRetry(label, fn) {
  return retry(fn, {
    attempts: 3,
    baseMs: 500,
    onAttempt: ({ attempt, err, nextDelayMs }) => {
      console.warn(`[sync] ${label} attempt ${attempt} failed (next in ${nextDelayMs}ms): ${err.message}`)
    },
  })
}

// Convert Shopify line_items to QBO invoice lines.
//
// Shape: { description, quantity, unitPrice, amount, qboItemId? }
// Lines with non-positive amount are dropped. Shipping + tax become their
// own synthetic lines so the invoice total matches Shopify's. If nothing
// makes it through, we fall back to a single line at total_price so we
// still produce a balanced invoice.
export function shopifyLinesToQboLines(order) {
  const lines = []
  for (const item of order.line_items || []) {
    const qty = Number(item.quantity ?? 1)
    const unitPrice = Number(item.price ?? 0)
    const amount = Number((qty * unitPrice).toFixed(2))
    if (!Number.isFinite(amount) || amount <= 0) continue
    lines.push({
      description: formatLineDescription(item),
      quantity: qty,
      unitPrice,
      amount,
    })
  }
  const shippingTotal = Number(order.total_shipping_price_set?.shop_money?.amount || 0)
  if (shippingTotal > 0) {
    lines.push({
      description: 'Shipping',
      quantity: 1,
      unitPrice: shippingTotal,
      amount: shippingTotal,
    })
  }
  const taxTotal = Number(order.total_tax || 0)
  if (taxTotal > 0) {
    lines.push({
      description: 'Tax',
      quantity: 1,
      unitPrice: taxTotal,
      amount: taxTotal,
    })
  }
  if (lines.length === 0) {
    lines.push({
      description: `Order ${order.name || order.id}`,
      quantity: 1,
      unitPrice: Number(order.total_price ?? 0),
      amount: Number(order.total_price ?? 0),
    })
  }
  return lines
}

// Compose the QBO invoice line description from a Shopify line_item.
// Format: "<product name> by <vendor>, SKU: <sku>" — vendor and SKU are
// each conditional so missing fields don't leave dangling separators.
// We use `name` (which Shopify pre-joins as "Title - Variant Title")
// over `title` so any variant detail survives the trip into QBO.
//
// SKU is normalized: some merchants enter the value in Shopify as
// "SKU: 1234" (with the prefix baked in). Without stripping, the output
// becomes "SKU: SKU: 1234". Strip any leading "SKU:" (case-insensitive)
// before re-prefixing so the result is always exactly one "SKU: ".
export function formatLineDescription(item) {
  if (!item) return ''
  const productName = item.name || item.title || `Item ${item.id ?? ''}`.trim()
  const head = item.vendor ? `${productName} by ${item.vendor}` : productName
  const parts = [head]
  const sku = String(item.sku || '').replace(/^\s*sku\s*:\s*/i, '').trim()
  if (sku) parts.push(`SKU: ${sku}`)
  return parts.join(', ')
}
