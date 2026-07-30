import IdMap from './idMap.model'
import { retailClient } from './retailApi'
import { resolveRetailLocationId } from './sync.utils'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('sync.inventory')

// ── Retail deduction on wholesale orders (DEPRECATED — no longer called) ──
//
// DEPRECATED 2026-07-16. Retail inventory is no longer deducted directly from
// the orders/create webhook. That produced a DOUBLE deduction: the order
// webhook deducted retail here, AND the wholesale inventory_levels/update
// webhook (which fires because the order lowered wholesale stock) also mirrors
// the change to retail. Retail is now updated by ONE path only —
// syncInventoryLevelToRetail, driven off inventory_levels/update — so a
// wholesale order deducts retail exactly once (an absolute mirror of the new
// wholesale quantity). Kept, uncalled, only to avoid breaking any external
// import; safe to delete once confirmed unused. DO NOT re-wire this into the
// order flow without also disabling the inventory_levels/update retail mirror,
// or retail will double-deduct again.
export async function deductRetailInventoryForOrder(order) {
  const lineItems = order.line_items || []
  const locationId = order.location_id ?? null

  for (const item of lineItems) {
    if (!item.variant_id) continue

    const variantMap = await IdMap.findOne({
      entityType: 'productVariant',
      wholesaleId: String(item.variant_id),
    })
    if (!variantMap) {
      log.warn('deduct_retail.no_variant_map', { variantId: item.variant_id, title: item.title })
      continue
    }

    // Get retail inventory item ID from the retail variant
    let retailInventoryItemId
    try {
      const vData = await retailClient.get(`variants/${variantMap.retailId}.json`)
      retailInventoryItemId = vData?.variant?.inventory_item_id
    } catch (err) {
      log.warn('deduct_retail.variant_fetch_failed', { retailVariantId: variantMap.retailId, err })
      continue
    }
    if (!retailInventoryItemId) continue

    const retailLocationId = await resolveRetailLocationId(locationId)
    if (!retailLocationId) {
      log.warn('deduct_retail.no_location', { orderId: order.id })
      continue
    }

    const qty = item.quantity || 1
    try {
      await retailClient.post('inventory_levels/adjust.json', {
        inventory_item_id: Number(retailInventoryItemId),
        location_id: Number(retailLocationId),
        available_adjustment: -qty,
      })
      log.info('deduct_retail.done', { variantId: item.variant_id, qty })
    } catch (err) {
      log.error('deduct_retail.adjust_failed', { variantId: item.variant_id, qty, err })
    }
  }
}

// ── Inventory synchronization: wholesale → retail ───────────────────────
//
// Wholesale is the SINGLE SOURCE OF TRUTH for stock. Called from the wholesale
// inventory_levels/update webhook, which Shopify fires on EVERY wholesale
// quantity change — an order deduction, a manual edit, a restock, a return.
// This mirrors the new ABSOLUTE quantity onto the retail store.
//
// This is the ONLY path that writes retail inventory in response to a
// wholesale change. There is deliberately NO separate order-time deduction
// (see the deprecated deductRetailInventoryForOrder above): handling every
// change through one idempotent absolute SET means a wholesale order deducts
// retail exactly once, and any drift self-corrects on the next update.
//
// Both increases AND decreases are mirrored (unlike the previous
// increases-only "restock" behaviour, which existed only because the order
// webhook handled decreases separately — the very split that caused the
// double deduction).
//
// Loop prevention: after pushing to retail we store the value in BOTH
// `available` and `retailAvailable`, so the retail store's own
// inventory_levels/update (bounced back via /api/sync/retail-inventory-update
// → syncWholesaleRestockFromRetail) sees delta=0 and stops. The no-op guard
// below also terminates the loop when the incoming quantity already matches
// what we last recorded.
export async function syncInventoryLevelToRetail(inventoryItemId, locationId, available) {
  const wiId = String(inventoryItemId)

  const itemMap = await IdMap.findOne({ entityType: 'inventoryItem', wholesaleId: wiId })
  if (!itemMap) return // not a mirrored product — skip silently

  const nextAvailable = Math.max(0, Number(available) || 0)
  const prev = itemMap.available ?? null

  // Always record the latest wholesale quantity.
  await IdMap.updateOne(
    { entityType: 'inventoryItem', wholesaleId: wiId },
    { $set: { available: nextAvailable } },
  )

  // No-op / loop guard: nothing to mirror when the wholesale quantity already
  // matches what we last recorded. This is also how the reverse-sync loop
  // terminates — syncWholesaleRestockFromRetail pre-sets `available` after
  // pushing wholesale → so the wholesale webhook it triggers is a no-op here.
  if (prev !== null && nextAvailable === prev) {
    log.info('inventory_sync.skip_noop', { wiId, available: nextAvailable })
    return
  }

  const retailLocationId = await resolveRetailLocationId(String(locationId))
  if (!retailLocationId) {
    log.warn('inventory_sync.no_retail_location', { wiId, locationId })
    return
  }

  try {
    await retailClient.post('inventory_levels/set.json', {
      inventory_item_id: Number(itemMap.retailId),
      location_id: Number(retailLocationId),
      available: nextAvailable,
    })
    // Mirror the new value into retailAvailable so the reverse-direction
    // webhook (retail inventory_levels/update) sees delta=0 and skips,
    // preventing an infinite sync loop wholesale → retail → wholesale.
    await IdMap.updateOne(
      { entityType: 'inventoryItem', wholesaleId: wiId },
      { $set: { retailAvailable: nextAvailable } },
    )
    log.info('inventory_sync.done', {
      wiId,
      retailItemId: itemMap.retailId,
      available: nextAvailable,
      prev,
    })
  } catch (err) {
    log.error('inventory_sync.set_failed', { wiId, err })
    throw err
  }
}
