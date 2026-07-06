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

// Compute the full-datetime `dueAt` — order date + termsDays + termsMinutes.
// Distinct from computeInvoiceDueDate which returns a date-only string for
// QBO. Returns null on unparseable input. Used for the local Overdue
// indicator + cheque-reminder gating; the testing knob
// `INVOICE_TERMS_MINUTES` makes invoices flag as overdue within minutes
// of creation without needing whole-day granularity.
export function computeInvoiceDueAt(baseDate, termsDays, termsMinutes) {
  if (baseDate == null) return null
  const d = baseDate instanceof Date ? new Date(baseDate) : new Date(baseDate)
  if (!Number.isFinite(d.getTime())) return null
  const days = Number.isFinite(termsDays) ? Math.trunc(termsDays) : 0
  const mins = Number.isFinite(termsMinutes) ? Math.trunc(termsMinutes) : 0
  d.setDate(d.getDate() + days)
  d.setMinutes(d.getMinutes() + mins)
  return d
}

// Add N business days (Mon–Fri; no holiday calendar) to a date, returning
// a new Date at local midnight of the resulting day. Used for the Check
// due date ("10 business days"). N=0 returns the same calendar day.
export function addBusinessDays(date, n) {
  const d = date instanceof Date ? new Date(date) : new Date(date)
  const days = Number.isFinite(n) ? Math.trunc(n) : 0
  let remaining = Math.abs(days)
  const step = days < 0 ? -1 : 1
  while (remaining > 0) {
    d.setDate(d.getDate() + step)
    const dow = d.getDay() // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) remaining -= 1
  }
  return d
}

// Card billing-cycle due date: orders placed the 1st–15th are due on the
// 15th of that month; orders placed the 16th–end-of-month are due on the
// last day of that month. Returns a new Date at the same time-of-day as
// `date` (callers format with toYmd / add termsMinutes as needed).
export function computeCardBillingDueDate(date) {
  const d = date instanceof Date ? new Date(date) : new Date(date)
  const day = d.getDate()
  const due = new Date(d)
  if (day <= 15) {
    due.setDate(15)
  } else {
    // Day 0 of next month = last day of this month.
    due.setMonth(due.getMonth() + 1, 0)
  }
  return due
}

