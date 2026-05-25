// Shopify orders/cancelled webhook handler.
//
// Mirrors webhooks.orders.create.jsx in shape: HMAC verify, log,
// fire-and-forget into handleOrderCancelled, return 200 fast. Business
// logic lives in services/order/order.service.handleOrderCancelled
// (cancels the local Invoice, voids the QBO invoice when safe, leaves
// an audit remark, and the existing CRON filters auto-skip the now-
// cancelled invoice).
//
// File-based routing: this file's dotted name maps to /webhooks/orders/cancelled.

import { authenticate } from '../shopify.server'
import connectDB from '../services/APIService/mongo.service'
import { handleOrderCancelled } from '../services/order/order.service'
import { createLogger } from '../utils/logger.utils'

const log = createLogger('webhook.orders_cancelled')

// GET handler — same convenience-route-exists check the create handler uses.
export const loader = async () => {
  return new Response(
    JSON.stringify({
      route: '/webhooks/orders/cancelled',
      status: 'alive — POST a Shopify orders/cancelled webhook here',
      method_expected: 'POST',
    }),
    { status: 405, headers: { 'Content-Type': 'application/json', Allow: 'POST' } },
  )
}

export const action = async ({ request }) => {
  const webhookId = request.headers.get('x-shopify-webhook-id') || ''
  const webhookTopic = request.headers.get('x-shopify-topic') || ''
  const webhookShop = request.headers.get('x-shopify-shop-domain') || ''
  console.log(`\n[webhook] orders/cancelled POST received at ${new Date().toISOString()}`)
  console.log(`[webhook]   url:            ${request.url}`)
  console.log(`[webhook]   webhook-id:     ${webhookId || '(missing)'}`)
  console.log(`[webhook]   shopify-topic:  ${webhookTopic}`)
  console.log(`[webhook]   shopify-shop:   ${webhookShop}`)
  console.log(`[webhook]   has-hmac:       ${Boolean(request.headers.get('x-shopify-hmac-sha256'))}`)
  log.info('hit', { webhookId, topic: webhookTopic, shop: webhookShop })

  let webhook
  try {
    webhook = await authenticate.webhook(request)
  } catch (err) {
    console.log(`[webhook] HMAC verification failed: ${err?.message || err}`)
    log.error('auth.failed', { err })
    return new Response('Unauthorized', { status: 401 })
  }

  const { shop, topic, payload } = webhook
  log.info('received', { shop, topic, orderId: payload?.id })

  console.log('\n========== Shopify webhook: orders/cancelled ==========')
  console.log(`shop:  ${shop}`)
  console.log(`topic: ${topic}`)
  console.log(`order: ${payload?.id} cancel_reason=${payload?.cancel_reason || '(none)'} cancelled_at=${payload?.cancelled_at || '(none)'}`)
  console.log('=======================================================\n')
  log.info('payload', { shop, topic, orderId: payload?.id, cancelReason: payload?.cancel_reason })

  if (!payload?.id) {
    log.warn('payload.missing_id', { shop })
    return new Response('Bad payload', { status: 400 })
  }

  try {
    await connectDB()
    console.log(`[webhook] mongo connected — starting inline cancellation handling`)
    log.info('inline.start', { shop, orderId: payload.id, webhookId })

    // Fire-and-forget so we ACK 200 to Shopify regardless of how long
    // QBO/Mongo work takes. Errors are caught and logged; Shopify will
    // retry the webhook on its own schedule if we return non-2xx, so
    // we DO want the ACK to fire even when the background work fails.
    handleOrderCancelled({ shop, order: payload, webhookId })
      .then((result) => {
        console.log(
          `[webhook] cancellation handling finished order=${payload.id} status=${result?.processingStatus}`,
        )
        log.info('inline.done', {
          shop,
          orderId: payload.id,
          webhookId,
          status: result?.processingStatus,
        })
      })
      .catch((err) => {
        console.error(`[webhook] cancellation handling FAILED order=${payload.id}:`, err?.stack || err)
        log.error('inline.failed', { shop, orderId: payload.id, webhookId, err })
      })
  } catch (err) {
    console.error('[webhook] connect failed:', err?.stack || err)
    log.error('connect.failed', { shop, orderId: payload?.id, err })
    return new Response('Connect failed', { status: 500 })
  }

  return new Response(null, { status: 200 })
}
