// Shopify-specific configuration.
// Most Shopify env vars (SHOPIFY_API_KEY/SECRET/SCOPES) are managed by
// the Shopify CLI and consumed directly by @shopify/shopify-app-react-router.
// This file only holds the values OUR code reads directly.

import { readEnv } from '../../utils/env.utils'

export const shopifyConfig = {
  appUrl: readEnv('SHOPIFY_APP_URL', { fallback: '' }),
  // Used to build the registration form's storefront-proxy URL.
  appProxy: readEnv('SHOPIFY_APP_PROXY', { fallback: 'wholesale-application' }),
}
