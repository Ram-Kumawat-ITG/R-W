// Customer-domain pure helpers. No I/O — those live in customer.service.js.
//
// Most of these exist to bridge Shopify's snake_case address shape into
// our internal camelCase profile shape that QBO and NMI both consume.

// Normalize a Shopify address (snake_case shape) to our internal shape.
// Returns null if the address has no usable street/zip data.
export function normalizeAddress(addr) {
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
export function buildProfileFromShopifyOrder(order) {
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

// NMI add_customer requires line1, city, state, zip, country. Without any
// of those it returns "Billing Information missing". Phone/email aren't
// part of the billing-address check on NMI's side.
export function missingBillingFields(addr) {
  if (!addr) return ['address1', 'city', 'state', 'zip', 'country']
  const missing = []
  if (!addr.line1) missing.push('address1')
  if (!addr.city) missing.push('city')
  if (!addr.state) missing.push('state')
  if (!addr.zip) missing.push('zip')
  if (!addr.country) missing.push('country')
  return missing
}

// Render an address for log lines. Empty / undefined parts are dropped.
export function formatAddress(addr) {
  if (!addr) return '(none — no address found on order or customer)'
  const parts = [addr.line1, addr.line2, addr.city, addr.state, addr.zip, addr.country].filter(Boolean)
  return parts.length ? parts.join(', ') : '(empty)'
}
