/* eslint-env node */
// One-off / re-runnable sweep that reconciles every practitioner's PAYMENT
// order hold against live invoice state — used to backfill the feature at
// deploy (so practitioners who ALREADY have an outstanding failed invoice get
// held + their checkout-block metafield set) and to heal any drift.
//
// For each practitioner who either (a) currently has a failed non-dropship
// invoice, or (b) is currently flagged orderHold, it recomputes the correct
// hold and syncs both the `wholesale_applications.orderHold` flag and the
// Shopify customer metafield the checkout Function reads.
//
// Usage:
//   npm run reconcile:order-holds -- --dry-run   # preview (no writes)
//   npm run reconcile:order-holds                # apply
//
// (Runs via vite-node so the app's ESM + extensionless imports resolve.)

import connectDB from '../app/services/APIService/mongo.service.js'
import Invoice from '../app/models/invoice.server.js'
import WholesaleApplication from '../app/models/wholesaleApplication.server.js'
import {
  reconcilePractitionerOrderHold,
  hasOutstandingFailedInvoice,
} from '../app/services/order/orderHold.service.js'

const dryRun = process.argv.includes('--dry-run')

async function main() {
  await connectDB()

  // (a) practitioners with an outstanding failed, non-dropship invoice
  const failed = await Invoice.aggregate([
    { $match: { paymentStatus: 'failed', isDropship: { $ne: true } } },
    { $group: { _id: { shop: '$shop', email: '$customerEmail' } } },
  ])
  // (b) practitioners currently flagged held (to clear stale holds)
  const held = await WholesaleApplication.find({ orderHold: true }).select('shop email').lean()

  const pairs = new Map()
  for (const f of failed) {
    if (f._id?.email) pairs.set(`${f._id.shop}|${f._id.email}`, { shop: f._id.shop, email: f._id.email })
  }
  for (const h of held) {
    if (h.email) pairs.set(`${h.shop}|${h.email}`, { shop: h.shop, email: h.email })
  }

  console.log(`[reconcile:order-holds] ${dryRun ? 'DRY RUN' : 'APPLY'} — ${pairs.size} practitioner(s) to evaluate\n`)

  let toBlock = 0
  let toClear = 0
  let unchanged = 0
  let errors = 0

  for (const { shop, email } of pairs.values()) {
    const app = await WholesaleApplication.findOne({ shop, email }).select('orderHold customerId').lean()
    const currentlyHeld = Boolean(app?.orderHold)
    const shouldHold = await hasOutstandingFailedInvoice({ shop, email })
    const change = shouldHold === currentlyHeld ? 'unchanged' : shouldHold ? 'BLOCK' : 'CLEAR'
    const noCustomer = app && !app.customerId ? ' (no Shopify customerId — metafield skipped)' : ''
    console.log(`  ${email.padEnd(38)} held=${currentlyHeld} → shouldHold=${shouldHold}  [${change}]${noCustomer}`)

    if (change === 'BLOCK') toBlock += 1
    else if (change === 'CLEAR') toClear += 1
    else unchanged += 1

    if (!dryRun) {
      const res = await reconcilePractitionerOrderHold({ shop, email, force: true })
      if (res.error) errors += 1
    }
  }

  console.log(
    `\n[reconcile:order-holds] ${dryRun ? 'would' : 'did'} block ${toBlock}, clear ${toClear}; ${unchanged} unchanged` +
      (errors ? `, ${errors} error(s)` : ''),
  )
  process.exit(errors ? 1 : 0)
}

main().catch((err) => {
  console.error('[reconcile:order-holds] FAILED:', err?.message || err)
  process.exit(1)
})
