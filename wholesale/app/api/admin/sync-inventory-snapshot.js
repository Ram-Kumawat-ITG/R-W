import { authenticate } from '../../shopify.server'
import connectDB from '../../services/APIService/mongo.service'
import { sendResponse } from '../../services/APIService/api.service'
import { isSyncEnabled } from '../../services/sync/sync.config'
import IdMap from '../../services/sync/idMap.model'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('api.admin.inventory_snapshot')

const INVENTORY_LEVELS_QUERY = `
  query getInventoryLevels($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on InventoryItem {
        legacyResourceId
        inventoryLevels(first: 5) {
          nodes {
            quantities(names: ["available"]) { name quantity }
          }
        }
      }
    }
  }
`

// POST /api/admin/sync/inventory-snapshot
//
// Fetches current inventory levels from wholesale Shopify for all mapped
// inventoryItem rows and saves them to MongoDB. Safe to run any time —
// does NOT re-sync products, only updates the available field.
export async function action({ request }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  const { admin } = await authenticate.admin(request)

  if (!isSyncEnabled()) {
    return sendResponse(503, 'error', 'Sync not configured', null)
  }

  await connectDB()

  const allMaps = await IdMap.find({ entityType: 'inventoryItem' }).lean()
  if (allMaps.length === 0) {
    return sendResponse(200, 'success', 'No inventory items mapped yet — run product sync first', { updated: 0 })
  }

  const BATCH = 50
  let updated = 0

  for (let i = 0; i < allMaps.length; i += BATCH) {
    const batch = allMaps.slice(i, i + BATCH)
    const gids = batch.map((m) => `gid://shopify/InventoryItem/${m.wholesaleId}`)

    const res = await admin.graphql(INVENTORY_LEVELS_QUERY, { variables: { ids: gids } })
    const json = await res.json()

    for (const node of json?.data?.nodes || []) {
      if (!node?.legacyResourceId) continue
      const available =
        node.inventoryLevels?.nodes?.[0]?.quantities?.find((q) => q.name === 'available')
          ?.quantity ?? null
      if (available === null) continue

      await IdMap.updateOne(
        { entityType: 'inventoryItem', wholesaleId: String(node.legacyResourceId) },
        { $set: { available } },
      )
      updated++
    }
  }

  log.info('inventory_snapshot.done', { updated })
  return sendResponse(200, 'success', `Inventory snapshot complete: ${updated} items updated`, { updated })
}

export async function loader() {
  return sendResponse(405, 'error', 'Method not allowed', null)
}
