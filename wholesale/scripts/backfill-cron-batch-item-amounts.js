/* eslint-env node */
// One-off backfill for the CronBatchRunItem "Invoice amount = $0.00 on
// approved charges" bug (fixed in processPendingPayments.job.js — it was
// recording the POST-charge outstanding balance, which is $0 for any
// fully-approved charge, instead of the amount that was actually
// attempted/charged).
//
// This corrects already-persisted rows: for every `outcome: 'approved'`
// CronBatchRunItem with a zero/missing `invoiceAmount`, look up the
// linked Invoice by `qboInvoiceId` and backfill from its CURRENT
// `amountDue`. This is an approximation — it assumes the invoice was
// fully settled by that single charge (true for the common case, but
// would under/over-count an invoice charged across multiple partial
// batches). Logged per-row so any suspicious backfill is easy to spot.
//
// Usage:
//   npm run backfill:cron-batch-amounts                # apply
//   npm run backfill:cron-batch-amounts -- --dry-run    # preview only

import connectDB from '../app/services/APIService/mongo.service.js'
import CronBatchRunItem from '../app/models/cronBatchRunItem.server.js'
import Invoice from '../app/models/invoice.server.js'

const dryRun = process.argv.includes('--dry-run')

async function main() {
  await connectDB()

  const candidates = await CronBatchRunItem.find({
    outcome: 'approved',
    $or: [{ invoiceAmount: 0 }, { invoiceAmount: null }, { invoiceAmount: { $exists: false } }],
  }).lean()

  console.log(`[backfill:cron-batch-amounts] found ${candidates.length} zero-amount approved item(s)`)

  let fixed = 0
  let skipped = 0
  for (const item of candidates) {
    const invoice = item.qboInvoiceId
      ? await Invoice.findOne({ qboInvoiceId: item.qboInvoiceId }).select('amountDue').lean()
      : null
    if (!invoice || !(invoice.amountDue > 0)) {
      skipped += 1
      console.log(`  ✗ skip item=${item._id} qboInvoiceId=${item.qboInvoiceId} — no invoice/amountDue found`)
      continue
    }
    console.log(
      `  ${dryRun ? 'would set' : '✓ set'} item=${item._id} order=${item.orderLabel || item.shopifyOrderId} ` +
        `invoiceAmount 0 -> ${invoice.amountDue}`,
    )
    if (!dryRun) {
      await CronBatchRunItem.updateOne({ _id: item._id }, { $set: { invoiceAmount: invoice.amountDue } })
    }
    fixed += 1
  }

  console.log(
    `[backfill:cron-batch-amounts] done — ${fixed} ${dryRun ? 'would be fixed' : 'fixed'}, ${skipped} skipped ` +
      `(of ${candidates.length})`,
  )
  process.exit(0)
}

main().catch((err) => {
  console.error('[backfill:cron-batch-amounts] FAILED:', err?.message || err)
  process.exit(1)
})
