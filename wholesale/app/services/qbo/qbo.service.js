// QBO domain methods — what the rest of the app uses to talk to
// QuickBooks. Combines customer find-or-create, invoice creation, and
// payment recording. All HTTP plumbing is in qbo.apis.js.

import { qbo, qboGetBinary } from './qbo.apis'
import { qboConfig } from './qbo.config'
import { QBO_APP_URLS } from './qbo.constants'
import { escapeQboQuery, toCustomerPayload, toInvoiceLine, toQboAddress } from './qbo.utils'
import QboItemMap from '../../models/qboItemMap.server'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('qbo.service')

// ── Customer ─────────────────────────────────────────────────────────

export async function findCustomerByEmail(email) {
  if (!email) return null
  const stmt = `SELECT * FROM Customer WHERE PrimaryEmailAddr = '${escapeQboQuery(email)}' MAXRESULTS 1`
  const res = await qbo.query(stmt)
  const customer = res?.QueryResponse?.Customer?.[0]
  return customer || null
}

export async function createCustomer(profile) {
  const payload = toCustomerPayload(profile)
  log.info('customer.create.request', { displayName: payload.DisplayName })
  const res = await qbo.post('/customer', payload)
  const created = res?.Customer
  if (!created?.Id) {
    throw new Error('QBO customer create returned no Id')
  }
  log.info('customer.create.success', { qboId: created.Id })
  return created
}

export async function findOrCreateCustomer(profile) {
  console.log(`\n[customers] QBO lookup for ${profile.email}`)
  const existing = await findCustomerByEmail(profile.email)
  if (existing) {
    console.log(`[customers] QBO match found — Id=${existing.Id} DisplayName="${existing.DisplayName}"`)
    log.info('customer.found.existing', { qboId: existing.Id, email: profile.email })
    return { customer: existing, created: false }
  }
  console.log(`[customers] QBO no match — creating new customer`)
  const created = await createCustomer(profile)
  console.log(`[customers] QBO customer created Id=${created.Id} DisplayName="${created.DisplayName}"`)
  return { customer: created, created: true }
}

// ── Items (SKU column support) ───────────────────────────────────────
//
// QBO sources an invoice's SKU column from the referenced Item's `Sku`
// field (there's no per-line SKU). To show SKUs we reference a per-product
// QBO Item carrying that SKU. `findOrCreateItemBySku` mirrors the customer
// find-or-create + caches the resolved id in `qbo_item_maps`. Everything
// here is best-effort: createInvoice falls back to the default item when an
// item can't be resolved, so invoicing never breaks.

// Income account for newly-created Items. Resolved once from the default
// item's IncomeAccountRef (so new items book to the same account as the
// existing generic item), falling back to QBO_WHOLESALE_INCOME_ACCOUNT_ID. Cached
// in-module; `undefined` = not yet resolved, `null` = resolved-but-none.
let cachedIncomeAccountRef
async function resolveIncomeAccountRef() {
  if (cachedIncomeAccountRef !== undefined) return cachedIncomeAccountRef
  try {
    const res = await qbo.get(`/item/${encodeURIComponent(qboConfig.defaultItemId)}`)
    const ref = res?.Item?.IncomeAccountRef
    if (ref?.value) {
      cachedIncomeAccountRef = { value: String(ref.value) }
      return cachedIncomeAccountRef
    }
  } catch (err) {
    log.warn('item.income_account.lookup_failed', { err: err?.message || String(err) })
  }
  cachedIncomeAccountRef = qboConfig.incomeAccountId
    ? { value: String(qboConfig.incomeAccountId) }
    : null
  return cachedIncomeAccountRef
}

async function findItemBySku(sku) {
  if (!sku) return null
  const stmt = `SELECT * FROM Item WHERE Sku = '${escapeQboQuery(sku)}' MAXRESULTS 1`
  const res = await qbo.query(stmt)
  return res?.QueryResponse?.Item?.[0] || null
}

async function findItemByName(name) {
  if (!name) return null
  const stmt = `SELECT * FROM Item WHERE Name = '${escapeQboQuery(name)}' MAXRESULTS 1`
  const res = await qbo.query(stmt)
  return res?.QueryResponse?.Item?.[0] || null
}

// QBO Item Name must be UNIQUE and cannot contain ':'. Multiple products /
// variants frequently share a display name but have different SKUs, so we
// make the Name unique by appending the SKU — otherwise QBO rejects the
// second create as a duplicate name and we'd be forced to reuse the wrong
// item (the bug that showed every line with the first line's SKU). Clamp to
// QBO's 100-char Name limit.
function sanitizeItemName(name, sku) {
  const base = String(name || '').replace(/:/g, '-').trim()
  const skuPart = sku ? ` (${String(sku).replace(/:/g, '-').trim()})` : ''
  let full = `${base}${skuPart}`.trim()
  if (!full) full = sku ? `SKU ${sku}` : 'Item'
  return full.length > 100 ? full.slice(0, 100).trim() : full
}

