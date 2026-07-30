import { authenticate } from '../shopify.server'
import connectDB from '../services/APIService/mongo.service'
import { isSyncEnabled, syncProductDelete, claimSyncWebhook, deleteProductMap } from '../services/sync/index'
import { isQboProductSyncEnabled, markQboProductDeleted } from '../services/qbo/qboProductSync.service'
import { createLogger } from '../utils/logger.utils'

const log = createLogger('webhook.products_delete')

export const loader = async () =>
  new Response(
    JSON.stringify({ route: '/webhooks/products/delete', method_expected: 'POST' }),
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

  // Dedup Shopify's at-least-once redelivery of the same event.
  const webhookId = request.headers.get('x-shopify-webhook-id')
  if (!claimSyncWebhook(webhookId)) {
    log.info('duplicate_webhook.skipped', { shop, productId: payload.id, webhookId })
    return new Response(null, { status: 200 })
  }

  await connectDB()

  // Retail delete first, then remove the MongoDB product-map document —
  // chained after the sync settles so the mirror is removed even when the
  // retail-side delete fails (the wholesale product is gone regardless).
  if (retailOn) {
    syncProductDelete(payload.id)
      .then(() => log.info('done', { shop, productId: payload.id }))
      .catch((err) => log.error('failed', { shop, productId: payload.id, err }))
      .then(() => deleteProductMap(payload.id))
  }

  // QBO: NEVER delete/deactivate the QBO Item — product records are retained
  // for historical reporting/accounting/analytics. Only flag the mapping
  // row(s) as shopify-deleted for audit. Fire-and-forget.
  if (qboOn) {
    markQboProductDeleted(payload.id)
      .then((s) => log.info('qbo_retained', { shop, productId: payload.id, ...s }))
      .catch((err) => log.error('qbo_mark_deleted_failed', { shop, productId: payload.id, err }))
  }

  return new Response(null, { status: 200 })
}
