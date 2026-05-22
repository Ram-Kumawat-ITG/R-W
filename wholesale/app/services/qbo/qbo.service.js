// QBO domain methods — what the rest of the app uses to talk to
// QuickBooks. Combines customer find-or-create, invoice creation, and
// payment recording. All HTTP plumbing is in qbo.apis.js.

import { qbo, qboGetBinary } from './qbo.apis'
import { qboConfig } from './qbo.config'
import { QBO_APP_URLS } from './qbo.constants'
import { escapeQboQuery, toCustomerPayload, toInvoiceLine, toQboAddress } from './qbo.utils'
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
}) {
  if (!qboCustomerId) throw new Error('createInvoice: qboCustomerId is required')
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error('createInvoice: at least one line is required')
  }

  const shipAddrPayload = toQboAddress(shipAddr)
  const payload = {
    CustomerRef: { value: String(qboCustomerId) },
    Line: lines.map((l) => toInvoiceLine(l, qboConfig.defaultItemId)),
    CurrencyRef: currency ? { value: currency } : undefined,
    CustomerMemo: memo ? { value: memo } : undefined,
    DueDate: dueDate || undefined,
    DocNumber: docNumber || undefined,
    ShipAddr: shipAddrPayload,
    ShipDate: shipDate || undefined,
  }

  console.log(`\n[QBO invoice] creating for customer=${qboCustomerId} lines=${lines.length}`)
  console.log(`[QBO invoice] line summary:`)
  for (const line of lines) {
    console.log(`              - ${line.description} qty=${line.quantity} unit=${line.unitPrice} total=${line.amount}`)
  }
  console.log(
    `[QBO invoice] shipAddr=${shipAddrPayload ? 'set' : '(none)'} shipDate=${shipDate || '(none)'}`,
  )
  log.info('invoice.create.request', {
    qboCustomerId,
    lineCount: lines.length,
    docNumber,
    hasShipAddr: Boolean(shipAddrPayload),
    shipDate: shipDate || null,
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