// Resolve the invoice due date + full-datetime dueAt for a given payment
// method, per the production billing rules:
//   - ach   → due on receipt (same day as the order/invoice date).
//   - card  → billing-cycle date: 1st–15th → due the 15th; 16th–EOM → due
//             the last day of the month.
//   - check → `businessDays` business days (Mon–Fri) after the order date.
//   - anything else (e.g. dropship) → generic `termsDays` calendar days,
//     the pre-existing behavior.
// Returns { dueDate, dueAt } — dueDate is a "YYYY-MM-DD" string (or null
// if baseDate is unparseable), dueAt is a full Date (or null).
export function computeDueDateForMethod(baseDate, method, { businessDays, termsDays, termsMinutes } = {}) {
  if (baseDate == null) return { dueDate: null, dueAt: null }
  const base = baseDate instanceof Date ? new Date(baseDate) : new Date(baseDate)
  if (!Number.isFinite(base.getTime())) return { dueDate: null, dueAt: null }

  let due
  if (method === 'ach') {
    due = new Date(base)
  } else if (method === 'card') {
    due = computeCardBillingDueDate(base)
  } else if (method === 'check') {
    due = addBusinessDays(base, Number.isFinite(businessDays) ? businessDays : 10)
  } else {
    due = new Date(base)
    due.setDate(due.getDate() + (Number.isFinite(termsDays) ? termsDays : 0))
  }

  const dueAt = new Date(due)
  const mins = Number.isFinite(termsMinutes) ? Math.trunc(termsMinutes) : 0
  if (mins) dueAt.setMinutes(dueAt.getMinutes() + mins)

  return { dueDate: toYmd(due), dueAt }
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
// Shape: { description, quantity, unitPrice, amount, qboItemId? }, plus the
// special discount marker { kind: 'discount', description, amount }.
// Lines with non-positive amount are dropped. Discount and shipping become
// their own synthetic lines. If nothing makes it through, we fall back to a
// single line at total_price so we still produce a balanced invoice.
//
// Ordering: product lines → discount → shipping. The discount line is a QBO
// DiscountLineDetail (see toInvoiceLine) that subtracts from the running
// subtotal of the product lines.
//
// TAX is deliberately NOT emitted as a line here. It is passed separately
// to qbo.service.createInvoice as TxnTaxDetail.TotalTax so QBO renders it in
// the invoice summary's "Tax" row rather than in the Products section. (QBO
// has no API field for shipping or processing fees, so those stay as line
// items — only tax has a native summary slot besides discount.)
//
// NOTE: the processing-fee line is NOT added here — it's appended by
// services/invoice/invoice.service.createInvoiceForOrder (for card / ACH,
// at creation) or at settlement time as a fallback. The rate is selected by
// the invoice's payment method (card 3% / ach 1% / check 0%).
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
      // Carried for per-product QBO Item resolution (SKU column). The QBO
      // service resolves `sku` → a QBO Item (carrying that SKU) and sets the
      // line's qboItemId; lines without a sku stay on the default item.
      sku: item.sku ? String(item.sku).trim() : undefined,
      name: item.name || item.title || undefined,
    })
  }
  // Order-level / coupon / referral discount. Shopify reports the aggregate
  // on `total_discounts`; we emit a single QBO discount line so the invoice
  // total reconciles with Shopify's discounted total_price. Per-line
  // discounts are already rolled into this aggregate.
  const discountTotal = Number(order.total_discounts || 0)
  if (discountTotal > 0) {
    lines.push({
      kind: 'discount',
      description: 'Discount',
      amount: discountTotal,
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
  // Tax is intentionally omitted from the line array — see the header
  // comment. It travels to QBO via TxnTaxDetail.TotalTax (qbo.service.
  // createInvoice) so it lands in the invoice's summary "Tax" row.
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
    case 'immediate':
      return 'Payment Processing Fee'
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
// invoice at settlement. The description encodes the method label, the rate
// as a percentage, AND the calculation basis when known, so the line is
// self-documenting on the customer's invoice ("Credit Card Processing Fee –
// 3% of $596.58"). `baseAmount` is the amount the fee was computed on
// (post-discount grand total); when omitted the basis clause is dropped and
// the description falls back to "… – 3%".
export function buildProcessingFeeLine({ amount, rate, method, baseAmount }) {
  if (!Number.isFinite(amount) || amount <= 0) return null
  if (!Number.isFinite(rate) || rate <= 0) return null
  const rounded = Number(amount.toFixed(2))
  if (rounded <= 0) return null
  const pct = +(rate * 100).toFixed(4)
  const basis =
    Number.isFinite(baseAmount) && baseAmount > 0
      ? ` of $${Number(baseAmount).toFixed(2)}`
      : ''
  return {
    description: `${processingFeeLabel(method)} – ${pct}%${basis}`,
    quantity: 1,
    unitPrice: rounded,
    amount: rounded,
  }
}

// Build the ordered invoice-calculation rows for display. Pure — used by
// the admin Order Details totals box so the on-screen breakdown matches the
// QBO invoice's structure exactly:
//
//   Order Subtotal  (gross, pre-discount line-items total)
//   − Discount
//   = Adjusted Subtotal
//   + Shipping
//   + Tax
//   + Payment Processing Fee
//   = Grand Total
//
// `totals` is the Shopify-derived breakdown
// ({ lineItemsTotal, discounts, subtotal, shipping, tax, grandTotal,
// taxesIncluded }). `fee` is { amount, label } | null. `grandTotalOverride`
// (the invoice's fee-inclusive amountDue) wins when provided so the displayed
// total is exactly what will be charged; otherwise we sum the components.
export function computeInvoiceCalculation({ totals, fee, grandTotalOverride }) {
  if (!totals) return null
  const orderSubtotal = Number(totals.lineItemsTotal ?? totals.subtotal ?? 0)
  const discount = Number(totals.discounts ?? 0)
  const adjustedSubtotal = Number((orderSubtotal - discount).toFixed(2))
  const shipping = Number(totals.shipping ?? 0)
  const tax = Number(totals.tax ?? 0)
  const feeAmount = fee ? Number(fee.amount ?? 0) : 0
  const computedGrand = Number(
    (adjustedSubtotal + shipping + tax + feeAmount).toFixed(2),
  )
  const grandTotal = Number.isFinite(grandTotalOverride)
    ? Number(grandTotalOverride.toFixed(2))
    : computedGrand
  return {
    orderSubtotal,
    discount,
    adjustedSubtotal,
    shipping,
    tax,
    taxesIncluded: Boolean(totals.taxesIncluded),
    fee: feeAmount > 0 ? { amount: feeAmount, label: fee?.label || 'Processing Fee' } : null,
    grandTotal,
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

// Derive the canonical paymentStatus from the invoice's money fields.
// Single source of truth — every service that mutates `amountPaid` MUST
// run the result through this rather than setting `paymentStatus`
// ad-hoc. Keeps the partial → paid transitions consistent.
//
// Priority (highest wins):
//   1. `cancelled` — sticky. Only the orders/cancelled webhook (or a
//       future admin cancel action) writes this; we never want a stray
//       payment landing to undo a cancellation.
//   2. payment-based:
//        amountPaid == 0           → 'pending'
//        amountPaid >= amountDue   → 'paid'
//        otherwise                 → 'partially_paid'
//
// `in_progress` is NOT sticky. It is a transient lock written by
// chargeInvoice ONLY for the duration of the NMI sale, and the very
// next thing chargeInvoice does after the call returns is invoke this
// derive — at which point the lock is being released, so we want the
// amount-based status, not the lock state, to win.
//
// `awaiting_settlement` IS sticky. It signals that an ACH transaction
// was accepted at NMI's gateway (response code 100) but the ACH
// network has not yet confirmed the funds — settlement takes 1–3
// business days and the transaction can still bounce. We deliberately
// DO NOT bump amountPaid while in this state; the in-flight credit
// lives on `pendingSettlementAmount`. The ACH settlement-check CRON
// pass (PASS 1.7) is the only path that transitions out: settled →
// applies the amount + lets derivation recompute, failed → clears
// the pending fields + writes `failed`/`pending` directly. Without
// the sticky guard a stray `applyDerivedPaymentStatus` call on an
// invoice with amountPaid=0 would mis-flip awaiting_settlement back
// to pending and the CRON would attempt to charge the customer
// again while NMI is still processing the first transaction.
//
// `failed` is NOT sticky either. If an invoice has exhausted retries
// (failed) and then a manual payment arrives, the money is real and
// the status should reflect that (partially_paid / paid). The CRON
// PASS 1 cursor filters on `paymentStatus: 'pending'` and does NOT
// pick up partially_paid invoices, so flipping out of `failed` won't
// cause double-charges. The `Invoice.attemptCount >= maxAttempts`
// guard still blocks any further auto-retry on the card side.
//
// Use 0.005 tolerance so 2-dp rounded floats (e.g. 100.00 vs 100.01)
// don't accidentally flip "paid" to "partially_paid".
export function deriveInvoicePaymentStatus(invoice) {
  if (!invoice) return 'pending'
  if (invoice.paymentStatus === 'cancelled') return 'cancelled'
  if (invoice.paymentStatus === 'awaiting_settlement') return 'awaiting_settlement'
  const due = Number(invoice.amountDue || 0)
  const paid = Number(invoice.amountPaid || 0)
  const EPS = 0.005

  if (paid <= EPS) return 'pending'
  if (paid + EPS >= due) return 'paid'
  return 'partially_paid'
}

// Apply the derived status to an Invoice document IN-PLACE. Returns the
// status that was set so callers can log it cleanly. Does NOT save —
// callers run save() at the end of their transaction.
export function applyDerivedPaymentStatus(invoice) {
  if (!invoice) return null
  const next = deriveInvoicePaymentStatus(invoice)
  invoice.paymentStatus = next
  return next
}

// Compose the QBO invoice line description from a Shopify line_item.
// Format: "<product name> by <vendor>" — vendor is conditional. We use
// `name` (which Shopify pre-joins as "Title - Variant Title") over `title`
// so any variant detail survives the trip into QBO.
//
// SKU is deliberately NOT included here — it's carried separately on the
// line (see shopifyLinesToQboLines) and surfaces in QBO's dedicated SKU
// column via the referenced Item's Sku. Keeping it out of the description
// avoids the SKU appearing twice (Products column + SKU column).
export function formatLineDescription(item) {
  if (!item) return ''
  const productName = item.name || item.title || `Item ${item.id ?? ''}`.trim()
  return item.vendor ? `${productName} by ${item.vendor}` : productName
}
