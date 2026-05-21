// Order processing orchestrator — the top-level driver that turns a
// Shopify orders/create webhook payload into a customer-ready, invoiced,
// scheduler-claimed local order.
//
// Idempotent + concurrency-safe. The full lifecycle is documented in
// INTEGRATIONS.md §5 (Order processing orchestrator).

import ShopifyOrder from '../../models/order.server'
import { ensureCustomerForOrder } from '../customer/customer.service'
import { createInvoiceForOrder } from '../invoice/invoice.service'
import { chargeInvoice } from '../payment/payment.service'
import { validateShopifyOrder } from './order.validator'
import { paymentConfig } from '../payment/payment.config'
import { customerHasApprovedTag } from '../shopify/shopify.service'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('order.service')

// Statuses that mean "no work to redo" — re-deliveries return early.
const TERMINAL_STATUSES = new Set(['completed', 'invoiced', 'scheduled', 'rejected'])
// Statuses that mean "another worker owns this right now".
const LOCKED_STATUSES = new Set(['processing'])
// How long after `processingClaimedAt` we allow a stale claim to be
// stolen — covers the case where a process crashed mid-flight.
const STALE_CLAIM_MS = 5 * 60 * 1000

// Idempotent order intake. Called from:
//   1. the Shopify orders/create webhook route (inline)
//   2. any replay/admin tool that wants to re-run a given order id
//
// Concurrency model — guards against duplicate QBO invoices:
//   - The ShopifyOrder doc has a unique index on (shop, shopifyOrderId).
//   - We use a single atomic findOneAndUpdate to TRANSITION the order's
//     status into `processing`. Only the worker that wins that
//     transition continues; everyone else returns early.
//   - The Invoice collection also has a unique (shop, shopifyOrderId)
//     index — last-resort DB-level guard if logic ever races.
//
// Returns the local ShopifyOrder document.
export async function processShopifyOrder({ shop, order, webhookId }) {
  if (!order?.id) throw new Error('processShopifyOrder: order.id is required')
  const shopifyOrderId = String(order.id)

  console.log(`\n[orders] processShopifyOrder shop=${shop} order=${shopifyOrderId} webhookId=${webhookId || '(none)'}`)

  // 1. Idempotency / dedup pre-check on the existing doc, if any. This
  //    is purely informational — the real guard is the atomic claim below.
  const preExisting = await ShopifyOrder.findOne({ shop, shopifyOrderId })
  if (preExisting) {
    console.log(
      `[orders] dedup pre-check: existing doc _id=${preExisting._id} status=${preExisting.processingStatus} ` +
        `qboInvoiceId=${preExisting.qboInvoiceId || '(none)'} seenWebhooks=${preExisting.seenWebhookIds?.length || 0}`,
    )
    if (webhookId && preExisting.seenWebhookIds?.includes(webhookId)) {
      console.log(`[orders] DUPLICATE webhookId=${webhookId} already processed — returning existing doc`)
      log.info('skip.duplicate_webhook', { shopifyOrderId, webhookId })
      return preExisting
    }
    if (TERMINAL_STATUSES.has(preExisting.processingStatus)) {
      console.log(
        `[orders] order already in terminal status "${preExisting.processingStatus}" with qboInvoice=${preExisting.qboInvoiceId} — returning existing`,
      )
      // Still record the webhook id so future deliveries are deduped.
      if (webhookId) {
        await ShopifyOrder.updateOne(
          { _id: preExisting._id },
          { $addToSet: { seenWebhookIds: webhookId }, $set: { lastWebhookId: webhookId } },
        )
      }
      log.info('skip.terminal_status', { shopifyOrderId, status: preExisting.processingStatus })
      return preExisting
    }
    if (
      LOCKED_STATUSES.has(preExisting.processingStatus) &&
      preExisting.processingClaimedAt &&
      Date.now() - preExisting.processingClaimedAt.getTime() < STALE_CLAIM_MS
    ) {
      console.log(
        `[orders] order is currently being processed by another worker (claimed ${preExisting.processingClaimedAt.toISOString()}) — exiting`,
      )
      log.info('skip.locked', { shopifyOrderId })
      return preExisting
    }
  }

  // 2. Atomic CLAIM — single round-trip that either creates the doc or
  //    transitions an existing doc from a reclaimable status into
  //    `processing`. If the update affects 0 docs, another worker has
  //    already claimed this order; we exit.
  //
  // `pending_approval` is reclaimable so that `replayPendingOrdersForCustomer`
  // (triggered when an admin approves a customer) can re-enter the pipeline.
  const claimableStatuses = ['received', 'failed', 'customer_ready', 'pending_approval']
  // Allow stealing stale claims.
  const now = new Date()
  const staleCutoff = new Date(now.getTime() - STALE_CLAIM_MS)
  const claim = await ShopifyOrder.findOneAndUpdate(
    {
      shop,
      shopifyOrderId,
      $or: [
        { processingStatus: { $in: claimableStatuses } },
        { processingStatus: 'processing', processingClaimedAt: { $lt: staleCutoff } },
        { processingStatus: { $exists: false } },
      ],
    },
    {
      $setOnInsert: {
        shop,
        shopifyOrderId,
        receivedAt: now,
      },
      $set: {
        processingStatus: 'processing',
        processingClaimedAt: now,
        processingError: undefined,
        shopifyOrderNumber: order.order_number,
        shopifyOrderName: order.name,
        customerEmail: (order.email || order.customer?.email || '').toLowerCase() || undefined,
        shopifyCustomerId: order.customer?.id ? String(order.customer.id) : undefined,
        currency: order.currency,
        totalAmount: Number(order.total_price ?? 0),
        financialStatus: order.financial_status,
        fulfillmentStatus: order.fulfillment_status,
        rawPayload: order,
        lastWebhookId: webhookId || undefined,
      },
      ...(webhookId ? { $addToSet: { seenWebhookIds: webhookId } } : {}),
    },
    { upsert: true, new: true },
  )

  if (!claim) {
    // We didn't match anything — another worker has the lock and it's
    // not stale. Re-read for the caller's convenience.
    console.log(`[orders] LOST CLAIM RACE for order ${shopifyOrderId} — another worker is processing`)
    log.info('skip.claim_lost', { shopifyOrderId })
    return await ShopifyOrder.findOne({ shop, shopifyOrderId })
  }
  const local = claim
  console.log(
    `[orders] CLAIMED order ${shopifyOrderId} (status was → processing, claimedAt=${now.toISOString()})`,
  )

  // Pre-flight validation. Bad payloads are persisted as `rejected`
  // (not thrown) so the audit trail captures the reason and the
  // webhook still ACKs 200 to Shopify.
  const validation = validateShopifyOrder(order)
  if (!validation.ok) {
    log.warn('validation.rejected', {
      shopifyOrderId: order.id,
      code: validation.code,
      reason: validation.reason,
    })
    local.processingStatus = 'rejected'
    local.rejectionCode = validation.code
    local.processingError = validation.reason
    await local.save()
    return local
  }

  // Approval gate — wholesale customers must carry the "Approved" tag
  // before we touch QBO or NMI. Orders for unapproved customers are held
  // as `pending_approval` and auto-replayed by `replayPendingOrdersForCustomer`
  // when the admin approves them (admin/review.js).
  //
  // We fetch tags LIVE from Shopify (not the webhook payload) so a customer
  // approved between order creation and webhook processing is picked up
  // correctly. A tag-lookup failure throws and lands the order in `failed`,
  // which is reclaimable on the next attempt.
  const shopifyCustomerId = order.customer?.id ? String(order.customer.id) : null
  if (!shopifyCustomerId) {
    // No customer attached to the order (guest checkout / abandoned cart
    // recovery / staff-created without a customer). There's no one to
    // approve — reject definitively rather than holding indefinitely.
    console.log(`[orders] REJECTED — order has no customer; cannot verify wholesale approval`)
    log.warn('reject.no_customer', { shopifyOrderId })
    local.processingStatus = 'rejected'
    local.rejectionCode = 'NO_CUSTOMER_ID'
    local.processingError = 'Order has no customer attached; cannot verify wholesale approval'
    await local.save()
    return local
  }

  console.log(`[orders] approval gate — fetching tags for customer ${shopifyCustomerId}`)
  const approved = await customerHasApprovedTag({ shop, customerId: shopifyCustomerId })
  if (!approved) {
    console.log(
      `[orders] HOLD — customer ${shopifyCustomerId} is not approved; ` +
        `skipping QBO + NMI. Will auto-replay when "Approved" tag is added.`,
    )
    log.info('hold.not_approved', { shopifyOrderId, shopifyCustomerId })
    local.processingStatus = 'pending_approval'
    local.processingError = undefined
    await local.save()
    return local
  }
  console.log(`[orders] approval gate — customer ${shopifyCustomerId} is APPROVED, proceeding`)

  console.log(`\n========== Processing order ${order.id} (${order.name || ''}) for ${shop} ==========`)
  try {
    console.log(`[orders] step 1/4 — ensure customer in QBO + NMI`)
    const customerMap = await ensureCustomerForOrder({ shop, order })
    console.log(
      `[orders] customer ready — qboId=${customerMap.qboCustomerId} nmiVault=${customerMap.nmiCustomerVaultId || '(none)'}`,
    )
    local.processingStatus = 'customer_ready'
    await local.save()

    console.log(`[orders] step 2/4 — create QBO invoice`)
    const invoice = await createInvoiceForOrder({
      shop,
      order,
      localOrder: local,
      customerMap,
    })

    local.qboInvoiceId = invoice.qboInvoiceId
    local.invoiceRef = invoice._id
    local.processingStatus = 'invoiced'
    await local.save()

    // Step 3 — optional immediate NMI charge. Only cards are charged
    // automatically. Cheque / ACH invoices are held until an admin acts
    // from the Order Details page (mark received or fall back to card).
    if (paymentConfig.chargeImmediately && invoice.paymentMethod === 'card') {
      console.log(`[orders] step 3/4 — immediate NMI charge (PAYMENT_CHARGE_IMMEDIATELY=true, method=card)`)
      const chargeResult = await chargeInvoice({ invoice, customerMap })
      console.log(
        `[orders] immediate charge → outcome=${chargeResult.outcome || 'skipped'}` +
          (chargeResult.reason ? ` reason="${chargeResult.reason}"` : '') +
          (chargeResult.responseText ? ` text="${chargeResult.responseText}"` : ''),
      )
    } else if (invoice.paymentMethod !== 'card') {
      console.log(
        `[orders] step 3/4 — auto-charge skipped (paymentMethod=${invoice.paymentMethod}); ` +
          `awaiting admin action on Order Details page`,
      )
    } else {
      console.log(`[orders] step 3/4 — immediate charge disabled (scheduler-driven flow)`)
      console.log(
        `[orders] >>> invoice ${invoice.qboInvoiceId} ($${invoice.amountDue}) queued for scheduler — ` +
          `next tick will pick it up`,
      )
    }

    console.log(`[orders] step 4/4 — order marked as scheduled (scheduler owns payment retries)`)
    local.processingStatus = 'scheduled'
    local.processingError = undefined
    await local.save()

    console.log(
      `[orders] DONE order=${order.id} qboInvoice=${invoice.qboInvoiceId} status=${invoice.paymentStatus}`,
    )
    console.log('==================================================================\n')

    log.info('process.done', {
      shopifyOrderId: order.id,
      qboInvoiceId: invoice.qboInvoiceId,
    })
    return local
  } catch (err) {
    console.log(`[orders] FAILED order=${order.id}: ${err.message}`)
    console.error(err.stack || err)
    log.error('process.failed', { shopifyOrderId: order.id, err })
    local.processingStatus = 'failed'
    local.processingError = err.message
    await local.save()
    throw err
  }
}

