/* eslint-env node */
// Repair sweep for QBO Inventory items whose InvStartDate is too late.
//
// QBO refuses any transaction dated BEFORE an inventory item's start date:
//   "Transaction date is prior to start date for inventory item"
// Items created before the 2026-07-31 fix got InvStartDate = TODAY (computed in
// UTC), which lands AFTER the invoice date whenever
//   - QBO stamps the invoice in a company timezone still on the previous day
//     (a US company is behind UTC for the first hours of every UTC day), or
//   - the order is invoiced with an earlier date (replay / back-dated order).
// Every such order failed to invoice with the error above.
//
// The invoice path now self-heals (it back-dates the offending items and retries
// once), and newly-created items are back-dated up front. This script does the
// same repair PROACTIVELY across the whole catalog so no order has to fail first.
//
// Idempotent — an item whose start date is already early enough is skipped.
//
// Usage (from wholesale/):
//   npm run fix:qbo-inventory-dates -- --dry-run   # report only, no writes
//   npm run fix:qbo-inventory-dates                # apply
//   npm run fix:qbo-inventory-dates -- --start-date=2025-01-01

import {
  inventoryStartYmd,
  backdateItemInventoryStart,
  listQboItems,
} from '../app/services/qbo/qbo.service.js'

const dryRun = process.argv.includes('--dry-run')
const startArg = process.argv.find((a) => a.startsWith('--start-date='))
const target = (startArg ? startArg.split('=')[1] : inventoryStartYmd()).slice(0, 10)

if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) {
  console.error(`[fix:qbo-inventory-dates] invalid target date "${target}" (want YYYY-MM-DD)`)
  process.exit(1)
}

async function main() {
  console.log(
    `[fix:qbo-inventory-dates] target InvStartDate = ${target}` + (dryRun ? ' (dry run)' : ''),
  )

  const items = await listQboItems({ type: 'Inventory' })
  console.log(`[fix:qbo-inventory-dates] ${items.length} Inventory item(s) in the QBO company`)

  const late = items.filter((it) => {
    const current = it.InvStartDate ? String(it.InvStartDate).slice(0, 10) : null
    return !current || current > target
  })
  console.log(`[fix:qbo-inventory-dates] ${late.length} need back-dating`)

  let fixed = 0
  let skipped = 0
  let failed = 0
  for (const it of late) {
    const label = `item ${it.Id} "${it.Name}" (SKU ${it.Sku || '—'}) InvStartDate=${it.InvStartDate || '(none)'}`
    if (dryRun) {
      console.log(`  would back-date ${label} → ${target}`)
      continue
    }
    try {
      const result = await backdateItemInventoryStart({ itemId: it.Id, startDate: target })
      if (result.changed) {
        fixed += 1
        console.log(`  ✓ ${label} → ${target}`)
      } else {
        skipped += 1
        console.log(`  · skipped ${label} (${result.reason})`)
      }
    } catch (err) {
      failed += 1
      console.error(`  ✗ ${label}: ${err?.message || err}`)
    }
  }

  if (dryRun) {
    console.log('[fix:qbo-inventory-dates] --dry-run — no changes made.')
  } else {
    console.log(
      `[fix:qbo-inventory-dates] done — fixed=${fixed} skipped=${skipped} failed=${failed}`,
    )
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('[fix:qbo-inventory-dates] fatal:', err)
  process.exit(1)
})
