// Customer service — ensure a Shopify customer is mapped to a QBO
// customer and an NMI customer vault. The cross-system mapping lives in
// customer_maps (one row per (shop, email)).

import CustomerMap from '../../models/customerMap.server'
import WholesaleApplication from '../../models/wholesaleApplication.server'
import { findOrCreateCustomer as findOrCreateQboCustomer } from '../qbo/qbo.service'
import { findOrCreateCustomerVault } from '../nmi/nmi.service'
import { resolvePaymentDetails } from './paymentDetails.service'
import {
  buildProfileFromShopifyOrder,
  missingBillingFields,
  formatAddress,
} from './customer.utils'
import { createLogger } from '../../utils/logger.utils'

// Map a wholesale-application payment.method to the invoice/customerMap
// enum. Tolerates either spelling of the cheque option ('check' or
// 'cheque'), case insensitive, since both surface in real data — the
// registration form uses id 'check' but some application records carry
// 'cheque'. Canonical storage value is 'check'.
//
// Unknown / missing values default to 'card' so existing customers
// without a captured preference keep the legacy CRON-auto-charge
// behavior.
function normalizePaymentMethod(raw) {
  const v = String(raw || '').trim().toLowerCase()
  if (v === 'check' || v === 'cheque') return 'check'
  if (v === 'ach' || v === 'bank' || v === 'bank-transfer') return 'ach'
  if (v === 'card' || v === 'credit-card' || v === 'creditcard' || v === 'cc') return 'card'
  return 'card'
}

const log = createLogger('customer.service')

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

  // Payment-method preference — sourced once from the customer's
  // wholesale application. Persisted on the mapping so future invoices
  // can pick it up without re-querying. We only populate if currently
  // unset; the manual cheque→card fallback (per-invoice override) does
  // NOT alter this preference.
  if (!mapping.paymentMethod) {
    const app = await WholesaleApplication.findOne({ shop, email: profile.email })
      .select('payment.method')
      .lean()
    const resolved = normalizePaymentMethod(app?.payment?.method)
    mapping.paymentMethod = resolved
    console.log(
      `[customers] payment-method preference resolved → "${resolved}"` +
        (app?.payment?.method ? ` (from wholesale_applications.payment.method="${app.payment.method}")` : ` (default; no application on file)`),
    )
    log.info('payment_method.resolved', {
      email: profile.email,
      paymentMethod: resolved,
      sourcedFromApp: Boolean(app?.payment?.method),
    })
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
