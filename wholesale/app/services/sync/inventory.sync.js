import IdMap from './idMap.model'
import { retailClient } from './retailApi'
import { resolveRetailLocationId } from './sync.utils'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('sync.inventory')

// ── Retail deduction on wholesale orders ────────────────────────────────

// Called after a wholesale order is received. Deducts the order quantities
// from the retail store's inventory for each line item that has a mapping.
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

// ── Restock sync: wholesale → retail ────────────────────────────────────

// Called from inventory_levels/update webhook.
// Only syncs increases (restocks) to retail. Decreases are skipped because
// order webhooks already handle cross-store deductions — if we synced
// decreases here too, retail would be double-deducted.
export async function syncInventoryRestockToRetail(inventoryItemId, locationId, available) {
  const wiId = String(inventoryItemId)

  const itemMap = await IdMap.findOne({ entityType: 'inventoryItem', wholesaleId: wiId })
  if (!itemMap) return  // not a mirrored product — skip silently

  const prev = itemMap.available ?? null
  const delta = prev !== null ? available - prev : null

  // Always update the stored quantity
  await IdMap.updateOne(
    { entityType: 'inventoryItem', wholesaleId: wiId },
    { $set: { available } },
  )

  // Only sync to retail when quantity definitely increased (delta > 0).
  // Null delta = no baseline yet — skip to avoid double-deduction race
  // with orders/create webhook which already handles deductions.
  if (!delta || delta <= 0) {
    log.info('restock_sync.skip', { wiId, prev, available, delta })
    return
  }

  const retailLocationId = await resolveRetailLocationId(String(locationId))
  if (!retailLocationId) return

  try {
    const finalQty = Math.max(0, available)
    await retailClient.post('inventory_levels/set.json', {
      inventory_item_id: Number(itemMap.retailId),
      location_id: Number(retailLocationId),
      available: finalQty,
    })
    // Mirror the new value into retailAvailable so the reverse-direction
    // webhook (retail inventory_levels/update) sees delta=0 and skips,
    // preventing an infinite restock loop wholesale → retail → wholesale.
    await IdMap.updateOne(
      { entityType: 'inventoryItem', wholesaleId: wiId },
      { $set: { retailAvailable: finalQty } },
    )
    log.info('restock_sync.done', { wiId, retailItemId: itemMap.retailId, available: finalQty })
  } catch (err) {
    log.error('restock_sync.set_failed', { wiId, err })
    throw err
  }
}
