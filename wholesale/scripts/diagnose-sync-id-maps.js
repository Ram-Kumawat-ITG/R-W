/* eslint-env node */
// READ-ONLY diagnostic for the `sync_id_maps` collection — the wholesale↔retail
// id translation table that drop-ship order intake depends on.
//
// Diagnoses the reported failure: "place an order on retail and no matching
// wholesale order is created — ids not found / not mapped properly", which
// surfaces as `All N line items unmappable to wholesale variants` thrown from
// services/dropship/dropship.service.js -> buildDropshipLineItems().
//
// That throw means: for every line on the retail order, NO row exists matching
//   { entityType: 'productVariant', retailId: String(line.variant_id) }
//
// There are three distinct ways to get there, and this script tells them apart:
//
//   (A) ORPHANED  — rows exist but their retailId points at a retail variant
//                   that no longer exists (retail catalog was deleted and
//                   reimported, so ids changed). Detect with --verify.
//   (B) NEVER SYNCED — the retail product wasn't created BY this sync
//                   (imported directly via CSV/Matrixify/manual), so no row
//                   was ever written. The sync is one-way wholesale->retail.
//                   Detect with --scan-retail.
//   (C) SKU PAIRING — the sync ran but pairVariantsBySku() skipped the variant
//                   because the wholesale SKU was blank or had no retail
//                   match, so no variant row was written. Detect with
//                   --scan-retail (shows unmapped retail variants + their SKUs)
//                   and the missingWholesalePrice count in the summary.
//
// Writes NOTHING. Safe to run against production.
//
// Usage:
//   npm run diagnose:sync-maps
//       Summary: row counts by entityType, stuck __pending__ claims,
//       productVariant rows missing a wholesalePrice snapshot.
//
//   npm run diagnose:sync-maps -- --order=<retailOrderId>
//       THE ONE TO RUN FIRST for the reported bug. Fetches that retail order
//       and replays the exact per-line lookup drop-ship does, printing which
//       lines map and which don't (with the SKU, so you can see if it's (C)).
//
//   npm run diagnose:sync-maps -- --verify=50
//       Sample N productVariant rows and check each retailId still resolves
//       on the retail store. Non-resolving = case (A), orphaned.
//
//   npm run diagnose:sync-maps -- --scan-retail=250
//       Walk the N most recent retail products and report how many of their
//       variants have NO mapping row = case (B)/(C).
//
// (Runs via vite-node so the app's ESM + extensionless imports resolve.)

import connectDB from '../app/services/APIService/mongo.service.js'
import IdMap from '../app/services/sync/idMap.model.js'
import { retailClient } from '../app/services/sync/retailApi.js'
import { syncConfig, isSyncEnabled } from '../app/services/sync/sync.config.js'

const PENDING_RETAIL_ID = '__pending__'

function argValue(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.slice(name.length + 3)
}

function heading(text) {
  console.log(`\n${'─'.repeat(72)}\n${text}\n${'─'.repeat(72)}`)
}

