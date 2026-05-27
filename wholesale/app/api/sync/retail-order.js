import connectDB from '../../services/APIService/mongo.service'
import { sendResponse } from '../../services/APIService/api.service'
import { syncConfig, isSyncEnabled } from '../../services/sync/sync.config'
import { deductWholesaleInventoryForOrder } from '../../services/sync/inventory.sync'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('api.sync.retail_order')

const _dedupedRetailOrderIds = new Set()
function claimRetailOrder(id) {
  if (!id || _dedupedRetailOrderIds.has(id)) return false
  _dedupedRetailOrderIds.add(id)
  setTimeout(() => _dedupedRetailOrderIds.delete(id), 5 * 60 * 1000)
  return true
}

// POST /api/sync/retail-order
//
// Called by the retail store's orders/create webhook (via a thin retail
// webhook handler). Deducts the retail order quantities from the wholesale
// store's inventory so both stores stay in sync.
//
// Authenticated by a shared secret header (X-Sync-Secret) set in both
// the wholesale .env and the retail webhook caller.
export async function action({ request }) {
  console.log(`\n[API] POST /api/sync/retail-order received at ${new Date().toISOString()}`)
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  if (!isSyncEnabled()) {
    return sendResponse(503, 'error', 'Sync not configured', null)
  }

  // Accept secret from either a header (custom callers) or a URL query
  // param (Shopify admin webhooks — they don't support custom headers).
  const url = new URL(request.url)
  const incomingSecret =
    request.headers.get('x-sync-secret') || url.searchParams.get('secret') || ''
  if (!syncConfig.syncSecret || incomingSecret !== syncConfig.syncSecret) {
    log.warn('auth.failed', { hasSecret: Boolean(incomingSecret) })
    return sendResponse(401, 'error', 'Unauthorized', null)
  }

  // Shopify webhooks send the order payload directly as the request body.
  // The wholesaleShop is passed as a query param since Shopify can't add body fields.
  const wholesaleShop =
    url.searchParams.get('shop') || null

  let order
  try {
    order = await request.json()
  } catch {
    return sendResponse(400, 'error', 'Invalid JSON payload', null)
  }

  if (!order?.id || !wholesaleShop) {
    return sendResponse(400, 'error', 'Missing order or wholesaleShop', null)
  }

  if (!claimRetailOrder(String(order.id))) {
    log.warn('duplicate_retail_order.skipped', { orderId: order.id })
    return sendResponse(200, 'success', 'Duplicate — already processing', { orderId: order.id })
  }

  log.info('received', { orderId: order.id, wholesaleShop, lineItemCount: order.line_items?.length })

  await connectDB()

  // Fire-and-forget — return 200 immediately so the retail webhook doesn't
  // time out waiting for GraphQL + inventory adjustments to complete.
  deductWholesaleInventoryForOrder(order, wholesaleShop)
    .then(() => log.info('done', { orderId: order.id }))
    .catch((err) => log.error('failed', { orderId: order.id, err }))

  return sendResponse(200, 'success', 'Received', { orderId: order.id })
}

export async function loader() {
  return sendResponse(405, 'error', 'Method not allowed', null)
}