async function createItem({ name, sku }) {
  const incomeRef = await resolveIncomeAccountRef()
  if (!incomeRef) throw new Error('cannot create QBO Item — no IncomeAccountRef available')
  const Name = sanitizeItemName(name, sku)
  const payload = { Name, Sku: sku, Type: 'Service', IncomeAccountRef: incomeRef }
  try {
    const res = await qbo.post('/item', payload)
    const created = res?.Item
    if (!created?.Id) throw new Error('QBO item create returned no Id')
    return created
  } catch (err) {
    // Name collision (pre-existing item, or a concurrent create won the
    // race). Adopt the existing item ONLY when its SKU matches what we're
    // resolving — never return an item with a different SKU (that's what
    // previously caused every line to show the first line's SKU).
    if (/duplicate name|6240/i.test(err?.message || '')) {
      const existing = await findItemByName(Name)
      if (existing?.Id && String(existing.Sku || '') === String(sku || '')) {
        return existing
      }
    }
    throw err
  }
}

// Resolve a SKU to a QBO Item id: cache → QBO query-by-SKU → create. Caches
// the result. Returns the id, or null on any failure (caller falls back to
// the default item). `name` seeds a new item's Name.
export async function findOrCreateItemBySku({ sku, name }) {
  const clean = sku ? String(sku).trim() : ''
  if (!clean) return null
  try {
    // Trust a cache hit ONLY when the stored row records the SAME SKU on the
    // mapped item. Rows missing `qboSku` (or with a mismatch) are stale /
    // poisoned by the earlier name-collision bug — re-resolve + overwrite.
    const cached = await QboItemMap.findOne({ sku: clean }).select('qboItemId qboSku').lean()
    if (cached?.qboItemId && cached.qboSku === clean) return cached.qboItemId

    let item = await findItemBySku(clean)
    if (!item) item = await createItem({ name, sku: clean })
    const qboItemId = item?.Id ? String(item.Id) : null
    if (qboItemId) {
      await QboItemMap.updateOne(
        { sku: clean },
        {
          $set: {
            qboItemId,
            qboSku: item?.Sku ? String(item.Sku) : clean,
            name: name || item?.Name || undefined,
          },
        },
        { upsert: true },
      )
      console.log(`[items] resolved SKU "${clean}" → QBO item ${qboItemId}`)
    }
    return qboItemId
  } catch (err) {
    log.warn('item.resolve_failed', { sku: clean, err: err?.message || String(err) })
    return null
  }
}

// ── Invoice ──────────────────────────────────────────────────────────

