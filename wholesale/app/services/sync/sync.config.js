import { readEnv } from '../../utils/env.utils'

export const syncConfig = {
  retailShop: readEnv('RETAIL_SHOP_DOMAIN', { fallback: '' }),
  retailAccessToken: readEnv('RETAIL_ADMIN_ACCESS_TOKEN', { fallback: '' }),
  retailLocationId: readEnv('RETAIL_LOCATION_ID', { fallback: '' }),
  syncSecret: readEnv('RETAIL_SYNC_SECRET', { fallback: '' }),
  apiVersion: '2026-07',
}

export function isSyncEnabled() {
  return Boolean(syncConfig.retailShop && syncConfig.retailAccessToken)
}
