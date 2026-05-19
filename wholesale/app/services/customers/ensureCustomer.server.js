import CustomerMap from '../../models/customerMap.server'
import { findOrCreateCustomer as findOrCreateQboCustomer } from '../qbo/customer.server'
import { findOrCreateCustomerVault } from '../nmi/customer.server'
import { resolvePaymentDetails } from './paymentDetailsResolver.server'
import { createLogger } from '../logger.server'

const log = createLogger('customers.ensure')

// Normalize a Shopify address (snake_case shape) to our internal shape.
// Returns null if the address has no usable street/zip data.
function normalizeAddress(addr) {
  if (!addr) return null
  const line1 = addr.address1 || addr.address_1 || ''
  const line2 = addr.address2 || addr.address_2 || ''
  const city = addr.city || ''
  const state = addr.province_code || addr.province || ''
  const zip = addr.zip || addr.postal_code || ''
  const country = addr.country_code || addr.country || ''
  if (!line1 && !zip && !city) return null
  return { line1, line2, city, state, zip, country }
}

// Project a Shopify order's customer/billing into a normalized profile
// shape that QBO and NMI both consume.
//
// Address resolution order (first non-empty wins):
//   1. order.billing_address
//   2. order.shipping_address
//   3. order.customer.default_address
//
// Shopify admin-created orders frequently omit billing_address, which is
// why we fall back to shipping and then default_address.
function buildProfileFromShopifyOrder(order) {
  const customer = order.customer || {}
  const customerDefault = customer.default_address || null

  const billing =
    normalizeAddress(order.billing_address) ||
    normalizeAddress(order.shipping_address) ||
    normalizeAddress(customerDefault)

  const shipping =
    normalizeAddress(order.shipping_address) ||
    normalizeAddress(order.billing_address) ||
    normalizeAddress(customerDefault)

  // Prefer the address that's actually being used for the name, since the
  // order's billing/shipping address has the buyer's exact-as-typed name.
  const billingRaw = order.billing_address || order.shipping_address || customerDefault || {}

  return {
    shopifyCustomerId: customer.id ? String(customer.id) : null,
    email: (order.email || customer.email || '').toLowerCase() || null,
    firstName: customer.first_name || billingRaw.first_name || '',
    lastName: customer.last_name || billingRaw.last_name || '',
    companyName: billingRaw.company || customerDefault?.company || '',
    phone: customer.phone || billingRaw.phone || order.phone || '',
    billingAddress: billing,
    shippingAddress: shipping,
  }
}

