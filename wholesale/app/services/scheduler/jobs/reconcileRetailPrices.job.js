// Retail-price reconciliation job.
//
// Exists because Shopify fires NO webhook when only a VARIANT metafield
// changes: editing `custom.retail_price` on a wholesale variant produces no
// `products/update`, so the webhook-driven sync never learns about it (see
// services/sync/retailPriceReconcile.service.js for the full explanation). This
// tick is what actually makes a Retail-price edit reach the retail store.
//
// It only ever writes `price` / `compare_at_price` on variants whose desired
// retail price differs from the last-known one, so it costs nothing when
// nothing changed and cannot disturb any other synced field. All logic lives in
// the service; this module is the thin Agenda wrapper.
//
// Cadence is environment-configurable: RETAIL_PRICE_RECONCILE_CRON (default
// every 10 minutes) or RETAIL_PRICE_RECONCILE_INTERVAL for a fast dev cadence.
// concurrency:1 so two ticks never push the same product concurrently.

import { reconcileRetailPrices } from '../../sync/retailPriceReconcile.service'
import { createLogger } from '../../../utils/logger.utils'

export const RECONCILE_RETAIL_PRICES_JOB = 'reconcile-retail-prices'
const log = createLogger('job.retail_price_reconcile')

export function registerReconcileRetailPricesJob(agenda) {
  agenda.define(
    RECONCILE_RETAIL_PRICES_JOB,
    { concurrency: 1, lockLifetime: 10 * 60 * 1000 },
    async (job) => {
      const tick = job.attrs.data?.tick || 'manual'
      const tickId = String(job.attrs._id).slice(-6)

      log.info('tick.start', { tick, tickId })
      try {
        const summary = await reconcileRetailPrices({})
        if (summary.skipped) {
          log.info('tick.skipped', { tickId, reason: summary.reason })
          return
        }
        // Only announce on the console when something actually moved — this
        // runs every few minutes and a no-op tick is the normal case.
        if (summary.variantsUpdated > 0 || summary.errors > 0) {
          console.log(
            `[retail-price-reconcile #${tickId}] products=${summary.productsScanned} ` +
              `drifted=${summary.variantsDrifted} updated=${summary.variantsUpdated} ` +
              `errors=${summary.errors}`,
          )
        }
        log.info('tick.done', { tickId, ...summary })
      } catch (err) {
        // Per-product failures are isolated inside the service; reaching here
        // means the whole sweep failed (session/DB/GraphQL), so let Agenda
        // record the failure.
        console.error(`[retail-price-reconcile #${tickId}] FAILED:`, err?.stack || err)
        log.error('tick.failed', { tickId, err })
        throw err
      }
    },
  )
}
