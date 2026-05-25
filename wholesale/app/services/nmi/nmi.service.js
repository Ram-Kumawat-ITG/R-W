// NMI domain methods — Customer Vault find/create, sale charges,
// refund/void admin helpers. All HTTP plumbing is in nmi.apis.js.

import { nmiTransact, nmiQuery } from './nmi.apis'
import { classifyNmiResponse } from './nmi.utils'
import { NMI_SENSITIVE_PARAMS } from './nmi.constants'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('nmi.service')

// ── Customer Vault ───────────────────────────────────────────────────

// Look up an existing Customer Vault entry. NMI doesn't allow query by
// email out of the box on transact.php, so we use query.php which returns
// XML. We do a substring match for the email and pull the first match.
//
// In production, store the `customer_vault_id` against your customer at
// creation time (see CustomerMap.nmiCustomerVaultId) so this lookup is
// only used as a recovery path.
export async function findCustomerVaultByEmail(email) {
  if (!email) return null
  try {
    const xml = await nmiQuery({ report_type: 'customer_vault', email })
    // Cheap structural parse — we only need the id. A full XML parser
    // is overkill and adds a dependency.
    const idMatch = xml.match(/<customer_vault_id>([^<]+)<\/customer_vault_id>/)
    return idMatch ? idMatch[1] : null
  } catch (err) {
    log.warn('vault.lookup.failed', { email, err })
    return null
  }
}

// Confirm a stored vault id still resolves to a real Customer Vault entry
// in NMI. Used as a pre-flight before any sale/charge against a vault id
// that was captured at registration time — protects against the case
// where a vault was deleted out-of-band or the id was corrupted.
//
// Returns `{ valid: boolean, reason?: string }`. Network / transport
// failures resolve to `{ valid: false, reason }` so callers can decide
// whether to retry or skip — they MUST NOT silently proceed to charge.
export async function validateCustomerVault(customerVaultId) {
  if (!customerVaultId) return { valid: false, reason: 'no vault id provided' }
  try {
    const xml = await nmiQuery({
      report_type: 'customer_vault',
      customer_vault_id: customerVaultId,
    })
    // query.php returns a <customer_vault><customer> block on success,
    // or an <error_response>…</error_response> when the id is unknown.
    if (/<error_response>/i.test(xml)) {
      const reason = (xml.match(/<error_response>([^<]+)<\/error_response>/i) || [])[1] || 'vault not found'
      log.warn('vault.validate.not_found', { customerVaultId, reason })
      return { valid: false, reason: reason.trim() }
    }
    const idMatch = xml.match(/<customer_vault_id>([^<]+)<\/customer_vault_id>/)
    if (!idMatch || idMatch[1].trim() !== String(customerVaultId).trim()) {
      log.warn('vault.validate.mismatch', { customerVaultId, returned: idMatch?.[1] })
      return { valid: false, reason: 'vault id not present in NMI response' }
    }
    log.info('vault.validate.ok', { customerVaultId })
    return { valid: true }
  } catch (err) {
    log.warn('vault.validate.failed', { customerVaultId, err })
    return { valid: false, reason: err?.message || 'vault lookup failed' }
  }
}

// Create a Customer Vault profile. Payment details are OPTIONAL — if
// none are supplied we create an empty profile (you'll need to attach a
// payment method via NMI's hosted tokenizer before any charge succeeds).
//
// Note: NMI's Customer Vault operations use the `customer_vault` request
// parameter, NOT `type`. (`type=add_customer` returns "Invalid Transaction
// Type" because `type` is reserved for sale/auth/capture/refund/void/credit.)
//
// paymentDetails accepts EITHER:
//   { paymentToken }                              ← Collect.js / hosted form
//   { cardNumber, cardExpiry: 'MMYY', cardCvv? } ← raw PAN (PCI-scope!)
//   { achRouting, achAccount, achAccountType }   ← echeck
export async function createCustomerVault({ profile, paymentDetails }) {
  const params = {
    customer_vault: 'add_customer',
    first_name: profile.firstName,
    last_name: profile.lastName,
    company: profile.companyName,
    phone: profile.phone,
  }
  if (profile.billingAddress) {
    Object.assign(params, {
      address1: profile.billingAddress.line1,
      address2: profile.billingAddress.line2,
      city: profile.billingAddress.city,
      state: profile.billingAddress.state,
      zip: profile.billingAddress.zip,
      country: profile.billingAddress.country,
    })
  }
  if (profile.shippingAddress) {
    Object.assign(params, {
      shipping_address1: profile.shippingAddress.line1,
      shipping_address2: profile.shippingAddress.line2,
      shipping_city: profile.shippingAddress.city,
      shipping_state: profile.shippingAddress.state,
      shipping_zip: profile.shippingAddress.zip,
      shipping_country: profile.shippingAddress.country,
    })
  }

  if (paymentDetails?.paymentToken) {
    params.payment_token = paymentDetails.paymentToken
  } else if (paymentDetails?.cardNumber) {
    params.ccnumber = paymentDetails.cardNumber
    params.ccexp = paymentDetails.cardExpiry
    if (paymentDetails.cardCvv) params.cvv = paymentDetails.cardCvv
  } else if (paymentDetails?.achAccount) {
    params.payment = 'check'
    params.checkname = paymentDetails.checkName || `${profile.firstName || ''} ${profile.lastName || ''}`.trim()
    params.checkaba = paymentDetails.achRouting
    params.checkaccount = paymentDetails.achAccount
    params.account_type = paymentDetails.achAccountType || 'checking'
  }

  log.info('vault.create.request', { email: profile.email, hasPayment: Boolean(paymentDetails) })
  const res = await nmiTransact(params, { sensitiveKeys: NMI_SENSITIVE_PARAMS })
  if (res.response !== '1' || !res.customer_vault_id) {
    const err = new Error(`NMI add_customer failed: ${res.responsetext || 'unknown'}`)
    err.permanent = true
    err.nmiResponse = res
    throw err
  }
  log.info('vault.create.success', { customerVaultId: res.customer_vault_id })
  return res.customer_vault_id
}

export async function findOrCreateCustomerVault({ profile, paymentDetails }) {
  console.log(`\n[customers] NMI vault lookup for ${profile.email}`)
  const existing = await findCustomerVaultByEmail(profile.email)
  if (existing) {
    console.log(`[customers] NMI vault match found — id=${existing}`)
    log.info('vault.found.existing', { customerVaultId: existing, email: profile.email })
    return { customerVaultId: existing, created: false }
  }
  console.log(`[customers] NMI vault no match — creating new${paymentDetails ? ' (with payment method)' : ' (without payment method)'}`)
  const customerVaultId = await createCustomerVault({ profile, paymentDetails })
  console.log(`[customers] NMI vault created — id=${customerVaultId}`)
  return { customerVaultId, created: true }
}

// ── Sale / refund / void ─────────────────────────────────────────────

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
  const result = classifyNmiResponse(res)

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
  return classifyNmiResponse(res)
}

export async function voidTransaction({ transactionId }) {
  const res = await nmiTransact({ type: 'void', transactionid: transactionId })
  return classifyNmiResponse(res)
}
