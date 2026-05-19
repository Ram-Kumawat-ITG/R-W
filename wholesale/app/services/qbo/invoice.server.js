import { qbo } from './client.server'
import { config } from '../config.server'
import { createLogger } from '../logger.server'

const log = createLogger('qbo.invoice')

// QBO requires every invoice line to reference an Item. Operators
// configure a generic "Wholesale" item in QBO and set QBO_DEFAULT_ITEM_ID
// to its numeric Id. Defaults to "1" (the canonical Services item in
// fresh sandbox companies).
function defaultItemId() {
  return config.qbo.defaultItemId
}

function toLine(item) {
  const amount = Number(item.amount)
  if (!Number.isFinite(amount)) {
    throw new Error(`Invoice line amount is not numeric: ${item.amount}`)
  }
  return {
    DetailType: 'SalesItemLineDetail',
    Amount: amount,
    Description: item.description || item.name || 'Item',
    SalesItemLineDetail: {
      ItemRef: { value: item.qboItemId || defaultItemId() },
      Qty: item.quantity ?? 1,
      UnitPrice: item.unitPrice ?? amount,
    },
  }
}

export async function createInvoice({ qboCustomerId, currency, lines, memo, dueDate, docNumber }) {
  if (!qboCustomerId) throw new Error('createInvoice: qboCustomerId is required')
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error('createInvoice: at least one line is required')
  }

  const payload = {
    CustomerRef: { value: String(qboCustomerId) },
    Line: lines.map(toLine),
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
  log.info('create.request', { qboCustomerId, lineCount: lines.length, docNumber })

  const res = await qbo.post('/invoice', payload)
  const created = res?.Invoice
  if (!created?.Id) throw new Error('QBO invoice create returned no Id')

  console.log(`[QBO invoice] CREATED Id=${created.Id} DocNumber=${created.DocNumber} TotalAmt=${created.TotalAmt}`)
  log.info('create.success', {
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
