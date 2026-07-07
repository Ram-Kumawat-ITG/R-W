// Storefront-side fetch helpers for the Practitioner Code cart block.
//
// Mirrors ns-retail/signup-form/src/services/ApiService.js — all routes
// hit our app via Shopify's app proxy at /apps/<subpath>/api/*. Same-
// origin from the storefront so there is no CORS surface; Shopify signs
// the request with HMAC so the backend can trust the shop identity.
//
// PROXY_BASE must MATCH the subpath in ns-retail/shopify.app.toml
// ([app_proxy] subpath = "retail-signup"). If it doesn't match, Shopify
// routes to a different app OR returns 404, and every call silently
// fails. Read from VITE_RETAIL_PROXY_SUBPATH in ns-retail/.env so this
// can't drift out of sync with the toml.
const PROXY_BASE =
  import.meta.env.VITE_RETAIL_PROXY_SUBPATH || 'retail-signup'

const API = {
  // Validate a practitioner code. Returns { valid, code, practitionerName,
  // discountPercent, reason?, message? }.
  validateCode: `/apps/${PROXY_BASE}/api/cdo/checkout-validate-code`,

  // Tag the logged-in customer with `code:<code>` so Shopify's tag-based
  // automatic-discount rule auto-applies the discount at checkout.
  // Returns { ok, tagged, ... }.
  applyCode: `/apps/${PROXY_BASE}/api/cdo/checkout-apply-code`,

  // Look up a logged-in customer's saved `code:*` tag via Shopify Admin
  // GraphQL. The cart-page block calls this on mount so a returning
  // patient of an existing practitioner gets their discount auto-applied
  // WITHOUT re-typing the code. Returns { found, code, practitionerName,
  // discountPercent }.
  findByCustomerId: `/apps/${PROXY_BASE}/api/cdo/checkout-find-by-customer-id`,
}

async function jsonPost(url, body) {
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body || {}),
    })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[ApiService] network error for ${url}:`, err)
    throw new Error('Network error. Please check your connection and try again.')
  }

  let data
  try {
    data = await response.json()
  } catch {
    data = {}
  }

  if (!response.ok || data.status === 'error') {
    const err = new Error(data.message || `Request failed (${response.status})`)
    err.responseData = data
    err.status = response.status
    throw err
  }
  return data
}

export default class ApiService {
  // Validate a practitioner code against cdo_practitioner_codes. Optional
  // identity (email + Shopify customer GID) is used by the backend to
  // enforce the patient↔practitioner binding (a patient can only use
  // codes from their bound practitioner).
  static async verifyCode(code, identity = {}) {
    const data = await jsonPost(API.validateCode, {
      code,
      email: identity.email || undefined,
      customerId: identity.customerId || undefined,
    })
    return data.result || { valid: false }
  }

  // Tag the customer with `code:<code>` so the discount auto-applies at
  // checkout. Fire-and-forget from the caller's POV — the cart attribute
  // is already saved by the time we get here, so a tagging failure is
  // non-fatal (backend order webhook can reconcile later).
  static async applyAndTagCode(code, identity = {}, shop = '') {
    try {
      const data = await jsonPost(API.applyCode, {
        code,
        email: identity.email || undefined,
        customerId: identity.customerId || undefined,
        shopifyCustomerId: identity.shopifyCustomerId || undefined,
        shopifyShop: shop || undefined,
      })
      return data.result || { ok: false, tagged: false }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[ApiService.applyAndTagCode] failed:', err?.message)
      return { ok: false, tagged: false }
    }
  }

  // Look up the logged-in customer's saved practitioner code (via their
  // `code:*` Shopify tag). Used on cart-page mount so returning patients
  // get their discount auto-applied. Fire-and-forget — a lookup failure
  // just leaves the customer to type the code manually.
  //
  // Returns { found, code, practitionerName, discountPercent } — or
  // { found: false } on miss / error.
  static async findByCustomerId(customerId, shop) {
    try {
      const data = await jsonPost(API.findByCustomerId, {
        customerId,
        shop: shop || undefined,
      })
      return data.result || { found: false }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[ApiService.findByCustomerId] failed:', err?.message)
      return { found: false }
    }
  }
}
