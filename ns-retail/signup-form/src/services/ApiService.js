// Storefront-side fetch helpers. All routes hit our app via Shopify's app
// proxy at /apps/<subpath>/api/*. The proxy is configured in
// ns-retail/shopify.app.toml ([app_proxy] subpath = "retail-signup").
const PROXY_BASE = 'retail-signup'

const API = {
  checkEmail: `/apps/${PROXY_BASE}/api/auth/check-email`,
  validateCode: `/apps/${PROXY_BASE}/api/cdo/validate-code`,
  submitSignup: `/apps/${PROXY_BASE}/api/signup-form`,
}

async function jsonPost(url, body) {
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
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
  // Check whether an email is already a retail Shopify customer.
  // Returns { exists: boolean }.
  static async checkEmail(email) {
    const data = await jsonPost(API.checkEmail, { email })
    return data.result || { exists: false }
  }

  // Validate a practitioner code against cdo_practitioner_codes.
  // Returns { valid: boolean, code?: string, practitionerName?: string }.
  static async verifyCode(code) {
    const data = await jsonPost(API.validateCode, { code })
    return data.result || { valid: false }
  }

  // Submit the full signup form. Backend creates the retail Shopify customer
  // (with code tag if practitionerCode is set) and returns { customerId }.
  static async submitSignup(payload) {
    const data = await jsonPost(API.submitSignup, payload)
    return data.result || {}
  }
}