export async function createInvoice({
  qboCustomerId,
  currency,
  lines,
  memo,
  dueDate,
  docNumber,
  shipAddr,
  shipDate,
  taxAmount,
}) {
  if (!qboCustomerId) throw new Error('createInvoice: qboCustomerId is required')
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error('createInvoice: at least one line is required')
  }

  // Resolve per-product QBO Items so the invoice's SKU column populates.
  // Best-effort per line: a null result leaves `qboItemId` unset and
  // toInvoiceLine falls back to the default item (current behavior). Only
  // product lines carry a `sku`; shipping / discount / processing-fee lines
  // are skipped and stay on the default item.
  for (const l of lines) {
    if (l.kind === 'discount' || !l.sku) continue
    const itemId = await findOrCreateItemBySku({ sku: l.sku, name: l.name })
    if (itemId) l.qboItemId = itemId
  }

  const shipAddrPayload = toQboAddress(shipAddr)
  // Tax is SOURCED FROM SHOPIFY (order.total_tax) and passed straight through
  // to QBO's native summary "Tax" row via TxnTaxDetail.TotalTax — NOT as a
  // product line (see invoice.utils.shopifyLinesToQboLines). QBO adds it to
  // the line subtotal so TotalAmt still reconciles with Shopify's total_price.
  // Always sent (even at $0) so the customer sees a tax figure on every
  // invoice. By design we do NOT apply a QBO tax code (TxnTaxCodeRef) — tax is
  // configured in Shopify, not QBO. Note: whether QBO RENDERS a "$0.00 Tax"
  // row in its summary can still depend on a tax code being present; with a
  // non-zero Shopify tax the row shows, but a $0 row may be omitted by QBO's
  // template. The app's own Order Details panels always show the tax line
  // regardless. (US automated-sales-tax companies may also recompute/ignore
  // this override.)
  const tax = Number(taxAmount || 0)
  const txnTaxDetail = { TotalTax: Number(tax.toFixed(2)) }
  const payload = {
    CustomerRef: { value: String(qboCustomerId) },
    Line: lines.map((l) => toInvoiceLine(l, qboConfig.defaultItemId)),
    CurrencyRef: currency ? { value: currency } : undefined,
    CustomerMemo: memo ? { value: memo } : undefined,
    DueDate: dueDate || undefined,
    DocNumber: docNumber || undefined,
    ShipAddr: shipAddrPayload,
    ShipDate: shipDate || undefined,
    TxnTaxDetail: txnTaxDetail,
  }

  console.log(`\n[QBO invoice] creating for customer=${qboCustomerId} lines=${lines.length}`)
  console.log(`[QBO invoice] line summary:`)
  for (const line of lines) {
    console.log(`              - ${line.description} qty=${line.quantity} unit=${line.unitPrice} total=${line.amount}`)
  }
  console.log(
    `[QBO invoice] shipAddr=${shipAddrPayload ? 'set' : '(none)'} shipDate=${shipDate || '(none)'} ` +
      `tax=${txnTaxDetail ? `$${txnTaxDetail.TotalTax.toFixed(2)} (summary row)` : '(none)'}`,
  )
  log.info('invoice.create.request', {
    qboCustomerId,
    lineCount: lines.length,
    docNumber,
    hasShipAddr: Boolean(shipAddrPayload),
    shipDate: shipDate || null,
    totalTax: txnTaxDetail ? txnTaxDetail.TotalTax : 0,
  })

  const res = await qbo.post('/invoice', payload)
  const created = res?.Invoice
  if (!created?.Id) throw new Error('QBO invoice create returned no Id')

  console.log(`[QBO invoice] CREATED Id=${created.Id} DocNumber=${created.DocNumber} TotalAmt=${created.TotalAmt}`)
  log.info('invoice.create.success', {
    invoiceId: created.Id,
    docNumber: created.DocNumber,
    totalAmt: created.TotalAmt,
  })
  return created
}

export async function getInvoice(invoiceId) {
  const res = await qbo.get(`/invoice/${encodeURIComponent(invoiceId)}`)
  return res?.Invoice
}

// Append one or more lines to an existing QBO invoice. QBO replaces the
// Line array wholesale on sparse updates that include it, so we GET the
// current invoice, append our new lines to the existing array, and POST
// the combined set back with the current SyncToken. Returns the updated
// invoice (new SyncToken + new TotalAmt).
//
// Used at settlement time to append the per-method processing-fee line
// when an NMI charge approves — see invoice.service.propagateSuccessful-
// Payment. The fee is decided per-settlement so this update path is the
// source of truth for fee application on the QBO ledger.
export async function appendInvoiceLines({ qboInvoiceId, newLines }) {
  if (!qboInvoiceId) throw new Error('appendInvoiceLines: qboInvoiceId is required')
  if (!Array.isArray(newLines) || newLines.length === 0) {
    throw new Error('appendInvoiceLines: at least one new line is required')
  }
  const current = await getInvoice(qboInvoiceId)
  if (!current?.Id) {
    throw new Error(`appendInvoiceLines: QBO invoice ${qboInvoiceId} not found`)
  }
  const existingLines = Array.isArray(current.Line) ? current.Line : []
  const appended = newLines.map((l) => toInvoiceLine(l, qboConfig.defaultItemId))
  const payload = {
    Id: String(current.Id),
    SyncToken: String(current.SyncToken),
    sparse: true,
    Line: [...existingLines, ...appended],
  }
  console.log(
    `[QBO invoice] appending ${appended.length} line(s) to Id=${current.Id} ` +
      `(was ${existingLines.length} lines, SyncToken=${current.SyncToken})`,
  )
  log.info('invoice.append_lines.request', {
    qboInvoiceId,
    existingCount: existingLines.length,
    newCount: appended.length,
    syncToken: current.SyncToken,
  })
  const res = await qbo.post('/invoice', payload)
  const updated = res?.Invoice
  if (!updated?.Id) throw new Error('QBO invoice update returned no Id')
  console.log(
    `[QBO invoice] APPENDED Id=${updated.Id} new TotalAmt=${updated.TotalAmt} ` +
      `SyncToken=${updated.SyncToken}`,
  )
  return updated
}

