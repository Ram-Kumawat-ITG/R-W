import IdMap from './idMap.model'
import { retailClient } from './retailApi'
import { resolveRetailLocationId, resolveWholesaleLocationId } from './sync.utils'
import { getUnauthenticatedAdmin } from '../shopify/shopify.apis'
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

// ── Wholesale deduction on retail orders ────────────────────────────────

// Called from /api/sync/retail-order when the retail store places an order.
// Uses the wholesale Shopify GraphQL client to adjust inventory levels.
export async function deductWholesaleInventoryForOrder(order, wholesaleShop) {
  const lineItems = order.line_items || []
  const { admin } = await getUnauthenticatedAdmin(wholesaleShop)
  const wholesaleLocationId = await resolveWholesaleLocationId(admin)
  if (!wholesaleLocationId) {
    log.warn('deduct_wholesale.no_location', { shop: wholesaleShop })
    return
  }

  // Build GraphQL inventory adjustment changes
  const changes = []
  for (const item of lineItems) {
    if (!item.variant_id) continue
    const variantMap = await IdMap.findOne({
      entityType: 'productVariant',
      retailId: String(item.variant_id),
    })
    if (!variantMap) {
      log.warn('deduct_wholesale.no_variant_map', { retailVariantId: item.variant_id, title: item.title })
      continue
    }
    const inventoryMap = await IdMap.findOne({
      entityType: 'inventoryItem',
      wholesaleId: String(variantMap.wholesaleInventoryItemId),
    })
    if (!inventoryMap) {
      log.warn('deduct_wholesale.no_inventory_map', { wholesaleVariantId: variantMap.wholesaleId, wholesaleInventoryItemId: variantMap.wholesaleInventoryItemId })
      continue
    }
    const qty = item.quantity || 1
    changes.push({
      inventoryItemId: `gid://shopify/InventoryItem/${inventoryMap.wholesaleId}`,
      locationId: `gid://shopify/Location/${wholesaleLocationId}`,
      delta: -qty,
    })
  }

  if (changes.length === 0) return

  const res = await admin.graphql(
    `mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        userErrors { field message }
      }
    }`,
    { variables: { input: { reason: 'correction', name: 'available', changes } } },
  )
  const json = await res.json()
  const errs = json?.data?.inventoryAdjustQuantities?.userErrors
  if (errs?.length) {
    log.error('deduct_wholesale.user_errors', { errs })
  } else {
    log.info('deduct_wholesale.done', { shop: wholesaleShop, changeCount: changes.length })
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

// ── Restock sync: retail → wholesale ────────────────────────────────────

// Called from the retail store's inventory_levels/update webhook (forwarded
// to /api/sync/retail-inventory-update). Mirrors syncInventoryRestockToRetail
// in reverse — only syncs increases (refunds, restocks, manual adjustments
// that ADD inventory). Decreases are skipped because the retail orders/create
// webhook already handles cross-store deductions.
//
// Loop prevention: each direction updates BOTH stored values (available and
// retailAvailable) after a successful sync, so the next webhook coming back
// the other way sees delta=0 and skips.
export async function syncWholesaleRestockFromRetail({
  retailInventoryItemId,
  retailLocationId,
  available,
  wholesaleShop,
}) {
  const riId = String(retailInventoryItemId)

  // Reverse lookup: retail inventory item → wholesale inventory item
  const itemMap = await IdMap.findOne({ entityType: 'inventoryItem', retailId: riId })
  if (!itemMap) {
    log.info('reverse_restock.no_mapping', { riId })
    return // not a mirrored product — skip silently
  }

  const prev = itemMap.retailAvailable ?? null
  const delta = prev !== null ? available - prev : null

  // Always update the stored retail quantity (even if we skip the sync).
  await IdMap.updateOne(
    { entityType: 'inventoryItem', retailId: riId },
    { $set: { retailAvailable: available } },
  )

  // Same logic as the forward direction:
  //   null delta = no baseline yet → skip (will establish baseline on next event)
  //   delta <= 0 = deduction (already handled by retail-order webhook) → skip
  if (!delta || delta <= 0) {
    log.info('reverse_restock.skip', { riId, prev, available, delta })
    return
  }

  // Resolve wholesale location + admin client
  const { getUnauthenticatedAdmin } = await import('../shopify/shopify.apis')
  const { resolveWholesaleLocationId } = await import('./sync.utils')
  const { admin } = await getUnauthenticatedAdmin(wholesaleShop)
  const wholesaleLocationId = await resolveWholesaleLocationId(admin)
  if (!wholesaleLocationId) {
    log.warn('reverse_restock.no_wholesale_location', { shop: wholesaleShop })
    return
  }

  // Use inventoryAdjustQuantities with a POSITIVE delta to restock wholesale.
  const wholesaleInventoryGid = `gid://shopify/InventoryItem/${itemMap.wholesaleId}`
  const wholesaleLocationGid = `gid://shopify/Location/${wholesaleLocationId}`

  try {
    const res = await admin.graphql(
      `mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
        inventoryAdjustQuantities(input: $input) {
          userErrors { field message }
        }
      }`,
      {
        variables: {
          input: {
            reason: 'restock',
            name: 'available',
            changes: [
              {
                inventoryItemId: wholesaleInventoryGid,
                locationId: wholesaleLocationGid,
                delta,
              },
            ],
          },
        },
      },
    )
    const json = await res.json()
    const errs = json?.data?.inventoryAdjustQuantities?.userErrors
    if (errs?.length) {
      log.error('reverse_restock.user_errors', { riId, errs })
      return
    }

    // Mirror the new value into wholesale `available` to prevent the
    // wholesale inventory_levels/update webhook (which will fire from
    // the GraphQL mutation above) from triggering an infinite loop.
    // We add the delta to whatever was stored previously.
    const newWholesaleAvailable = (itemMap.available ?? 0) + delta
    await IdMap.updateOne(
      { entityType: 'inventoryItem', retailId: riId },
      { $set: { available: newWholesaleAvailable } },
    )

    log.info('reverse_restock.done', {
      riId,
      wholesaleItemId: itemMap.wholesaleId,
      delta,
      newWholesaleAvailable,
    })
  } catch (err) {
    log.error('reverse_restock.failed', { riId, err })
    throw err
  }
}
