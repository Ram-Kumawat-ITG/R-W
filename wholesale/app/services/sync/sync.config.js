import { readEnv, readInt, readBool } from '../../utils/env.utils'

export const syncConfig = {
  retailShop: readEnv('RETAIL_SHOP_DOMAIN', { fallback: '' }),
  // THIS app's own (wholesale) shop domain. Webhook/admin flows always carry the
  // shop, so this is only needed by background sweeps that have no request
  // context (see retailPriceReconcile.service.resolveWholesaleShop, which falls
  // back to the shop recorded on existing sync/order data when it's unset).
  wholesaleShop: readEnv('SHOPIFY_SHOP', { fallback: '' }),
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

  // ── Retail-price reconcile CRON ────────────────────────────────────────
  // Shopify fires NO webhook when only a VARIANT metafield changes, so an edit
  // to `custom.retail_price` alone never reaches the retail store through the
  // products/update path. This sweep is what makes that edit sync — see
  // services/sync/retailPriceReconcile.service.js.
  // DEFAULT OFF as of 2026-08-03 — per the project owner, retail prices are to
  // be pushed MANUALLY from the Product sync admin page (or the CLI), not on a
  // timer. With this off, scheduler.service cancels the Agenda job outright
  // (not merely skipping ticks), so nothing runs in the background.
  //
  // The manual paths are INDEPENDENT of this flag and always work:
  //   • /app/product-sync → "Sync prices now" / "Check for changes"
  //   • npm run reconcile:retail-prices [-- --dry-run]
  // Set RETAIL_PRICE_RECONCILE_ENABLED=true to bring the timer back.
  //
  //   RETAIL_PRICE_RECONCILE_ENABLED  — kill switch (default OFF)
  //   RETAIL_PRICE_RECONCILE_CRON     — schedule used only when re-enabled
  //   RETAIL_PRICE_RECONCILE_INTERVAL — dev/test override, e.g. "1 minute"
  //     (an Agenda interval string; when set it REPLACES the cron)
  retailPriceReconcileEnabled: readBool('RETAIL_PRICE_RECONCILE_ENABLED', false),
  retailPriceReconcileCron: readEnv('RETAIL_PRICE_RECONCILE_CRON', {
    fallback: '*/10 * * * *',
  }),
  retailPriceReconcileInterval: readEnv('RETAIL_PRICE_RECONCILE_INTERVAL', {
    fallback: '',
  }),
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