// Ensure the customer exists in QBO + NMI and persist the mapping.
// `paymentDetails` is forwarded to NMI only when a new vault entry has
// to be created (e.g. first-time customer with a captured token).
export async function ensureCustomerForOrder({ shop, order, paymentDetails }) {
  const profile = buildProfileFromShopifyOrder(order)
  console.log(`[customers] ensureCustomerForOrder(shop=${shop}, email=${profile.email})`)
  console.log(`[customers] resolved profile:`)
  console.log(`              name      : ${profile.firstName} ${profile.lastName}`)
  console.log(`              company   : ${profile.companyName || '(none)'}`)
  console.log(`              phone     : ${profile.phone || '(none)'}`)
  console.log(`              billing   : ${formatAddress(profile.billingAddress)}`)
  console.log(`              shipping  : ${formatAddress(profile.shippingAddress)}`)

  if (!profile.email) {
    const err = new Error(`Order ${order.id} has no email; cannot create customer in QBO/NMI`)
    console.error(`[customers] ABORT — ${err.message}`)
    throw err
  }

  // NMI rejects add_customer when no billing address is present. Detect
  // up front with a precise message instead of letting NMI's generic
  // "Billing Information missing" surface 100ms later.
  const billingMissing = missingBillingFields(profile.billingAddress)
  if (billingMissing.length > 0) {
    const err = new Error(
      `Order ${order.id}: cannot build NMI customer — billing address missing fields: ${billingMissing.join(', ')}. ` +
        `Checked order.billing_address, order.shipping_address, customer.default_address.`,
    )
    console.error(`[customers] ABORT — ${err.message}`)
    throw err
  }

  // Atomic find-or-create on the local mapping. We re-fetch after the
  // upsert so we can read whatever the previous run wrote.
  console.log(`[customers] upserting customer_maps row for ${shop} / ${profile.email}`)
  let mapping = await CustomerMap.findOneAndUpdate(
    { shop, email: profile.email },
    {
      $setOnInsert: { shop, email: profile.email },
      $set: {
        shopifyCustomerId: profile.shopifyCustomerId || undefined,
        profile: {
          firstName: profile.firstName,
          lastName: profile.lastName,
          companyName: profile.companyName,
          phone: profile.phone,
          billingAddress: profile.billingAddress,
          shippingAddress: profile.shippingAddress,
        },
      },
    },
    { upsert: true, new: true },
  )
  console.log(
    `[customers] customer_maps _id=${mapping._id} qbo=${mapping.qboCustomerId || '(none)'} nmi=${mapping.nmiCustomerVaultId || '(none)'}`,
  )
  log.info('mapping.upserted', {
    shop,
    email: profile.email,
    mappingId: mapping._id.toString(),
    hasQbo: Boolean(mapping.qboCustomerId),
    hasNmi: Boolean(mapping.nmiCustomerVaultId),
  })

  // QBO side
  if (!mapping.qboCustomerId) {
    const { customer } = await findOrCreateQboCustomer(profile)
    mapping.qboCustomerId = customer.Id
    log.info('qbo.linked', { email: profile.email, qboCustomerId: customer.Id })
  } else {
    console.log(`[customers] QBO link already set on customer_maps: Id=${mapping.qboCustomerId}`)
  }

  // NMI side
  if (!mapping.nmiCustomerVaultId) {
    // Resolver picks payment details — currently the static dev test card
    // when in sandbox, future: wholesale_applications lookup. An explicit
    // paymentDetails arg from the caller still wins.
    const effectivePaymentDetails =
      paymentDetails ||
      (await resolvePaymentDetails({
        shop,
        email: profile.email,
        shopifyCustomerId: profile.shopifyCustomerId,
      }))
    if (effectivePaymentDetails) {
      console.log(
        `[customers] using payment details from "${effectivePaymentDetails._source || 'caller'}" for NMI vault create`,
      )
    }
    const { customerVaultId } = await findOrCreateCustomerVault({
      profile,
      paymentDetails: effectivePaymentDetails,
    })
    mapping.nmiCustomerVaultId = customerVaultId
    log.info('nmi.linked', { email: profile.email, customerVaultId })
  } else {
    console.log(`[customers] NMI vault link already set on customer_maps: ${mapping.nmiCustomerVaultId}`)
  }

  mapping.lastSyncedAt = new Date()
  await mapping.save()
  console.log(`[customers] customer_maps saved _id=${mapping._id}`)
  return mapping
}

function formatAddress(addr) {
  if (!addr) return '(none — no address found on order or customer)'
  const parts = [addr.line1, addr.line2, addr.city, addr.state, addr.zip, addr.country].filter(Boolean)
  return parts.length ? parts.join(', ') : '(empty)'
}

// NMI add_customer requires line1, city, state, zip, country. Without any
// of those it returns "Billing Information missing". Phone/email aren't
// part of the billing-address check on NMI's side.
function missingBillingFields(addr) {
  if (!addr) return ['address1', 'city', 'state', 'zip', 'country']
  const missing = []
  if (!addr.line1) missing.push('address1')
  if (!addr.city) missing.push('city')
  if (!addr.state) missing.push('state')
  if (!addr.zip) missing.push('zip')
  if (!addr.country) missing.push('country')
  return missing
}
