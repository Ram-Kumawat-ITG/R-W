import { nmiTransact, nmiQuery } from './client.server'
import { createLogger } from '../logger.server'

const log = createLogger('nmi.customer')

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
    log.warn('lookup.failed', { email, err })
    return null
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
    email: profile.email,
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

  log.info('create.request', { email: profile.email, hasPayment: Boolean(paymentDetails) })
  const res = await nmiTransact(params, { sensitiveKeys: ['ccnumber', 'cvv', 'checkaba', 'checkaccount', 'payment_token'] })
  if (res.response !== '1' || !res.customer_vault_id) {
    const err = new Error(`NMI add_customer failed: ${res.responsetext || 'unknown'}`)
    err.permanent = true
    err.nmiResponse = res
    throw err
  }
  log.info('create.success', { customerVaultId: res.customer_vault_id })
  return res.customer_vault_id
}

export async function findOrCreateCustomerVault({ profile, paymentDetails }) {
  console.log(`\n[customers] NMI vault lookup for ${profile.email}`)
  const existing = await findCustomerVaultByEmail(profile.email)
  if (existing) {
    console.log(`[customers] NMI vault match found — id=${existing}`)
    log.info('found.existing', { customerVaultId: existing, email: profile.email })
    return { customerVaultId: existing, created: false }
  }
  console.log(`[customers] NMI vault no match — creating new${paymentDetails ? ' (with payment method)' : ' (without payment method)'}`)
  const customerVaultId = await createCustomerVault({ profile, paymentDetails })
  console.log(`[customers] NMI vault created — id=${customerVaultId}`)
  return { customerVaultId, created: true }
}
