import { authenticate } from '../shopify.server'
import connectDB from '../services/APIService/mongo.service'
import { isSyncEnabled, syncProductCreate, claimSyncWebhook, upsertProductMap } from '../services/sync/index'
import { isQboProductSyncEnabled, syncProductToQbo } from '../services/qbo/qboProductSync.service'
import { createLogger } from '../utils/logger.utils'

const log = createLogger('webhook.products_create')

export const loader = async () =>
  new Response(
    JSON.stringify({ route: '/webhooks/products/create', method_expected: 'POST' }),
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
  log.info('received', { shop, topic, productId: payload?.id })

  if (!payload?.id) return new Response('Bad payload', { status: 400 })

  const retailOn = isSyncEnabled()
  const qboOn = isQboProductSyncEnabled()
  if (!retailOn && !qboOn) {
    log.info('sync_disabled', { shop })
    return new Response(null, { status: 200 })
  }

  // Dedup Shopify's at-least-once redelivery before starting a second
  // concurrent sync for the same event. (The claim-first IdMap insert in
  // syncProductCreate is the durable backstop across restarts/instances.)
  const webhookId = request.headers.get('x-shopify-webhook-id')
  if (!claimSyncWebhook(webhookId)) {
    log.info('duplicate_webhook.skipped', { shop, productId: payload.id, webhookId })
    return new Response(null, { status: 200 })
  }

  await connectDB()

  // Retail Shopify mirror first, then refresh the comprehensive MongoDB
  // product map — chained after the sync settles (success OR failure) so the
  // map picks up the retail ids a successful create just wrote to
  // sync_id_maps, and a failed sync still leaves an up-to-date snapshot.
  if (retailOn) {
    syncProductCreate(payload, { shop })
      .then(() => log.info('done', { shop, productId: payload.id }))
      .catch((err) => log.error('failed', { shop, productId: payload.id, err }))
      .then(() => upsertProductMap(payload, { shop, event: 'create' }))
  }

  // QBO Products & Services sync — independent of the retail mirror. Creates
  // the QBO Item per variant + maintains qbo_product_maps. Fire-and-forget.
  if (qboOn) {
    syncProductToQbo(payload, { shop, event: 'create' })
      .then((s) => log.info('qbo_done', { shop, productId: payload.id, ...s }))
      .catch((err) => log.error('qbo_failed', { shop, productId: payload.id, err }))
  }

  return new Response(null, { status: 200 })
}
