/* eslint-env node */
// Push wholesale variant "Retail price" metafields to the retail store NOW,
// instead of waiting for the reconcile-retail-prices CRON tick.
//
// Why this is needed at all: Shopify does NOT send a webhook when only a
// VARIANT metafield changes, so editing `custom.retail_price` on a wholesale
// variant never triggers products/update and the webhook-driven sync never
// learns about it. The reconcile sweep (services/sync/retailPriceReconcile
// .service.js) is the actual sync path for that edit; this script runs one
// sweep on demand — handy for verifying a price change immediately.
//
// Only variants whose desired retail price differs from the last-known one are
// written, and only their `price` / `compare_at_price` — no other product or
// variant field is touched. Idempotent: a second run right after is a no-op.
//
// Usage (from wholesale/):
//   npm run reconcile:retail-prices -- --dry-run              # report drift only
//   npm run reconcile:retail-prices                           # apply
//   npm run reconcile:retail-prices -- --product=1234567890   # one product (repeatable)
//
// NOTE: needs the REAL database + a stored Shopify session for the wholesale
// shop (it reads the metafields through the Admin API). Point MONGODB_URI at the
// deployed cluster, or run it from the Render shell.

import connectDB from '../app/services/APIService/mongo.service.js'
import {
  reconcileRetailPrices,
  resolveWholesaleShop,
} from '../app/services/sync/retailPriceReconcile.service.js'

const dryRun = process.argv.includes('--dry-run')
const productIds = process.argv
  .filter((a) => a.startsWith('--product='))
  .map((a) => a.split('=')[1])
  .filter(Boolean)

async function main() {
  await connectDB()

  const shop = await resolveWholesaleShop(null)
  console.log(
    `[reconcile:retail-prices] wholesale shop = ${shop || '(unresolved)'}` +
      (productIds.length ? ` · products: ${productIds.join(', ')}` : '') +
      (dryRun ? ' · dry run' : ''),
  )

  const summary = await reconcileRetailPrices({
    dryRun,
    productIds: productIds.length ? productIds : null,
  })

  if (summary.skipped) {
    console.error(`[reconcile:retail-prices] SKIPPED — ${summary.reason}`)
    if (summary.error) console.error(`  ${summary.error}`)
    process.exit(1)
  }

  console.log(
    `[reconcile:retail-prices] products scanned=${summary.productsScanned} ` +
      `withDrift=${summary.productsWithDrift} | variants checked=${summary.variantsChecked} ` +
      `drifted=${summary.variantsDrifted} updated=${summary.variantsUpdated} ` +
      `skipped=${summary.variantsSkipped} errors=${summary.errors}`,
  )
  if (dryRun) {
    console.log('[reconcile:retail-prices] --dry-run — nothing written. See the drift lines above.')
  }
  process.exit(summary.errors > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('[reconcile:retail-prices] fatal:', err)
  process.exit(1)
})