// Replace the processing-fee line on an existing QBO invoice (and,
// optionally, its DueDate) in a single sparse update. Used when an
// invoice's payment method changes and the fee must be recalculated for
// the new method — see services/invoice/paymentPreference.service.
//
// QBO has no line-level delete, so we GET the current invoice, drop every
// existing processing-fee line (matched by the same /Processing Fee/i
// description the rest of the app uses), append the caller's new fee line
// (or none, when `feeLine` is null → fee removed, e.g. card → cheque), and
// POST the full Line array back as a sparse update with the current
// SyncToken. QBO recomputes TotalAmt and the SubTotal summary line. The
// SyncToken acts as the concurrency guard: if a CRON charge updated the
// invoice between our GET and POST, QBO rejects the stale token and the
// caller's per-invoice try/catch isolates the failure.
export async function setInvoiceProcessingFee({ qboInvoiceId, feeLine = null, dueDate }) {
  if (!qboInvoiceId) throw new Error('setInvoiceProcessingFee: qboInvoiceId is required')
  const current = await getInvoice(qboInvoiceId)
  if (!current?.Id) {
    throw new Error(`setInvoiceProcessingFee: QBO invoice ${qboInvoiceId} not found`)
  }
  const existingLines = Array.isArray(current.Line) ? current.Line : []
  // Strip any existing processing-fee line(s). Same matcher as
  // invoice.utils.findExistingProcessingFeeLine, inlined here to keep the
  // QBO transport layer independent of the invoice domain.
  const withoutFee = existingLines.filter(
    (l) => !/Processing Fee/i.test(String(l?.Description || '')),
  )
  const nextLines = feeLine
    ? [...withoutFee, toInvoiceLine(feeLine, qboConfig.defaultItemId)]
    : withoutFee
  const payload = {
    Id: String(current.Id),
    SyncToken: String(current.SyncToken),
    sparse: true,
    Line: nextLines,
  }
  if (dueDate) payload.DueDate = dueDate
  console.log(
    `[QBO invoice] setProcessingFee Id=${current.Id} ` +
      `${feeLine ? `fee="${feeLine.description}" ($${feeLine.amount})` : 'fee=REMOVED'} ` +
      `dueDate=${dueDate || '(unchanged)'} (was ${existingLines.length} lines, SyncToken=${current.SyncToken})`,
  )
  log.info('invoice.set_processing_fee.request', {
    qboInvoiceId,
    feeApplied: Boolean(feeLine),
    feeAmount: feeLine?.amount ?? 0,
    dueDate: dueDate || null,
    syncToken: current.SyncToken,
  })
  const res = await qbo.post('/invoice', payload)
  const updated = res?.Invoice
  if (!updated?.Id) throw new Error('QBO invoice update returned no Id')
  console.log(
    `[QBO invoice] setProcessingFee DONE Id=${updated.Id} new TotalAmt=${updated.TotalAmt} ` +
      `DueDate=${updated.DueDate} SyncToken=${updated.SyncToken}`,
  )
  return updated
}

// Marker that delimits the auto-managed shipping block inside an invoice's
// CustomerMemo, so repeated writes replace (not duplicate) it. Anything the
// invoice already had above this marker (e.g. "Shopify order #1140") is
// preserved.
const SHIPPING_MEMO_MARKER = '\n\nShipping:\n'

