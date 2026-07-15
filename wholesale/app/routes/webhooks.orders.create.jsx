// Shopify orders/create webhook handler.
//
// Thin handler — does HMAC verification, request logging, and a
// fire-and-forget call into the order orchestrator. Business logic
// lives in services/order/order.service.js. Returns 200 to Shopify
// BEFORE the orchestrator finishes so we never block on QBO/NMI
// latency. The orchestrator's idempotency layers handle Shopify's
// at-least-once retries.
//
// File-based routing: this file's dotted name maps to /webhooks/orders/create.
// Sibling webhook routes (webhooks.app.uninstalled.jsx, etc.) use the
// same convention.

import { authenticate } from '../shopify.server'
import connectDB from '../services/APIService/mongo.service'
import { scheduleNow, JOB_NAMES } from '../services/scheduler/scheduler.service'
import { processShopifyOrder } from '../services/order/order.service'
import { isSyncEnabled, deductRetailInventoryForOrder } from '../services/sync/index'
import { isRetailCustomerEmail } from '../services/dropship/dropship.config'
import { createLogger } from '../utils/logger.utils'

// Module-level dedup for retail deduction — guards against Shopify's
// at-least-once webhook delivery firing deductRetailInventoryForOrder twice
// for the same order. Each entry auto-expires after 5 minutes.
const _dedupedWebhookIds = new Set()
function claimWebhookForSync(id) {
  if (!id || _dedupedWebhookIds.has(id)) return false
  _dedupedWebhookIds.add(id)
  setTimeout(() => _dedupedWebhookIds.delete(id), 5 * 60 * 1000)
  return true
}

const log = createLogger('webhook.orders_create')

// inline = process the order directly in this Node process (fire-and-forget
// after returning 200). agenda = enqueue an Agenda job and let the worker
// pick it up. Inline is more reliable on hosts where the long-running
// scheduler process may sleep/restart between requests.
const PROCESS_MODE = process.env.WEBHOOK_PROCESS_MODE === 'agenda' ? 'agenda' : 'inline'

// GET handler — lets you verify the route exists by hitting it in a
// browser. Real webhooks always POST. If you see 404 in a browser the
// deployed bundle does not contain this route file (rebuild/redeploy).
export const loader = async () => {
  return new Response(
    JSON.stringify({
      route: '/webhooks/orders/create',
      status: 'alive — POST a Shopify orders/create webhook here',
      method_expected: 'POST',
    }),
    { status: 405, headers: { 'Content-Type': 'application/json', Allow: 'POST' } },
  )
}

export const action = async ({ request }) => {
  // Hard log BEFORE auth so we know the route was hit even if auth blows up.
  const webhookId = request.headers.get('x-shopify-webhook-id') || ''
  const webhookTopic = request.headers.get('x-shopify-topic') || ''
  const webhookShop = request.headers.get('x-shopify-shop-domain') || ''
  console.log(`\n[webhook] orders/create POST received at ${new Date().toISOString()}`)
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

  // Full payload dump for development visibility. The structured logger
  // emits one JSON line; the console.log gives a pretty-printed view.
  console.log('\n========== Shopify webhook: orders/create ==========')
  console.log(`shop:  ${shop}`)
  console.log(`topic: ${topic}`)
  console.log('payload:')
  console.dir(payload, { depth: null, colors: true })
  console.log('====================================================\n')
  log.info('payload', { shop, topic, payload })

  if (!payload?.id) {
    log.warn('payload.missing_id', { shop })
    return new Response('Bad payload', { status: 400 })
  }

  try {
    await connectDB()
    console.log(`[webhook] mongo connected, process mode = ${PROCESS_MODE}`)

    if (PROCESS_MODE === 'agenda') {
      // Durable path — store in Agenda's MongoDB collection, worker picks
      // it up. Use this once you've confirmed the worker is alive.
      const job = await scheduleNow(JOB_NAMES.PROCESS_ORDER, { shop, order: payload, webhookId })
      console.log(`[webhook] enqueued agenda job=${job?.attrs?._id} order=${payload.id}`)
      log.info('enqueued.agenda', { shop, orderId: payload.id, webhookId, jobId: String(job?.attrs?._id || '') })
    } else {
      // Inline path — fire-and-forget. We don't await the promise so the
      // webhook returns 200 to Shopify before QBO/NMI calls complete.
      // Background errors are caught and logged. webhookId is forwarded
      // so the orchestrator can dedupe Shopify retries on the same id.
      console.log(`[webhook] starting inline processing for order=${payload.id} webhookId=${webhookId}`)
      log.info('inline.start', { shop, orderId: payload.id, webhookId })
      processShopifyOrder({ shop, order: payload, webhookId })
        .then((result) => {
          console.log(
            `[webhook] inline processing finished order=${payload.id} status=${result?.processingStatus}`,
          )
          log.info('inline.done', {
            shop,
            orderId: payload.id,
            webhookId,
            status: result?.processingStatus,
            qboInvoiceId: result?.qboInvoiceId,
          })
        })
        .catch((err) => {
          console.error(`[webhook] inline processing FAILED order=${payload.id}:`, err?.stack || err)
          log.error('inline.failed', { shop, orderId: payload.id, webhookId, err })
        })
    }
  } catch (err) {
    // Catches mongo connect failures and any synchronous throw from above.
    // We MUST return non-2xx so Shopify retries, otherwise we drop the order.
    console.error(`[webhook] enqueue/connect failed:`, err?.stack || err)
    log.error('enqueue.failed', { shop, orderId: payload.id, err })
    return new Response('Enqueue failed', { status: 500 })
  }

  // Cross-store sync: deduct retail inventory for the same quantities.
  // Fire-and-forget — sync failure must never affect the 200 response.
  // claimWebhookForSync prevents double-deduction when Shopify retries the
  // same webhook (at-least-once delivery).
  //
  // Drop-ship orders are EXCLUDED: a drop-ship wholesale order mirrors a
  // retail order whose quantities were already deducted from retail stock
  // natively at retail checkout — mirroring the deduction again here would
  // double-deduct the retail store for every drop-ship sale.
  const orderEmail = payload?.email || payload?.contact_email || payload?.customer?.email
  if (isRetailCustomerEmail(orderEmail)) {
    log.info('retail_inventory_deduct.skipped_dropship', { shop, orderId: payload.id })
  } else if (isSyncEnabled() && claimWebhookForSync(webhookId)) {
    deductRetailInventoryForOrder(payload)
      .catch((err) => log.error('retail_inventory_deduct.failed', { shop, orderId: payload.id, err }))
  }

  return new Response(null, { status: 200 })
}
