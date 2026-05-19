import { nmiTransact } from './client.server'
import { createLogger } from '../logger.server'

const log = createLogger('nmi.payment')

// NMI response codes:
//   1 = approved, 2 = declined, 3 = error (validation/auth)
const RESPONSE_OUTCOME = { 1: 'approved', 2: 'declined', 3: 'error' }

function classifyResponse(res) {
  return {
    outcome: RESPONSE_OUTCOME[res.response] || 'error',
    transactionId: res.transactionid,
    responseCode: res.response_code,
    responseText: res.responsetext,
    authCode: res.authcode,
    avsResponse: res.avsresponse,
    cvvResponse: res.cvvresponse,
    raw: res,
  }
}

// Charge a stored payment method. The vault id MUST already exist —
// this is the production path used by the recurring scheduler.
export async function chargeCustomerVault({ customerVaultId, amount, currency, orderId, invoiceNumber }) {
  if (!customerVaultId) throw new Error('chargeCustomerVault: customerVaultId is required')
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`chargeCustomerVault: amount must be > 0, got ${amount}`)
  }

  const params = {
    type: 'sale',
    customer_vault_id: customerVaultId,
    amount: amount.toFixed(2),
    currency: currency || 'USD',
    orderid: orderId,
    order_description: invoiceNumber ? `Invoice ${invoiceNumber}` : undefined,
  }

  console.log(`\n[NMI charge] vault=${customerVaultId} amount=$${amount.toFixed(2)} order=${orderId}`)
  log.info('charge.request', { customerVaultId, amount, orderId, invoiceNumber })

  const res = await nmiTransact(params)
  const result = classifyResponse(res)

  console.log(`[NMI charge] outcome=${result.outcome.toUpperCase()} txn=${result.transactionId || '-'} code=${result.responseCode} "${result.responseText}"`)
  log.info('charge.response', {
    outcome: result.outcome,
    transactionId: result.transactionId,
    responseCode: result.responseCode,
    responseText: result.responseText,
    authCode: result.authCode,
  })
  return result
}

// Optional helper for admin tooling — refund or void a prior transaction.
export async function refundTransaction({ transactionId, amount }) {
  const params = { type: 'refund', transactionid: transactionId }
  if (amount) params.amount = amount.toFixed(2)
  const res = await nmiTransact(params)
  return classifyResponse(res)
}

export async function voidTransaction({ transactionId }) {
  const res = await nmiTransact({ type: 'void', transactionid: transactionId })
  return classifyResponse(res)
}
