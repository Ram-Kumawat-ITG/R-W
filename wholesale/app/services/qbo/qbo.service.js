// QBO domain methods — what the rest of the app uses to talk to
// QuickBooks. Combines customer find-or-create, invoice creation, and
// payment recording. All HTTP plumbing is in qbo.apis.js.

import { qbo } from './qbo.apis'
import { qboConfig } from './qbo.config'
import { escapeQboQuery, toCustomerPayload, toInvoiceLine } from './qbo.utils'
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

export async function createInvoice({ qboCustomerId, currency, lines, memo, dueDate, docNumber }) {
  if (!qboCustomerId) throw new Error('createInvoice: qboCustomerId is required')
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error('createInvoice: at least one line is required')
  }

  const payload = {
    CustomerRef: { value: String(qboCustomerId) },
    Line: lines.map((l) => toInvoiceLine(l, qboConfig.defaultItemId)),
    CurrencyRef: currency ? { value: currency } : undefined,
    CustomerMemo: memo ? { value: memo } : undefined,
    DueDate: dueDate || undefined,
    DocNumber: docNumber || undefined,
  }

  console.log(`\n[QBO invoice] creating for customer=${qboCustomerId} lines=${lines.length}`)
  console.log(`[QBO invoice] line summary:`)
  for (const line of lines) {
    console.log(`              - ${line.description} qty=${line.quantity} unit=${line.unitPrice} total=${line.amount}`)
  }
  log.info('invoice.create.request', { qboCustomerId, lineCount: lines.length, docNumber })

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