async function summary() {
  heading('1. Row counts by entityType')

  const byType = await IdMap.aggregate([
    { $group: { _id: '$entityType', count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ])

  if (byType.length === 0) {
    console.log('  ⚠  COLLECTION IS EMPTY — zero rows.')
    console.log('     Every drop-ship order will fail with "All N line items')
    console.log('     unmappable". Nothing has ever synced, or the DB was reset.')
    return { empty: true }
  }
  for (const r of byType) {
    console.log(`  ${String(r._id).padEnd(16)} ${String(r.count).padStart(7)}`)
  }

  const variantCount =
    byType.find((r) => r._id === 'productVariant')?.count ?? 0
  if (variantCount === 0) {
    console.log('\n  ⚠  ZERO productVariant rows — this is the exact lookup')
    console.log('     drop-ship intake performs. Order intake CANNOT work.')
  }

  heading('2. Stuck claim rows (retailId === "__pending__")')
  const pending = await IdMap.find({ retailId: PENDING_RETAIL_ID })
    .select('entityType wholesaleId updatedAt')
    .lean()
  if (pending.length === 0) {
    console.log('  ✓ none — no create was interrupted mid-flight.')
  } else {
    console.log(
      `  ⚠  ${pending.length} stuck claim(s). A retail create failed after`,
    )
    console.log('     claiming the row. syncProductCreate() now short-circuits')
    console.log('     with "create_in_flight" FOREVER for these wholesale ids,')
    console.log('     so their variant rows are never written.')
    for (const p of pending.slice(0, 20)) {
      console.log(
        `     - ${p.entityType} wholesaleId=${p.wholesaleId} (updated ${p.updatedAt?.toISOString?.() || '?'})`,
      )
    }
    if (pending.length > 20) console.log(`     … +${pending.length - 20} more`)
  }

  heading('3. productVariant rows missing a wholesalePrice snapshot')
  const missingPrice = await IdMap.countDocuments({
    entityType: 'productVariant',
    $or: [{ wholesalePrice: null }, { wholesalePrice: { $exists: false } }],
  })
  if (missingPrice === 0) {
    console.log('  ✓ none — every variant row carries a wholesale price.')
  } else {
    console.log(
      `  ⚠  ${missingPrice} of ${variantCount} variant row(s) have no wholesalePrice.`,
    )
    console.log('     These still MAP (so intake succeeds) but drop-ship falls')
    console.log('     back to retail x 0.5 for pricing, and the ns-retail QBO')
    console.log('     Vendor Bill does the same — correct only if retail is')
    console.log('     exactly 2x wholesale.')
  }

  return { empty: false, variantCount }
}

// Replay the EXACT lookup dropship.service.resolveWholesaleLines() performs,
// for a real retail order. This is the definitive reproduction.
async function diagnoseOrder(retailOrderId) {
  heading(`4. Replaying drop-ship variant lookup for retail order ${retailOrderId}`)

  let order
  try {
    const data = await retailClient.get(`orders/${retailOrderId}.json`)
    order = data?.order
  } catch (err) {
    console.log(`  ✗ Could not fetch retail order: ${err?.message || err}`)
    return
  }
  if (!order) {
    console.log('  ✗ Retail order not found.')
    return
  }

  console.log(`  Order ${order.name || order.id}  •  email=${order.email || 'n/a'}`)
  const lines = Array.isArray(order.line_items) ? order.line_items : []
  console.log(`  ${lines.length} line item(s)\n`)

  let mapped = 0
  let unmapped = 0

  for (const line of lines) {
    const retailVariantId = String(line?.variant_id || '')
    const sku = line?.sku || '(no sku)'
    const title = String(line?.title || '').slice(0, 40)

    if (!retailVariantId) {
      console.log(`  ✗ UNMAPPED  "${title}"  sku=${sku}`)
      console.log('              reason: retail line has no variant_id')
      unmapped++
      continue
    }

    const row = await IdMap.findOne({
      entityType: 'productVariant',
      retailId: retailVariantId,
    })
      .select('wholesaleId wholesalePrice updatedAt')
      .lean()

    if (!row?.wholesaleId) {
      console.log(`  ✗ UNMAPPED  "${title}"  sku=${sku}`)
      console.log(
        `              retailVariantId=${retailVariantId} has NO sync_id_maps row`,
      )
      unmapped++
      continue
    }

    mapped++
    const priceNote =
      row.wholesalePrice == null
        ? 'no wholesalePrice -> will fall back to retail x 0.5'
        : `wholesalePrice=${row.wholesalePrice}`
    console.log(`  ✓ mapped    "${title}"  sku=${sku}`)
    console.log(
      `              retail ${retailVariantId} -> wholesale ${row.wholesaleId}  (${priceNote})`,
    )
  }

  console.log(`\n  RESULT: ${mapped} mapped, ${unmapped} unmapped.`)
  if (lines.length > 0 && mapped === 0) {
    console.log(
      `  => buildDropshipLineItems() THROWS "All ${lines.length} line items`,
    )
    console.log('     unmappable to wholesale variants" — no wholesale order,')
    console.log('     no QBO invoice. This reproduces the reported bug.')
  } else if (unmapped > 0) {
    console.log('  => Intake SUCCEEDS but silently DROPS the unmapped line(s)')
    console.log('     from the wholesale order (logged as unmapped_line_items).')
  } else {
    console.log('  => This order maps cleanly.')
  }
}

// Case (A): do the retailIds we stored still exist on the retail store?
async function verifyRetailIds(sampleSize) {
  heading(`5. Verifying ${sampleSize} stored retailId(s) still exist on retail`)

  const rows = await IdMap.find({
    entityType: 'productVariant',
    retailId: { $ne: PENDING_RETAIL_ID },
  })
    .select('wholesaleId retailId')
    .sort({ updatedAt: -1 })
    .limit(sampleSize)
    .lean()

  if (rows.length === 0) {
    console.log('  (no productVariant rows to verify)')
    return
  }

  let alive = 0
  const dead = []
  for (const r of rows) {
    try {
      const data = await retailClient.get(`variants/${r.retailId}.json`)
      if (data?.variant?.id) alive++
      else dead.push(r)
    } catch (err) {
      // 404 => PermanentError from retailApi. That's an orphaned row.
      if (err?.status === 404 || /404/.test(String(err?.message))) dead.push(r)
      else {
        console.log(
          `  ? retail ${r.retailId}: lookup error ${err?.message || err}`,
        )
      }
    }
    await new Promise((res) => setTimeout(res, 120)) // gentle pacing
  }

  console.log(`  alive: ${alive} / ${rows.length}`)
  if (dead.length === 0) {
    console.log('  ✓ No orphaned rows in this sample.')
    return
  }

  console.log(`\n  ⚠  ${dead.length} ORPHANED row(s) — retailId no longer exists:`)
  for (const d of dead.slice(0, 20)) {
    console.log(`     - wholesale ${d.wholesaleId} -> dead retail ${d.retailId}`)
  }
  if (dead.length > 20) console.log(`     … +${dead.length - 20} more`)
  console.log('\n  This is case (A). The retail catalog was replaced, so the')
  console.log('  stored ids are stale. Critically, syncProductCreate() will')
  console.log('  NOT self-heal these: it sees an existing product row, routes')
  console.log('  to syncProductUpdate(), which PUTs to the dead retail id,')
  console.log('  gets a 404 (a PermanentError, not retried), and throws BEFORE')
  console.log('  reaching upsertVariantMappings(). The rows stay stale forever.')
}

// Case (B)/(C): retail variants that have no mapping row at all.
async function scanRetail(limit) {
  heading(`6. Scanning ${limit} recent retail product(s) for unmapped variants`)

  let products = []
  try {
    const data = await retailClient.get(
      `products.json?limit=${Math.min(limit, 250)}`,
    )
    products = data?.products || []
  } catch (err) {
    console.log(`  ✗ Could not list retail products: ${err?.message || err}`)
    return
  }
  console.log(`  fetched ${products.length} retail product(s)\n`)

  let totalVariants = 0
  let unmappedVariants = 0
  const examples = []

  for (const p of products) {
    for (const v of p.variants || []) {
      totalVariants++
      const row = await IdMap.findOne({
        entityType: 'productVariant',
        retailId: String(v.id),
      })
        .select('_id')
        .lean()
      if (!row) {
        unmappedVariants++
        if (examples.length < 25) {
          examples.push({
            product: String(p.title || '').slice(0, 40),
            variantId: String(v.id),
            sku: v.sku || '(BLANK SKU)',
          })
        }
      }
    }
  }

  console.log(
    `  ${unmappedVariants} of ${totalVariants} retail variant(s) have NO mapping row.`,
  )
  if (unmappedVariants === 0) {
    console.log('  ✓ Every scanned retail variant is mapped.')
    return
  }

  console.log('\n  Examples (an order touching any of these will fail):')
  for (const e of examples) {
    console.log(`     - "${e.product}"  variant=${e.variantId}  sku=${e.sku}`)
  }

  const blankSkus = examples.filter((e) => e.sku === '(BLANK SKU)').length
  if (blankSkus > 0) {
    console.log(`\n  ⚠  ${blankSkus} of the examples have a BLANK SKU. The sync`)
    console.log('     pairs variants by SKU (pairVariantsBySku), and silently')
    console.log('     SKIPS any variant with no SKU — so these can never map')
    console.log('     until a SKU is set on BOTH stores. This is case (C).')
  }
  console.log('\n  Otherwise this is case (B): these retail products were not')
  console.log('  created by the wholesale->retail sync, so no row was written.')
}

async function main() {
  console.log('[diagnose:sync-maps] READ-ONLY — no writes performed.')
  console.log(`  retail store: ${syncConfig.retailShop || '(unset)'}`)
  console.log(`  isSyncEnabled(): ${isSyncEnabled()}`)
  if (!isSyncEnabled()) {
    console.log(
      '  ⚠  Sync is DISABLED (RETAIL_SHOP_DOMAIN / RETAIL_ADMIN_ACCESS_TOKEN missing).',
    )
    console.log('     Product webhooks skip the retail mirror entirely, so no')
    console.log('     new mapping rows are being written at all.')
  }

  await connectDB()

  const res = await summary()

  const orderId = argValue('order')
  if (orderId) await diagnoseOrder(orderId)

  const verify = argValue('verify')
  if (verify && !res.empty) await verifyRetailIds(parseInt(verify, 10) || 50)

  const scan = argValue('scan-retail')
  if (scan) await scanRetail(parseInt(scan, 10) || 250)

  if (!orderId && !verify && !scan) {
    console.log(
      '\nNext: re-run with --order=<retailOrderId> for the failing order to',
    )
    console.log('see exactly which lines fail to map.')
  }

  console.log('\n[diagnose:sync-maps] done.')
  process.exit(0)
}

main().catch((err) => {
  console.error('[diagnose:sync-maps] FAILED', err)
  process.exit(1)
})