// Set a QBO invoice's shipping details — the carrier/tracking block in the
// CustomerMemo (the message shown on the customer's invoice) AND the native
// `ShipDate` field (the official Ship Date, sourced from the Shopify
// fulfillment date rather than the order-creation date set at invoice
// creation). `lines` is an array of human strings like
// "UPS — 1Z999AA1… (In transit)"; `shipDate` is "YYYY-MM-DD". GET the
// current invoice, preserve the non-shipping part of the memo, replace the
// shipping block, set ShipDate, sparse-POST with the current SyncToken
// (concurrency guard, same as the other sparse updates). Empty `lines`
// removes the shipping block; omitted `shipDate` leaves ShipDate untouched.
// QBO caps CustomerMemo at 1000 chars — we clamp.
export async function setInvoiceShipping({ qboInvoiceId, lines = [], shipDate, trackingNum }) {
  if (!qboInvoiceId) throw new Error('setInvoiceShipping: qboInvoiceId is required')
  const current = await getInvoice(qboInvoiceId)
  if (!current?.Id) {
    throw new Error(`setInvoiceShipping: QBO invoice ${qboInvoiceId} not found`)
  }
  const existingMemo = current.CustomerMemo?.value || ''
  const base = existingMemo.split(SHIPPING_MEMO_MARKER)[0].trimEnd()
  let memo = base
  if (Array.isArray(lines) && lines.length) {
    memo = `${base}${base ? SHIPPING_MEMO_MARKER : 'Shipping:\n'}${lines.join('\n')}`
  }
  if (memo.length > 1000) memo = memo.slice(0, 1000)
  const trackingNumValue = trackingNum ? String(trackingNum).slice(0, 250) : undefined
  // No-op guard: skip the POST (and a needless SyncToken bump) when none of
  // the shipping fields would change. This lets callers invoke setInvoice
  // Shipping on every order view to backfill TrackingNum / ShipDate onto
  // invoices synced before those fields existed, without redundant writes.
  const memoChanged = memo !== existingMemo
  const shipChanged = Boolean(shipDate) && current.ShipDate !== shipDate
  const trackChanged =
    Boolean(trackingNumValue) && String(current.TrackingNum || '') !== trackingNumValue
  if (!memoChanged && !shipChanged && !trackChanged) {
    console.log(`[QBO invoice] setShipping Id=${current.Id} — no change, skipping POST`)
    return current
  }
  const payload = {
    Id: String(current.Id),
    SyncToken: String(current.SyncToken),
    sparse: true,
    CustomerMemo: memo ? { value: memo } : undefined,
  }
  if (shipDate) payload.ShipDate = shipDate
  // Native QBO shipping field — renders in the invoice header next to
  // Ship Date / Ship Via (when shipping is enabled on the company's sales
  // form). This is how "tracking details" sit BELOW the Ship Date on the
  // rendered invoice, distinct from the CustomerMemo message block. Single
  // free-text field, so multi-shipment numbers are joined by the caller.
  if (trackingNumValue) payload.TrackingNum = trackingNumValue
  console.log(
    `[QBO invoice] setShipping Id=${current.Id} lines=${lines.length} ` +
      `shipDate=${shipDate || '(unchanged)'} trackingNum=${trackingNum ? 'set' : '(unchanged)'} ` +
      `SyncToken=${current.SyncToken}`,
  )
  log.info('invoice.set_shipping.request', {
    qboInvoiceId,
    lineCount: lines.length,
    shipDate: shipDate || null,
    hasTrackingNum: Boolean(trackingNum),
    syncToken: current.SyncToken,
  })
  const res = await qbo.post('/invoice', payload)
  const updated = res?.Invoice
  if (!updated?.Id) throw new Error('QBO invoice update returned no Id')
  return updated
}

// Deep link an admin can click to open the QBO invoice in the QuickBooks
// web app. Routes to sandbox vs prod based on QBO_ENVIRONMENT; Intuit
// handles realm selection from the operator's login session.
export function getInvoiceWebUrl(invoiceId) {
  if (!invoiceId) return null
  const host = QBO_APP_URLS[qboConfig.environment] || QBO_APP_URLS.production
  return `${host}/app/invoice?txnId=${encodeURIComponent(invoiceId)}`
}

// Fetch the rendered invoice PDF straight from QBO. Used by the admin
// proxy endpoint so operators can view the actual invoice document
// without leaving the app or logging into QuickBooks.
export async function getInvoicePdf(invoiceId) {
  if (!invoiceId) throw new Error('getInvoicePdf: invoiceId is required')
  return qboGetBinary(`/invoice/${encodeURIComponent(invoiceId)}/pdf`, {
    accept: 'application/pdf',
  })
}

// Void a QBO invoice. Void (vs delete) keeps the document on QBO's
// ledger for audit but zeros out the amount and removes the line items'
// effect on inventory / income. Used by the orders/cancelled webhook
// when the cancelled Shopify order has a corresponding QBO invoice
// that has not yet received any payments.
//
// QBO endpoint: POST /v3/company/{realmId}/invoice?operation=void
// Body must include Id + current SyncToken. We GET the latest invoice
// first to grab the SyncToken so concurrent updates don't trip a
// stale-write error.
//
// Returns the updated QBO invoice. Throws if the invoice has linked
// payments (callers should check `LinkedTxn` first; the orders/cancelled
// flow gates on local `amountPaid === 0` before calling).
export async function voidInvoice(qboInvoiceId) {
  if (!qboInvoiceId) throw new Error('voidInvoice: qboInvoiceId is required')

  const current = await getInvoice(qboInvoiceId)
  if (!current?.Id) {
    throw new Error(`voidInvoice: QBO invoice ${qboInvoiceId} not found`)
  }

  const payload = {
    Id: String(current.Id),
    SyncToken: String(current.SyncToken),
  }

  console.log(
    `\n[QBO void] voiding invoice Id=${current.Id} DocNumber=${current.DocNumber} ` +
      `currentBalance=${current.Balance} SyncToken=${current.SyncToken}`,
  )
  log.info('invoice.void.request', {
    qboInvoiceId,
    docNumber: current.DocNumber,
    syncToken: current.SyncToken,
  })

  const res = await qbo.post('/invoice?operation=void', payload)
  const voided = res?.Invoice
  if (!voided?.Id) {
    throw new Error('QBO invoice void returned no Id')
  }
  console.log(
    `[QBO void] VOIDED Id=${voided.Id} new SyncToken=${voided.SyncToken} ` +
      `TotalAmt=${voided.TotalAmt} Balance=${voided.Balance}`,
  )
  log.info('invoice.void.success', {
    qboInvoiceId: voided.Id,
    docNumber: voided.DocNumber,
    syncToken: voided.SyncToken,
  })
  return voided
}

