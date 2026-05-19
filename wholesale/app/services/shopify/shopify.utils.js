// Shopify-specific pure helpers. No GraphQL, no I/O — those live in
// shopify.queries.js / shopify.mutations.js / shopify.service.js.

import {
  SAME_AS_BILLING,
  PROPERTY_TYPE_KEY,
  CREDENTIAL_MAP,
  REFERRAL_MAP,
} from './shopify.constants'

// US 10-digit phone (what our schema stores) → E.164 (+1XXXXXXXXXX) for Shopify.
export function toE164US(phone) {
  if (!phone) return null
  const digits = String(phone).replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length > 0) return `+${digits}`
  return null
}

// Map our internal address shape to Shopify's customer-address input shape.
export function mapAddress(a) {
  if (!a) return null
  return {
    address1: a.line1 || '',
    address2: a.line2 || '',
    city: a.city || '',
    province: a.state || '',
    zip: a.zip || '',
    country: a.country || '',
  }
}

// Build a Shopify order GraphQL id (gid://) from either a numeric id or
// an already-formatted gid. Idempotent.
export function toOrderGid(orderId) {
  return String(orderId).startsWith('gid://')
    ? String(orderId)
    : `gid://shopify/Order/${orderId}`
}

function pyBool(v) {
  return v ? 'True' : 'False'
}

// Composes the customer's note in the exact "Key: Value\n" format the spec
// requires. Booleans render as "True" / "False" (Python casing). URLs render
// as-is. License lines only appear when a file URL is present for that
// credential. No JSON, no blank lines, no trailing newline.
export function buildShopifyNote(application = {}) {
  const lines = []

  const sameAsBilling = application.shippingSameAsBilling === true
  lines.push(`${SAME_AS_BILLING.true}: ${pyBool(sameAsBilling)}`)
  lines.push(`${SAME_AS_BILLING.false}: ${pyBool(!sameAsBilling)}`)

  const propertyType = sameAsBilling
    ? null
    : application.shippingAddress?.type || application.shippingPropertyType
  lines.push(`${PROPERTY_TYPE_KEY}: ${propertyType || ''}`)

  const creds = application.credentials || {}
  // Credential booleans first
  for (const c of CREDENTIAL_MAP) {
    const selected = creds[c.id]?.selected === true
    lines.push(`${c.credKey}: ${pyBool(selected)}`)
  }
  // Then license URLs for credentials that have one stored
  for (const c of CREDENTIAL_MAP) {
    if (!c.fileKey) continue
    const fileVal = creds[c.id]?.[`file${c.fileIndex}`]
    if (typeof fileVal === 'string' && fileVal.startsWith('http')) {
      lines.push(`${c.fileKey}: ${fileVal}`)
    }
  }

  const refs = application.referrals || {}
  for (const r of REFERRAL_MAP) {
    const selected = refs[r.id]?.selected === true
    lines.push(`${r.key}: ${pyBool(selected)}`)
  }

  return lines.join('\n')
}
