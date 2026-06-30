// Shopify-specific configuration.
// Most Shopify env vars (SHOPIFY_API_KEY/SECRET/SCOPES) are managed by
// the Shopify CLI and consumed directly by @shopify/shopify-app-react-router.
// This file only holds the values OUR code reads directly.

import { readEnv } from '../../utils/env.utils'

const appUrl = readEnv('SHOPIFY_APP_URL', { fallback: '' })

export const shopifyConfig = {
  appUrl,
  // Used to build the registration form's storefront-proxy URL.
  appProxy: readEnv('SHOPIFY_APP_PROXY', { fallback: 'wholesale-application' }),
}
