import { readEnv, readInt } from '../../utils/env.utils'

export const syncConfig = {
  retailShop: readEnv('RETAIL_SHOP_DOMAIN', { fallback: '' }),
  retailAccessToken: readEnv('RETAIL_ADMIN_ACCESS_TOKEN', { fallback: '' }),
  retailLocationId: readEnv('RETAIL_LOCATION_ID', { fallback: '' }),
  syncSecret: readEnv('RETAIL_SYNC_SECRET', { fallback: '' }),
  // Base URL of the ns-retail APP (not the retail Shopify store) — where this
  // app POSTs drop-ship fulfillment / cancellation status so ns-retail can
  // mirror it onto the linked retail Shopify order. This is the mirror image
  // of ns-retail's WHOLESALE_API_BASE (which points back at this app).
  nsRetailApiBase: readEnv('NS_RETAIL_API_BASE', { fallback: '' }),
  // Timeout (ms) for that outbound POST so a hung / slow tunnel can never stall
  // a fulfillment webhook or an Order-Details page load.
  fulfillmentSyncTimeoutMs: readInt('NS_RETAIL_SYNC_TIMEOUT_MS', 10000),
  apiVersion: '2026-07',
}

export function isSyncEnabled() {
  return Boolean(syncConfig.retailShop && syncConfig.retailAccessToken)
}

// Outbound fulfillment-status mirror (Wholesale → ns-retail) is enabled when
// we know the ns-retail app URL and share the sync secret with it. Distinct
// from isSyncEnabled() (inventory sync, which talks to the retail Shopify
// store directly via RETAIL_ADMIN_ACCESS_TOKEN).
export function isFulfillmentSyncEnabled() {
  return Boolean(syncConfig.nsRetailApiBase && syncConfig.syncSecret)
}
