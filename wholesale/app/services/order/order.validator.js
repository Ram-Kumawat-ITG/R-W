// Pre-flight validation for an incoming Shopify order payload. Run
// before we hit QBO or NMI so we fail fast with a clear reason instead
// of producing a half-built customer + half-built invoice on bad input.
//
// Returns { ok: true } on success, or { ok: false, reason, code } so
// the caller can persist the rejection and log it consistently.

const TERMINAL_STATUSES = new Set(['voided', 'refunded'])

export function validateShopifyOrder(order) {
  if (!order || typeof order !== 'object') {
    return reject('PAYLOAD_INVALID', 'Order payload is missing or not an object')
  }
  if (!order.id) {
    return reject('NO_ORDER_ID', 'Order has no id')
  }

  // Order lifecycle — we never invoice for cancelled / voided / refunded.
  if (order.cancelled_at) {
    return reject('CANCELLED', `Order ${order.id} was cancelled at ${order.cancelled_at}`)
  }
  if (TERMINAL_STATUSES.has(order.financial_status)) {
    return reject('FINANCIAL_TERMINAL', `Order financial_status is '${order.financial_status}'`)
  }

  // Customer identity — invoices in QBO require a customer with at
  // least an email. Anonymous checkout orders are explicitly rejected.
  const email = (order.email || order.customer?.email || '').trim()
  if (!email) {
    return reject('NO_EMAIL', `Order ${order.id} has no email on order or customer`)
  }

  // Billing — we need at least one address for QBO BillAddr. We accept
  // shipping_address as a fallback because some store flows omit billing.
  const billing = order.billing_address || order.shipping_address
  if (!billing) {
    return reject('NO_BILLING', `Order ${order.id} has no billing or shipping address`)
  }
  const billingNameMissing = !billing.first_name && !billing.last_name && !billing.company
  if (billingNameMissing && !order.customer?.first_name && !order.customer?.last_name) {
    return reject('NO_NAME', `Order ${order.id} has no name on customer or billing address`)
  }

  // Amount sanity. Zero-total orders (100% discount, store credit) are
  // valid but skipped — there's nothing to invoice or charge.
  const total = Number(order.total_price ?? 0)
  if (!Number.isFinite(total)) {
    return reject('AMOUNT_INVALID', `Order total_price is not numeric: ${order.total_price}`)
  }
  if (total <= 0) {
    return reject('ZERO_TOTAL', `Order ${order.id} total is ${total}; skipping QBO/NMI`)
  }

  // Line items — must have at least one to produce a QBO invoice.
  if (!Array.isArray(order.line_items) || order.line_items.length === 0) {
    return reject('NO_LINE_ITEMS', `Order ${order.id} has no line_items`)
  }

  return { ok: true }
}

function reject(code, reason) {
  return { ok: false, code, reason }
}
