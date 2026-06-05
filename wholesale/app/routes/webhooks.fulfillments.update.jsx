// Shopify fulfillments/update webhook handler.
//
// Fires when tracking info or carrier-driven shipment_status changes on an
// existing fulfillment. Mirrors webhooks.fulfillments.create.jsx exactly —
// same handler, with event='updated' so the tracking-history row is labelled
// correctly. See services/order/order.service.handleFulfillmentUpdate.
//
// File-based routing: this file's dotted name maps to /webhooks/fulfillments/update.

import { authenticate } from '../shopify.server'
import connectDB from '../services/APIService/mongo.service'
import { handleFulfillmentUpdate } from '../services/order/order.service'
import { createLogger } from '../utils/logger.utils'

const log = createLogger('webhook.fulfillments_update')

export const loader = async () => {
  return new Response(
    JSON.stringify({
      route: '/webhooks/fulfillments/update',
      status: 'alive — POST a Shopify fulfillments/update webhook here',
      method_expected: 'POST',
    }),
    { status: 405, headers: { 'Content-Type': 'application/json', Allow: 'POST' } },
  )
}

export const action = async ({ request }) => {
  const webhookId = request.headers.get('x-shopify-webhook-id') || ''
  console.log(`\n[webhook] fulfillments/update POST received at ${new Date().toISOString()}`)
  console.log(`[webhook]   webhook-id: ${webhookId || '(missing)'}`)
  log.info('hit', { webhookId })

  let webhook
  try {
    webhook = await authenticate.webhook(request)
  } catch (err) {
    console.log(`[webhook] HMAC verification failed: ${err?.message || err}`)
    log.error('auth.failed', { err })
    return new Response('Unauthorized', { status: 401 })
  }

  const { shop, topic, payload } = webhook
  log.info('received', { shop, topic, fulfillmentId: payload?.id, orderId: payload?.order_id })
  console.log(
    `[webhook] fulfillments/update shop=${shop} fulfillment=${payload?.id} order=${payload?.order_id} ` +
      `carrier=${payload?.tracking_company || '(none)'} number=${payload?.tracking_number || '(none)'} ` +
      `shipment_status=${payload?.shipment_status || '(none)'}`,
  )

  if (!payload?.id || !payload?.order_id) {
    log.warn('payload.missing_ids', { shop })
    return new Response('Bad payload', { status: 400 })
  }

  try {
    await connectDB()
    handleFulfillmentUpdate({ shop, fulfillment: payload, webhookId, event: 'updated' })
      .then((result) => {
        log.info('inline.done', { shop, orderId: payload.order_id, tracked: Boolean(result) })
      })
      .catch((err) => {
        console.error(`[webhook] fulfillment handling FAILED order=${payload.order_id}:`, err?.stack || err)
        log.error('inline.failed', { shop, orderId: payload.order_id, webhookId, err })
      })
  } catch (err) {
    console.error('[webhook] connect failed:', err?.stack || err)
    log.error('connect.failed', { shop, err })
    return new Response('Connect failed', { status: 500 })
  }

  return new Response(null, { status: 200 })
}