// Replay every order held in `pending_approval` for a customer that was
// just approved. Triggered from admin/review.js after the "Approved" tag
// is added to the Shopify customer + the wholesale application is marked
// approved.
//
// Sequential — wholesale customers typically have a small backlog (one to
// a handful) and serial processing keeps NMI vault creation race-free
// (the first order creates the vault, subsequent orders reuse it).
//
// Each invocation goes through processShopifyOrder, so all the existing
// idempotency layers (atomic claim, claim-first invoice insert) still
// guard against double-processing if the admin clicks Approve twice.
//
// Returns a summary the caller can log; never throws (per-order failures
// are caught and recorded on the order doc).
export async function replayPendingOrdersForCustomer({ shop, email }) {
  if (!shop || !email) {
    return { total: 0, processed: 0, failed: 0, skipped: 0 }
  }
  const normalizedEmail = String(email).toLowerCase()
  const pending = await ShopifyOrder.find({
    shop,
    customerEmail: normalizedEmail,
    processingStatus: 'pending_approval',
  })
    .select('shopifyOrderId rawPayload')
    .lean()

  console.log(
    `[orders] replay — found ${pending.length} pending_approval order(s) for ${normalizedEmail}`,
  )
  log.info('replay.start', { shop, email: normalizedEmail, count: pending.length })

  let processed = 0
  let failed = 0
  let skipped = 0
  for (const row of pending) {
    if (!row.rawPayload) {
      console.warn(`[orders] replay skip — order ${row.shopifyOrderId} has no rawPayload`)
      skipped += 1
      continue
    }
    try {
      await processShopifyOrder({ shop, order: row.rawPayload })
      processed += 1
    } catch (err) {
      console.error(`[orders] replay failed for order ${row.shopifyOrderId}: ${err.message}`)
      log.error('replay.order_failed', { shop, shopifyOrderId: row.shopifyOrderId, err })
      failed += 1
    }
  }
  const summary = { total: pending.length, processed, failed, skipped }
  console.log(`[orders] replay done — ${JSON.stringify(summary)}`)
  log.info('replay.done', { shop, email: normalizedEmail, ...summary })
  return summary
}
