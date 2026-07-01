import IdMap from './idMap.model'
import { resolveWholesaleLocationId } from './sync.utils'
import { getUnauthenticatedAdmin } from '../shopify/shopify.apis.server'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('sync.inventory.server')

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

// ── Restock sync: retail → wholesale ────────────────────────────────────

// Called from the retail store's inventory_levels/update webhook (forwarded
// to /api/sync/retail-inventory-update). Only syncs increases — decreases are
// handled by the retail orders/create webhook to avoid double-deduction.
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

  const itemMap = await IdMap.findOne({ entityType: 'inventoryItem', retailId: riId })
  if (!itemMap) {
    log.info('reverse_restock.no_mapping', { riId })
    return
  }

  const prev = itemMap.retailAvailable ?? null
  const delta = prev !== null ? available - prev : null

  await IdMap.updateOne(
    { entityType: 'inventoryItem', retailId: riId },
    { $set: { retailAvailable: available } },
  )

  if (!delta || delta <= 0) {
    log.info('reverse_restock.skip', { riId, prev, available, delta })
    return
  }

  const { admin } = await getUnauthenticatedAdmin(wholesaleShop)
  const wholesaleLocationId = await resolveWholesaleLocationId(admin)
  if (!wholesaleLocationId) {
    log.warn('reverse_restock.no_wholesale_location', { shop: wholesaleShop })
    return
  }

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
