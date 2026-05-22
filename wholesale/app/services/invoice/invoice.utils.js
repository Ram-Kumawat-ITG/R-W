// Invoice-domain pure helpers — line-item shaping + a small retry
// wrapper used by the downstream sync legs. No I/O here.

import { retry } from '../../utils/retry.utils'

// Format a date as "YYYY-MM-DD" using local components — avoids the
// UTC midnight drift that turns a 23:59 timestamp into the next day's
// date when toISOString() is sliced. Returns null on unparseable input.
export function toYmd(date) {
  if (date == null) return null
  const d = date instanceof Date ? new Date(date) : new Date(date)
  if (!Number.isFinite(d.getTime())) return null
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

// Compute an invoice due date as "YYYY-MM-DD" — order date + N days.
// Returns null if `baseDate` is unparseable; callers omit DueDate from
// the QBO payload in that case so QBO falls back to its own SalesTerm
// calculation.
export function computeInvoiceDueDate(baseDate, termsDays) {
  if (baseDate == null) return null
  const d = baseDate instanceof Date ? new Date(baseDate) : new Date(baseDate)
  if (!Number.isFinite(d.getTime())) return null
  const n = Number.isFinite(termsDays) ? Math.trunc(termsDays) : 0
  d.setDate(d.getDate() + n)
  return toYmd(d)
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
//
// NOTE: the processing-fee line is NOT added here — it's appended to
// the QBO invoice at settlement time, with the rate selected by the
// actual settlement method (card / ach / check). See
// services/invoice/invoice.service.propagateSuccessfulPayment.
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

// Friendly label for the processing-fee line based on settlement method.
// Used in both the QBO line Description and the admin-facing preview
// response so the wording stays in sync.
export function processingFeeLabel(method) {
  switch (method) {
    case 'card':
      return 'Credit Card Processing Fee'
    case 'ach':
      return 'ACH Processing Fee'
    case 'check':
      return 'Cheque Processing Fee'
    default:
      return 'Processing Fee'
  }
}

// Compute the processing-fee surcharge for a given settlement method
// and base amount (products + shipping + tax). Returns null when the
// fee rounds to zero or the method has no configured rate — callers
// then skip the fee line entirely. `rates` is the invoiceConfig.
// processingFeeRates map, injected so this helper stays pure.
export function computeProcessingFee({ baseAmount, method, rates }) {
  if (!Number.isFinite(baseAmount) || baseAmount <= 0) return null
  const rate = Number(rates?.[method] ?? 0)
  if (!Number.isFinite(rate) || rate <= 0) return null
  const amount = Number((baseAmount * rate).toFixed(2))
  if (amount <= 0) return null
  return { amount, rate, method, label: processingFeeLabel(method) }
}

// Build a processing-fee invoice line. Used to append the line to a QBO
// invoice at settlement. The description encodes the method label + the
// rate as a percentage so it's self-documenting in QBO ("Credit Card
// Processing Fee – 3%").
export function buildProcessingFeeLine({ amount, rate, method }) {
  if (!Number.isFinite(amount) || amount <= 0) return null
  if (!Number.isFinite(rate) || rate <= 0) return null
  const rounded = Number(amount.toFixed(2))
  if (rounded <= 0) return null
  const pct = +(rate * 100).toFixed(4)
  return {
    description: `${processingFeeLabel(method)} – ${pct}%`,
    quantity: 1,
    unitPrice: rounded,
    amount: rounded,
  }
}

// Defensive idempotency check: detects whether a QBO invoice's Line
// array already has a processing-fee line (matches any method —
// "Credit Card Processing Fee", "ACH Processing Fee", etc.). Used
// before appending so a crash between the QBO write and the local
// flag flip doesn't double-add.
export function findExistingProcessingFeeLine(qboLines) {
  if (!Array.isArray(qboLines)) return null
  return (
    qboLines.find((l) => {
      const desc = String(l?.Description || '')
      return /Processing Fee/i.test(desc)
    }) || null
  )
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
