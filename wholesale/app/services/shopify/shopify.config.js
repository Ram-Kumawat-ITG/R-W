// Shopify-specific configuration.
// Most Shopify env vars (SHOPIFY_API_KEY/SECRET/SCOPES) are managed by
// the Shopify CLI and consumed directly by @shopify/shopify-app-react-router.
// This file only holds the values OUR code reads directly.

import { readEnv } from '../../utils/env.utils'

const appUrl = readEnv('SHOPIFY_APP_URL', { fallback: '' })

export const shopifyConfig = {
  appUrl,
  // Base URL used to build the customer-facing Immediate-Payment link that
  // is BAKED into the QBO invoice (/pay/<token>). It must be a STABLE,
  // publicly-reachable URL because the invoice keeps the link for days.
  //
  // In production this is the app's fixed domain — leaving PAY_LINK_BASE_URL
  // unset falls back to SHOPIFY_APP_URL, which is stable there. In DEV,
  // `shopify app dev` rotates the trycloudflare tunnel on every restart, so
  // SHOPIFY_APP_URL changes and previously-issued links die. Set
  // PAY_LINK_BASE_URL to a stable tunnel/domain (e.g. an ngrok static domain)
  // so issued links keep working across restarts.
  payLinkBaseUrl: readEnv('PAY_LINK_BASE_URL', { fallback: appUrl }),
  // Used to build the registration form's storefront-proxy URL.
  appProxy: readEnv('SHOPIFY_APP_PROXY', { fallback: 'wholesale-application' }),
}
