// QuickBooks Online configuration.
// Reads QBO_* env vars and validates `QBO_ENVIRONMENT` against the known
// hosts. Use `assertQboConfigured()` at call sites that need credentials
// to fail fast with a clear error instead of letting Intuit reject the
// request with a generic 401.

import { readEnv } from '../../utils/env.utils'
import { QBO_BASE_URLS, QBO_OAUTH_TOKEN_URL } from './qbo.constants'

const qboEnvironment = readEnv('QBO_ENVIRONMENT', { fallback: 'sandbox' })
if (!QBO_BASE_URLS[qboEnvironment]) {
  throw new Error(`QBO_ENVIRONMENT must be 'sandbox' or 'production', got: ${qboEnvironment}`)
}

export const qboConfig = {
  clientId: readEnv('QBO_CLIENT_ID'),
  clientSecret: readEnv('QBO_CLIENT_SECRET'),
  realmId: readEnv('QBO_REALM_ID'),
  // Seed refresh token from env on first run. After that, Mongo is the
  // source of truth — see qboToken.server model.
  bootstrapRefreshToken: readEnv('QBO_REFRESH_TOKEN'),
  environment: qboEnvironment,
  apiBaseUrl: readEnv('QBO_API_BASE_URL', { fallback: QBO_BASE_URLS[qboEnvironment] }),
  oauthTokenUrl: readEnv('QBO_OAUTH_TOKEN_URL', { fallback: QBO_OAUTH_TOKEN_URL }),
  minorVersion: readEnv('QBO_MINOR_VERSION', { fallback: '73' }),
  defaultItemId: readEnv('QBO_DEFAULT_ITEM_ID', { fallback: '1' }),
  // Income account for auto-created per-product Items (SKU column support).
  // Optional — normally we derive the income account from the default item
  // (QBO_DEFAULT_ITEM_ID); this is only the fallback when that item exposes
  // no IncomeAccountRef. See qbo.service.findOrCreateItemBySku.
  incomeAccountId: readEnv('QBO_INCOME_ACCOUNT_ID', { fallback: null }),
}

export function assertQboConfigured() {
  const missing = ['clientId', 'clientSecret', 'realmId', 'bootstrapRefreshToken']
    .filter((k) => !qboConfig[k])
  if (missing.length) {
    throw new Error(`QBO not configured. Missing: ${missing.map((k) => `QBO_${k}`).join(', ')}`)
  }
}