// ── Email / Send ─────────────────────────────────────────────────────

// Send (or re-send) the customer-facing invoice email via QBO's built-in
// mail endpoint.
//   POST /v3/company/<realmId>/invoice/<invoiceId>/send?sendTo=<email>
//
// When `sendTo` is provided, QBO updates Invoice.BillEmail.Address to
// that value and delivers to it; otherwise it falls back to the
// existing Invoice.BillEmail.Address (auto-populated from
// Customer.PrimaryEmailAddr at invoice creation). After a successful
// send, QBO sets Invoice.EmailStatus = "EmailSent" and stamps
// DeliveryInfo. The email always reflects the CURRENT invoice state,
// so re-sending after recordPayment shows the updated balance + paid
// amount automatically — no separate "payment receipt" channel is
// needed.
//
// Idempotency note: QBO does NOT dedup calls to /send — calling twice
// delivers two emails. Callers must gate on local state (e.g.
// invoiceEmailSentAt / invoiceEmailedAmountPaid / invoiceEmailedStatus)
// to avoid duplicate deliveries on retry. This function intentionally
// throws on QBO errors so callers can record the failure; the higher-
// level dispatcher in invoice.service.js swallows the throw to keep
// email failures from blocking payment sync.
export async function sendInvoiceEmail({ qboInvoiceId, sendTo }) {
  if (!qboInvoiceId) throw new Error('sendInvoiceEmail: qboInvoiceId is required')
  const query = sendTo ? { sendTo } : undefined
  console.log(
    `\n[QBO email] sending invoice Id=${qboInvoiceId}${sendTo ? ` to ${sendTo}` : ' (using BillEmail)'}`,
  )
  log.info('invoice.send.request', { qboInvoiceId, sendTo: sendTo || '(billEmail)' })
  const res = await qbo.send(`/invoice/${encodeURIComponent(qboInvoiceId)}/send`, query)
  const updated = res?.Invoice
  console.log(
    `[QBO email] sent invoice Id=${updated?.Id} EmailStatus=${updated?.EmailStatus} ` +
      `BillEmail=${updated?.BillEmail?.Address || '(unset)'}`,
  )
  log.info('invoice.send.success', {
    qboInvoiceId: updated?.Id,
    emailStatus: updated?.EmailStatus,
    billEmail: updated?.BillEmail?.Address,
  })
  return updated
}

// ── Read-only listing helpers (admin dashboard) ──────────────────────
//
// All three list helpers use QBO's QL `/query` endpoint via qbo.query()
// and share the same response shape so the admin route loaders can
// treat them interchangeably:
//
//   { entities, startPosition, pageSize, returned, totalCount? }
//
// QBO returns up to 1,000 records per response (hard cap), but we
// constrain to a smaller pageSize (default 50) so the loader stays
// snappy and operators can scan a single page. Pagination uses QBO's
// 1-based STARTPOSITION token; we do NOT cursor on Id because QBO does
// not guarantee stable Id ordering across pages on every entity.
//
// `where` is a raw QBO QL predicate (no leading WHERE). Callers must
// escape any embedded values via escapeQboQuery — this function does NOT
// auto-escape because some callers pass operators / IN clauses.
//
// `orderBy` is a raw QBO QL ORDER BY clause (no leading ORDER BY).
// QBO only supports ordering on indexed fields; the safe ones used here
// are Id, MetaData.CreateTime, TxnDate, and DisplayName.
//
// QBO's `totalCount` field is only reliably populated for `SELECT COUNT(*)`
// queries — listing queries with STARTPOSITION / MAXRESULTS return the
// page records but no grand total. We expose a separate `countXxx`
// helper for that. Loaders that need both a page AND a total run them
// in parallel via Promise.all.

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

function clampPageSize(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_PAGE_SIZE
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(v)))
}

