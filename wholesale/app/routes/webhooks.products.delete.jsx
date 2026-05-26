import { authenticate } from '../shopify.server'
import connectDB from '../services/APIService/mongo.service'
import { isSyncEnabled, syncProductDelete } from '../services/sync/index'
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

  if (!isSyncEnabled()) {
    log.info('sync_disabled', { shop })
    return new Response(null, { status: 200 })
  }

  await connectDB()

  syncProductDelete(payload.id)
    .then(() => log.info('done', { shop, productId: payload.id }))
    .catch((err) => log.error('failed', { shop, productId: payload.id, err }))

  return new Response(null, { status: 200 })
}
