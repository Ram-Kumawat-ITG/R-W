// Invoice-domain pure helpers — line-item shaping + a small retry
// wrapper used by the downstream sync legs. No I/O here.

import { retry } from '../../utils/retry.utils'

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
      description: item.title || item.name || `Item ${item.id}`,
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