async function runListQuery({ entity, fields = '*', where, orderBy, pageSize, startPosition }) {
  const wherePart = where ? ` WHERE ${where}` : ''
  const orderPart = orderBy ? ` ORDERBY ${orderBy}` : ''
  const sp = Math.max(1, Math.floor(Number(startPosition) || 1))
  const ps = clampPageSize(pageSize)
  const stmt = `SELECT ${fields} FROM ${entity}${wherePart}${orderPart} STARTPOSITION ${sp} MAXRESULTS ${ps}`
  const res = await qbo.query(stmt)
  const entities = res?.QueryResponse?.[entity] || []
  return {
    entities,
    startPosition: sp,
    pageSize: ps,
    returned: entities.length,
    totalCount:
      typeof res?.QueryResponse?.totalCount === 'number'
        ? res.QueryResponse.totalCount
        : null,
  }
}

async function runCountQuery({ entity, where }) {
  const wherePart = where ? ` WHERE ${where}` : ''
  const stmt = `SELECT COUNT(*) FROM ${entity}${wherePart}`
  const res = await qbo.query(stmt)
  // QBO returns the count as `QueryResponse.totalCount`. Fall back to 0
  // if the field is missing (e.g. when no matching rows).
  return typeof res?.QueryResponse?.totalCount === 'number'
    ? res.QueryResponse.totalCount
    : 0
}

export async function listCustomers({ pageSize, startPosition, where, orderBy } = {}) {
  return runListQuery({
    entity: 'Customer',
    where,
    orderBy: orderBy || 'DisplayName',
    pageSize,
    startPosition,
  })
}

export async function countCustomers({ where } = {}) {
  return runCountQuery({ entity: 'Customer', where })
}

// Invoice queries can't filter on the referenced customer's name directly
// (CustomerRef is an id-only reference field in QBO QL), so a customer-name
// filter resolves matching Customer ids first, then the caller ANDs
// `CustomerRef IN (...)` onto the Invoice WHERE clause.
export async function findCustomerIdsByName(name, { maxResults = 100 } = {}) {
  const v = escapeQboQuery(String(name || '').trim())
  if (!v) return []
  const stmt = `SELECT Id FROM Customer WHERE DisplayName LIKE '%${v}%' MAXRESULTS ${maxResults}`
  const res = await qbo.query(stmt)
  const entities = res?.QueryResponse?.Customer || []
  return entities.map((c) => c.Id)
}

// Shared "filter by customer name" fragment for any entity carrying a
// CustomerRef (Invoice, Payment, ...). Returns null when the filter is
// inactive, or an always-false `Id = '0'` sentinel when the name matches no
// customer — callers AND this onto their own WHERE clause rather than
// silently dropping an unmatched filter.
export async function buildCustomerRefWhere(name) {
  const trimmed = String(name || '').trim()
  if (!trimmed) return null
  const ids = await findCustomerIdsByName(trimmed)
  if (ids.length === 0) return "Id = '0'"
  return `CustomerRef IN (${ids.map((id) => `'${id}'`).join(', ')})`
}

export async function listInvoices({ pageSize, startPosition, where, orderBy } = {}) {
  return runListQuery({
    entity: 'Invoice',
    where,
    // Newest first — TxnDate is the invoice date, MetaData.CreateTime
    // would also work but QBO QL doesn't always accept dotted paths in
    // ORDERBY across the older API versions, so TxnDate is the safer bet.
    orderBy: orderBy || 'TxnDate DESC',
    pageSize,
    startPosition,
  })
}

export async function countInvoices({ where } = {}) {
  return runCountQuery({ entity: 'Invoice', where })
}

export async function listPayments({ pageSize, startPosition, where, orderBy } = {}) {
  return runListQuery({
    entity: 'Payment',
    where,
    orderBy: orderBy || 'TxnDate DESC',
    pageSize,
    startPosition,
  })
}

export async function countPayments({ where } = {}) {
  return runCountQuery({ entity: 'Payment', where })
}

