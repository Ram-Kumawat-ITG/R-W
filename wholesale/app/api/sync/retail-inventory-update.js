import connectDB from '../../services/APIService/mongo.service'
import { sendResponse } from '../../services/APIService/api.service'
import { syncConfig, isSyncEnabled } from '../../services/sync/sync.config'
import { syncWholesaleRestockFromRetail } from '../../services/sync/inventory.sync'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('api.sync.retail_inventory_update')

// Module-level dedup. Retail Shopify's at-least-once webhook delivery means
// the same inventory event may arrive twice. We dedup by composite key
// (inventoryItemId + available) within a 30-second window because the same
// item legitimately changing twice quickly is rare and the dedup is purely
// defensive — even if we miss the dedup the syncWholesaleRestockFromRetail
// function itself is delta-safe (it stores retailAvailable so a duplicate
// event sees delta=0).
const _dedupedEvents = new Set()
function claimEvent(key) {
  if (!key || _dedupedEvents.has(key)) return false
  _dedupedEvents.add(key)
  setTimeout(() => _dedupedEvents.delete(key), 30 * 1000)
  return true
}

// POST /api/sync/retail-inventory-update
//
// Called by the retail store's inventory_levels/update webhook (via a thin
// retail webhook subscription with our shared-secret URL). Mirrors retail
// restocks (refunds, manual adjustments, returns) back to the wholesale
// store so cross-store inventory stays in sync.
//
// Only POSITIVE deltas are mirrored. Negative deltas (deductions) are
// already handled by /api/sync/retail-order from the orders/create webhook.
//
// Authentication: shared secret via header (x-sync-secret) or query param
// (?secret=...). Shopify admin webhooks can't send custom headers, so query
// param is the standard configuration. The wholesale shop domain must also
// be passed via ?shop=... so we know which wholesale store to talk to.
export async function action({ request }) {
  console.log(`\n[API] POST /api/sync/retail-inventory-update received at ${new Date().toISOString()}`)
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  if (!isSyncEnabled()) {
    return sendResponse(503, 'error', 'Sync not configured', null)
  }

  const url = new URL(request.url)
  const incomingSecret =
    request.headers.get('x-sync-secret') || url.searchParams.get('secret') || ''
  if (!syncConfig.syncSecret || incomingSecret !== syncConfig.syncSecret) {
    log.warn('auth.failed', { hasSecret: Boolean(incomingSecret) })
    return sendResponse(401, 'error', 'Unauthorized', null)
  }

  const wholesaleShop = url.searchParams.get('shop') || null

  let payload
  try {
    payload = await request.json()
  } catch {
    return sendResponse(400, 'error', 'Invalid JSON payload', null)
  }

  // Shopify inventory_levels/update payload shape:
  // { inventory_item_id, location_id, available, updated_at }
  const retailInventoryItemId = payload?.inventory_item_id
  const retailLocationId = payload?.location_id
  const available = payload?.available

  if (!retailInventoryItemId || available === undefined || !wholesaleShop) {
    return sendResponse(400, 'error', 'Missing inventory_item_id / available / shop', null)
  }

  const dedupKey = `${retailInventoryItemId}:${available}:${payload?.updated_at || ''}`
  if (!claimEvent(dedupKey)) {
    log.info('dedup.skipped', { dedupKey })
    return sendResponse(200, 'success', 'Duplicate event skipped', null)
  }

  log.info('received', {
    retailInventoryItemId,
    retailLocationId,
    available,
    wholesaleShop,
  })

  await connectDB()

  // Fire-and-forget — return 200 immediately so the retail webhook doesn't
  // time out waiting for the cross-store GraphQL adjustment to complete.
  syncWholesaleRestockFromRetail({
    retailInventoryItemId,
    retailLocationId,
    available: Number(available),
    wholesaleShop,
  })
    .then(() => log.info('done', { retailInventoryItemId }))
    .catch((err) => log.error('failed', { retailInventoryItemId, err: err?.message || String(err) }))

  return sendResponse(200, 'success', 'Received', { retailInventoryItemId })
}

export async function loader() {
  return sendResponse(405, 'error', 'Method not allowed', null)
}
