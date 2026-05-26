import { authenticate } from '../shopify.server'
import connectDB from '../services/APIService/mongo.service'
import { isSyncEnabled, syncInventoryRestockToRetail } from '../services/sync/index'
import { createLogger } from '../utils/logger.utils'

const log = createLogger('webhook.inventory_levels_update')

export const loader = async () =>
  new Response(
    JSON.stringify({ route: '/webhooks/inventory_levels/update', method_expected: 'POST' }),
    { status: 405, headers: { 'Content-Type': 'application/json', Allow: 'POST' } },
  )

export const action = async ({ request }) => {
  let webhook
  try {
    webhook = await authenticate.webhook(request)
  } catch (err) {
    log.error('auth.failed', { err })
    return new Response('Unauthorized', { status: 401 })
  }

  const { shop, topic, payload } = webhook
  // inventory_levels/update payload: { inventory_item_id, location_id, available }
  const { inventory_item_id, location_id, available } = payload || {}
  log.info('received', { shop, topic, inventory_item_id, location_id, available })

  if (!inventory_item_id || available == null) {
    return new Response('Bad payload', { status: 400 })
  }

  if (!isSyncEnabled()) {
    log.info('sync_disabled', { shop })
    return new Response(null, { status: 200 })
  }

  await connectDB()

  syncInventoryRestockToRetail(inventory_item_id, location_id, available)
    .then(() => log.info('done', { shop, inventory_item_id }))
    .catch((err) => log.error('failed', { shop, inventory_item_id, err }))

  return new Response(null, { status: 200 })
}