// Composite metrics for the QBO Dashboard tab. Runs every counter
// in parallel + pulls the most recent 5 payments and 5 invoices in
// one round trip via Promise.all. Each individual query is wrapped in
// `safe` so one failed counter (e.g. permission error on Payment)
// degrades to `null` rather than taking the whole dashboard down — the
// route loader surfaces the `errors` array as a warning banner.
//
// Date math is done in JS off `new Date()` so we don't rely on QBO's
// server clock for the "today" pivot used by the Overdue counter.
//
// Revenue summary = sum of TotalAmt across invoices with TxnDate in
// the current calendar month. We list (vs aggregate) because QBO QL
// does not support SUM() — but the page size is capped at the same
// MAX_PAGE_SIZE (200) so very high-volume tenants will see a
// "showing first 200 of N" disclaimer on the dashboard. That's a
// pragmatic ceiling; if it ever becomes a problem we can paginate.
export async function getDashboardSnapshot() {
  const errors = []
  const safe = async (label, fn) => {
    try {
      return await fn()
    } catch (e) {
      errors.push({ label, message: e?.message || String(e) })
      return null
    }
  }

  const now = new Date()
  const todayYmd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const monthStartYmd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`

  const [
    customerCount,
    activeCustomerCount,
    invoiceCount,
    paidInvoiceCount,
    pendingInvoiceCount,
    overdueInvoiceCount,
    recentPayments,
    recentInvoices,
    monthInvoices,
  ] = await Promise.all([
    safe('Total customers', () => countCustomers()),
    safe('Active customers', () => countCustomers({ where: "Active = true" })),
    safe('Total invoices', () => countInvoices()),
    // "Balance = '0'" identifies fully-paid invoices on QBO's side. Voided
    // invoices also have Balance=0, so we exclude those. QBO QL gives no
    // direct "is voided" predicate — but the TotalAmt is zeroed on void,
    // so TotalAmt > 0 + Balance = 0 narrows to real paid invoices.
    safe('Paid invoices', () => countInvoices({ where: "Balance = '0' AND TotalAmt > '0'" })),
    safe('Pending invoices', () => countInvoices({ where: "Balance > '0'" })),
    safe('Overdue invoices', () =>
      countInvoices({
        where: `Balance > '0' AND DueDate < '${todayYmd}'`,
      }),
    ),
    safe('Recent payments', () => listPayments({ pageSize: 5 })),
    safe('Recent invoices', () => listInvoices({ pageSize: 5 })),
    safe('This month invoices', () =>
      // ORDERBY omitted — we just need the sum across the window.
      listInvoices({
        pageSize: MAX_PAGE_SIZE,
        where: `TxnDate >= '${monthStartYmd}'`,
        orderBy: 'TxnDate DESC',
      }),
    ),
  ])

  // Revenue summary — projected from the month's invoices. Two figures:
  //   billed   — sum of TotalAmt (everything invoiced this month)
  //   collected— sum of (TotalAmt - Balance) (what's been paid against
  //              this month's invoices, including partial receipts)
  let revenueBilled = null
  let revenueCollected = null
  let monthInvoicesCount = null
  let monthInvoicesTruncated = false
  if (monthInvoices?.entities) {
    revenueBilled = 0
    revenueCollected = 0
    for (const inv of monthInvoices.entities) {
      const total = Number(inv.TotalAmt || 0)
      const balance = Number(inv.Balance || 0)
      revenueBilled += total
      revenueCollected += total - balance
    }
    revenueBilled = Number(revenueBilled.toFixed(2))
    revenueCollected = Number(revenueCollected.toFixed(2))
    monthInvoicesCount = monthInvoices.returned
    monthInvoicesTruncated = monthInvoices.returned >= MAX_PAGE_SIZE
  }

  return {
    asOf: now.toISOString(),
    counts: {
      customers: customerCount,
      activeCustomers: activeCustomerCount,
      invoices: invoiceCount,
      paidInvoices: paidInvoiceCount,
      pendingInvoices: pendingInvoiceCount,
      overdueInvoices: overdueInvoiceCount,
    },
    revenue: {
      billed: revenueBilled,
      collected: revenueCollected,
      currency: 'USD', // QBO realm currency — would need /v3/company/{realmId}/companyinfo to surface dynamically
      periodLabel: now.toLocaleString(undefined, { month: 'long', year: 'numeric' }),
      sampledInvoiceCount: monthInvoicesCount,
      truncated: monthInvoicesTruncated,
    },
    recentPayments: recentPayments?.entities || [],
    recentInvoices: recentInvoices?.entities || [],
    errors,
  }
}

// ── Payment ──────────────────────────────────────────────────────────

// Record a payment against a QBO invoice. Called after a successful NMI
// charge so QBO's books reflect the same balance the scheduler sees.
export async function recordPayment({ qboCustomerId, qboInvoiceId, amount, currency, paymentRef }) {
  const payload = {
    CustomerRef: { value: String(qboCustomerId) },
    TotalAmt: amount,
    CurrencyRef: currency ? { value: currency } : undefined,
    PaymentRefNum: paymentRef ? String(paymentRef).slice(0, 21) : undefined,
    Line: [
      {
        Amount: amount,
        LinkedTxn: [{ TxnId: String(qboInvoiceId), TxnType: 'Invoice' }],
      },
    ],
  }
  console.log(`\n[QBO payment] recording $${amount} against invoice=${qboInvoiceId} ref=${paymentRef}`)
  log.info('payment.record', { qboInvoiceId, amount, paymentRef })
  const res = await qbo.post('/payment', payload)
  console.log(`[QBO payment] recorded Id=${res?.Payment?.Id} TotalAmt=${res?.Payment?.TotalAmt}`)
  return res?.Payment
}
