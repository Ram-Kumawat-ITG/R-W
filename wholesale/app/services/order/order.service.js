// Order processing orchestrator — the top-level driver that turns a
// Shopify orders/create webhook payload into a customer-ready, invoiced,
// scheduler-claimed local order.
//
// Idempotent + concurrency-safe. The full lifecycle is documented in
// INTEGRATIONS.md §5 (Order processing orchestrator).

import ShopifyOrder from '../../models/order.server'
import Invoice from '../../models/invoice.server'
import { ensureCustomerForOrder } from '../customer/customer.service'
import {
  createInvoiceForOrder,
  appendInvoiceRemark,
} from '../invoice/invoice.service'
import { chargeInvoice } from '../payment/payment.service'
import { validateShopifyOrder } from './order.validator'
import { paymentConfig } from '../payment/payment.config'
import { customerHasApprovedTag, getOrderFulfillments } from '../shopify/shopify.service'
import { voidInvoice as voidQboInvoice, setInvoiceShippingMemo } from '../qbo/qbo.service'
import {
  normalizeCarrier,
  carrierDisplayName,
  shipmentStatusLabel,
  resolveCarrierTrackingUrl,
} from '../../utils/shipping.constants'
import { trackingConfig } from './tracking.config'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('order.service')

// Statuses that mean "no work to redo" — re-deliveries return early.
const TERMINAL_STATUSES = new Set([
  'completed',
  'invoiced',
  'scheduled',
  'rejected',
  'cancelled',
])
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

    // Cancellation race guard — orders/cancelled webhook may have fired
    // while we were mid-creation. We use `cancelledAt` as the canary
    // (the create flow never writes it; the cancel webhook always
    // sets it), so even if our save() above overwrote the cancel
    // webhook's processingStatus='cancelled' back to 'invoiced',
    // cancelledAt is the truth. If we see it set, abort the rest of
    // processing, cancel the invoice we just created, and void it in
    // QBO (safe because no payments could have landed yet).
    const cancelCheck = await ShopifyOrder.findById(local._id)
      .select('cancelledAt cancelReason')
      .lean()
    if (cancelCheck?.cancelledAt) {
      console.log(
        `[orders] orders/cancelled overtook us mid-creation — invalidating the new invoice (reason="${cancelCheck.cancelReason || 'cancelled'}")`,
      )
      log.warn('cancel.during_creation', {
        shopifyOrderId,
        invoiceId: invoice._id.toString(),
        qboInvoiceId: invoice.qboInvoiceId,
      })
      invoice.paymentStatus = 'cancelled'
      await invoice.save()
      if (invoice.qboInvoiceId) {
        try {
          await voidQboInvoice(invoice.qboInvoiceId)
          console.log(`[orders] race-fix — voided just-created QBO invoice ${invoice.qboInvoiceId}`)
        } catch (qboErr) {
          console.error(`[orders] race-fix — QBO void failed: ${qboErr.message}`)
          log.error('cancel.race_void_failed', {
            invoiceId: invoice._id.toString(),
            qboInvoiceId: invoice.qboInvoiceId,
            err: qboErr,
          })
        }
      }
      // Restore the cancelled processingStatus our save() just overwrote.
      await ShopifyOrder.updateOne(
        { _id: local._id },
        { $set: { processingStatus: 'cancelled' } },
      )
      return await ShopifyOrder.findById(local._id)
    }

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

// Handle an orders/cancelled webhook. Upserts the ShopifyOrder to
// terminal state `cancelled`, transitions any linked Invoice to
// `cancelled`, and voids the QBO invoice when it has not yet received
// any payment.
//
// Idempotent + race-safe:
//   - seenWebhookIds[] dedup catches Shopify's at-least-once retries.
//   - The upsert means a cancelled webhook arriving BEFORE the
//     matching orders/create produces a `cancelled` doc immediately;
//     the create handler's TERMINAL_STATUSES pre-check returns early
//     when the late create re-delivery shows up.
//   - We never void a QBO invoice with money against it (amountPaid > 0)
//     — that would erase a real receipt. The local invoice is still
//     marked cancelled so the CRON skips it; the admin decides what
//     to do with the partial payment.
//
// `order` is Shopify's orders/cancelled payload — same shape as
// orders/create plus `cancelled_at` and `cancel_reason`.
export async function handleOrderCancelled({ shop, order, webhookId }) {
  if (!order?.id) throw new Error('handleOrderCancelled: order.id is required')
  const shopifyOrderId = String(order.id)

  console.log(
    `\n[orders] handleOrderCancelled shop=${shop} order=${shopifyOrderId} webhookId=${webhookId || '(none)'}`,
  )

  const shopifyCancelledAt = order.cancelled_at ? new Date(order.cancelled_at) : new Date()
  const cancelReason = order.cancel_reason || 'cancelled in Shopify'

  // ── 1. Dedup against the same webhook delivery ────────────────
  if (webhookId) {
    const dup = await ShopifyOrder.findOne({ shop, shopifyOrderId, seenWebhookIds: webhookId })
      .select('_id processingStatus')
      .lean()
    if (dup) {
      console.log(`[orders] DUPLICATE cancellation webhookId=${webhookId} — already handled`)
      log.info('cancel.skip.duplicate_webhook', { shopifyOrderId, webhookId })
      return await ShopifyOrder.findById(dup._id)
    }
  }

  // ── 2. Upsert the order doc to `cancelled` ─────────────────────
  //
  // Upsert covers the case where the cancellation webhook beats the
  // create webhook to our endpoint (a rare race when an order is
  // cancelled within seconds of creation). The $setOnInsert seeds
  // the minimum required fields; the $set overwrites lifecycle state.
  const update = {
    $setOnInsert: {
      shop,
      shopifyOrderId,
      receivedAt: new Date(),
    },
    $set: {
      processingStatus: 'cancelled',
      cancelledAt: shopifyCancelledAt,
      cancelReason,
      shopifyOrderName: order.name,
      shopifyOrderNumber: order.order_number,
      customerEmail:
        (order.email || order.customer?.email || '').toLowerCase() || undefined,
      shopifyCustomerId: order.customer?.id ? String(order.customer.id) : undefined,
      currency: order.currency,
      totalAmount: Number(order.total_price ?? 0),
      financialStatus: order.financial_status,
      fulfillmentStatus: 'cancelled',
      rawPayload: order,
    },
  }
  if (webhookId) {
    update.$addToSet = { seenWebhookIds: webhookId }
    update.$set.lastWebhookId = webhookId
  }
  const localOrder = await ShopifyOrder.findOneAndUpdate(
    { shop, shopifyOrderId },
    update,
    { upsert: true, new: true },
  )
  console.log(
    `[orders] order doc set processingStatus=cancelled reason="${cancelReason}" cancelledAt=${shopifyCancelledAt.toISOString()}`,
  )

  // ── 3. Cancel the linked Invoice (if any) + void in QBO ───────
  if (!localOrder.invoiceRef) {
    console.log(`[orders] no Invoice linked — nothing to cancel in QBO`)
    log.info('cancel.done', { shopifyOrderId, hadInvoice: false })
    return localOrder
  }

  const invoice = await Invoice.findById(localOrder.invoiceRef)
  if (!invoice) {
    console.log(`[orders] WARN — invoiceRef points to missing invoice`)
    log.warn('cancel.invoice_missing', { shopifyOrderId, invoiceRef: localOrder.invoiceRef })
    return localOrder
  }

  if (invoice.paymentStatus === 'cancelled') {
    console.log(`[orders] invoice already cancelled — nothing to do`)
    log.info('cancel.invoice_already_cancelled', { invoiceId: invoice._id.toString() })
    return localOrder
  }

  const hasPayments = Number(invoice.amountPaid || 0) > 0.005
  const wasPaid = invoice.paymentStatus === 'paid'

  // Local invoice: always flip to cancelled so the CRON skips it on
  // every subsequent tick. This is the authoritative "do not charge"
  // signal — true even for paid invoices, since the cancellation may
  // need a manual refund decision separately.
  const priorStatus = invoice.paymentStatus
  invoice.paymentStatus = 'cancelled'
  await invoice.save()
  console.log(`[orders] invoice ${invoice._id} status ${priorStatus} → cancelled`)
  log.info('cancel.invoice_cancelled', {
    invoiceId: invoice._id.toString(),
    priorStatus,
    amountPaid: invoice.amountPaid,
  })

  // QBO void: ONLY if no money has been received against the invoice.
  // Voiding an invoice with linked Payments would orphan / unbalance
  // the books. For paid or partially-paid invoices, leave the QBO
  // invoice alone — the admin makes the manual refund decision later.
  if (!invoice.qboInvoiceId) {
    console.log(`[orders] invoice has no qboInvoiceId — skipping QBO void`)
  } else if (hasPayments || wasPaid) {
    const msg =
      `QBO void skipped — invoice has $${(invoice.amountPaid || 0).toFixed(2)} in recorded payments. ` +
      `Refund the payments and void manually in QBO if needed.`
    console.warn(`[orders] ${msg}`)
    log.warn('cancel.qbo_void_skipped_has_payments', {
      invoiceId: invoice._id.toString(),
      qboInvoiceId: invoice.qboInvoiceId,
      amountPaid: invoice.amountPaid,
    })
    invoice.lastSyncError = msg
    await invoice.save()
  } else {
    try {
      const voided = await voidQboInvoice(invoice.qboInvoiceId)
      invoice.qboSyncToken = voided?.SyncToken || invoice.qboSyncToken
      await invoice.save()
      console.log(`[orders] QBO invoice ${invoice.qboInvoiceId} voided`)
      log.info('cancel.qbo_voided', {
        invoiceId: invoice._id.toString(),
        qboInvoiceId: invoice.qboInvoiceId,
      })
    } catch (qboErr) {
      const msg = `QBO void failed: ${qboErr.message}`
      console.error(`[orders] ${msg}`)
      log.error('cancel.qbo_void_failed', {
        invoiceId: invoice._id.toString(),
        qboInvoiceId: invoice.qboInvoiceId,
        err: qboErr,
      })
      invoice.lastSyncError = msg
      await invoice.save()
    }
  }

  // ── 4. Order Details remarks for the audit trail ──────────────
  await appendInvoiceRemark(invoice._id, {
    kind: 'system_note',
    message:
      `Shopify order cancelled (${cancelReason})` +
      (hasPayments
        ? ` — $${(invoice.amountPaid || 0).toFixed(2)} already paid; QBO invoice left intact for refund decision`
        : invoice.qboInvoiceId
          ? ' — QBO invoice voided'
          : ''),
    source: 'system',
    currency: invoice.currency,
  })

  console.log(`[orders] cancellation handling complete for order=${shopifyOrderId}\n`)
  return localOrder
}

// Write the order's shipping (carrier + tracking, one line per shipment) to
// the linked QBO invoice's CustomerMemo so it appears on the customer's
// invoice. Best-effort — a QBO failure must never break tracking capture.
// Called from both fulfillment paths whenever tracking changed. Idempotent:
// setInvoiceShippingMemo replaces the managed shipping block, so re-writing
// the same lines is a no-op for the customer-visible result.
async function pushShippingToInvoice(localOrder) {
  if (!localOrder?.invoiceRef) return
  let invoice
  try {
    invoice = await Invoice.findById(localOrder.invoiceRef).select('qboInvoiceId qboSyncToken')
  } catch {
    return
  }
  if (!invoice?.qboInvoiceId) return
  const lines = (localOrder.fulfillments || [])
    .filter((f) => f.trackingNumber || f.trackingCompany)
    .map((f) => {
      const carrier = carrierDisplayName(f.carrierKey, f.trackingCompany)
      const num = f.trackingNumber || 'no number'
      const statusLabel = shipmentStatusLabel(f.shipmentStatus || f.status)
      return `${carrier} — ${num}${statusLabel ? ` (${statusLabel})` : ''}`
    })
  if (!lines.length) return
  try {
    const updated = await setInvoiceShippingMemo({ qboInvoiceId: invoice.qboInvoiceId, lines })
    if (updated?.SyncToken && updated.SyncToken !== invoice.qboSyncToken) {
      await Invoice.updateOne({ _id: invoice._id }, { $set: { qboSyncToken: updated.SyncToken } })
    }
    console.log(`[orders] shipping synced to QBO invoice ${invoice.qboInvoiceId} (${lines.length} line(s))`)
  } catch (err) {
    log.warn('fulfillment.invoice_memo_failed', {
      invoiceId: String(localOrder.invoiceRef),
      err,
    })
  }
}

// Apply ONE normalized fulfillment to a (mutable) ShopifyOrder doc — the
// shared upsert used by BOTH the webhook path (handleFulfillmentUpdate) and
// the live-pull path (syncFulfillmentsFromShopify). Resolves the carrier +
// deep-link, upserts fulfillments[] by id, and appends a trackingHistory[]
// row only when a tracked field actually changed. Mutates `localOrder` in
// place; does NOT save. Returns { changed, isNew, carrierKey, trackingUrl }.
//
// `n` is the normalized shape (same from REST webhook or GraphQL pull):
//   { fulfillmentId, trackingNumber, trackingCompany, shopifyTrackingUrl,
//     shipmentStatus, status, fulfilledAt?, estimatedDeliveryAt? }
function applyFulfillmentToOrder(localOrder, n) {
  const carrierKey = normalizeCarrier(n.trackingCompany)
  const trackingUrl = resolveCarrierTrackingUrl({
    carrierKey,
    trackingNumber: n.trackingNumber,
    shopifyUrl: n.shopifyTrackingUrl,
    extraTemplates: trackingConfig.extraCarrierTemplates,
  })
  if (!Array.isArray(localOrder.fulfillments)) localOrder.fulfillments = []
  const now = new Date()
  const existing = localOrder.fulfillments.find((f) => f.fulfillmentId === n.fulfillmentId)
  const changed =
    !existing ||
    existing.trackingNumber !== n.trackingNumber ||
    existing.trackingCompany !== n.trackingCompany ||
    existing.shipmentStatus !== n.shipmentStatus ||
    existing.status !== n.status

  const fulfilledAt = n.fulfilledAt ? new Date(n.fulfilledAt) : undefined
  const estimatedDeliveryAt = n.estimatedDeliveryAt ? new Date(n.estimatedDeliveryAt) : undefined

  if (existing) {
    existing.trackingNumber = n.trackingNumber
    existing.trackingCompany = n.trackingCompany
    existing.carrierKey = carrierKey
    existing.trackingUrl = trackingUrl
    existing.shopifyTrackingUrl = n.shopifyTrackingUrl
    existing.shipmentStatus = n.shipmentStatus
    existing.status = n.status
    if (fulfilledAt) existing.fulfilledAt = fulfilledAt
    if (estimatedDeliveryAt) existing.estimatedDeliveryAt = estimatedDeliveryAt
    if (changed) existing.updatedAt = now
  } else {
    localOrder.fulfillments.push({
      fulfillmentId: n.fulfillmentId,
      trackingNumber: n.trackingNumber,
      trackingCompany: n.trackingCompany,
      carrierKey,
      trackingUrl,
      shopifyTrackingUrl: n.shopifyTrackingUrl,
      shipmentStatus: n.shipmentStatus,
      status: n.status,
      fulfilledAt,
      estimatedDeliveryAt,
      createdAt: now,
      updatedAt: now,
    })
  }

  if (changed) {
    if (!Array.isArray(localOrder.trackingHistory)) localOrder.trackingHistory = []
    localOrder.trackingHistory.push({
      at: now,
      fulfillmentId: n.fulfillmentId,
      trackingNumber: n.trackingNumber,
      trackingCompany: n.trackingCompany,
      carrierKey,
      shipmentStatus: n.shipmentStatus,
      event: existing ? 'updated' : 'created',
    })
    localOrder.trackingUpdatedAt = now
  }

  return { changed, isNew: !existing, carrierKey, trackingUrl }
}

// Handle a Shopify fulfillments/create or fulfillments/update webhook —
// capture the shipment tracking (carrier, number, status, deep-link) onto
// the local order. Mirrors handleOrderCancelled's shape: idempotent (dedup
// on seenWebhookIds[]), find-the-local-order, mutate, audit-remark.
//
// `fulfillment` is Shopify's Fulfillment payload — carries `order_id`,
// `tracking_number`/`tracking_numbers[]`, `tracking_company`,
// `tracking_url`/`tracking_urls[]`, `shipment_status`, `status`. No extra
// Shopify fetch needed. `event` is 'created' | 'updated' (for the history row
// label). Returns the local order, or null when we have no such order.
export async function handleFulfillmentUpdate({ shop, fulfillment, webhookId, event = 'updated' }) {
  if (!fulfillment?.id) throw new Error('handleFulfillmentUpdate: fulfillment.id is required')
  if (!fulfillment?.order_id) throw new Error('handleFulfillmentUpdate: fulfillment.order_id is required')
  const shopifyOrderId = String(fulfillment.order_id)
  const fulfillmentId = String(fulfillment.id)

  console.log(
    `\n[orders] handleFulfillmentUpdate shop=${shop} order=${shopifyOrderId} ` +
      `fulfillment=${fulfillmentId} event=${event} webhookId=${webhookId || '(none)'}`,
  )

  // ── 1. Dedup against the same webhook delivery ────────────────
  if (webhookId) {
    const dup = await ShopifyOrder.findOne({ shop, shopifyOrderId, seenWebhookIds: webhookId })
      .select('_id')
      .lean()
    if (dup) {
      console.log(`[orders] DUPLICATE fulfillment webhookId=${webhookId} — already handled`)
      log.info('fulfillment.skip.duplicate_webhook', { shopifyOrderId, fulfillmentId, webhookId })
      return await ShopifyOrder.findById(dup._id)
    }
  }

  // ── 2. Find the local order (must already be ingested) ────────
  const localOrder = await ShopifyOrder.findOne({ shop, shopifyOrderId })
  if (!localOrder) {
    // Tracking for an order we never ingested (e.g. created before this app,
    // or a non-wholesale order). Nothing to attach it to — log and ack.
    console.log(`[orders] no local order for ${shopifyOrderId} — skipping fulfillment tracking`)
    log.warn('fulfillment.no_local_order', { shop, shopifyOrderId, fulfillmentId })
    return null
  }

  // ── 3. Normalize the REST fulfillment payload + apply ─────────
  const normalized = {
    fulfillmentId,
    trackingNumber: fulfillment.tracking_number || fulfillment.tracking_numbers?.[0] || null,
    trackingCompany: fulfillment.tracking_company || null,
    shopifyTrackingUrl: fulfillment.tracking_url || fulfillment.tracking_urls?.[0] || null,
    shipmentStatus: fulfillment.shipment_status || null,
    status: fulfillment.status || null,
    fulfilledAt: fulfillment.created_at || null,
    estimatedDeliveryAt: fulfillment.estimated_delivery_at || null,
  }
  const { changed, isNew, carrierKey, trackingUrl } = applyFulfillmentToOrder(
    localOrder,
    normalized,
  )
  if (!changed) console.log(`[orders] fulfillment ${fulfillmentId} unchanged — no history row`)

  if (webhookId) {
    if (!localOrder.seenWebhookIds.includes(webhookId)) {
      localOrder.seenWebhookIds.push(webhookId)
    }
    localOrder.lastWebhookId = webhookId
  }
  await localOrder.save()

  console.log(
    `[orders] tracking ${isNew ? 'added' : 'updated'} — order=${shopifyOrderId} ` +
      `carrier=${carrierDisplayName(carrierKey, normalized.trackingCompany)} ` +
      `number=${normalized.trackingNumber || '(none)'} ` +
      `status=${normalized.shipmentStatus || normalized.status || '(none)'} ` +
      `url=${trackingUrl ? 'resolved' : '(none)'}`,
  )
  log.info('fulfillment.tracked', {
    shop,
    shopifyOrderId,
    fulfillmentId,
    carrierKey,
    trackingNumber: normalized.trackingNumber,
    shipmentStatus: normalized.shipmentStatus,
    changed,
  })

  // ── 4. Best-effort audit remark on the linked invoice ─────────
  if (changed && localOrder.invoiceRef) {
    try {
      const statusLabel = shipmentStatusLabel(normalized.shipmentStatus || normalized.status)
      await appendInvoiceRemark(localOrder.invoiceRef, {
        kind: 'system_note',
        source: 'system',
        message:
          `Tracking ${isNew ? 'added' : 'updated'}: ` +
          `${carrierDisplayName(carrierKey, normalized.trackingCompany)} ` +
          `${normalized.trackingNumber || '(no number)'}` +
          (statusLabel ? ` (${statusLabel})` : ''),
      })
    } catch (remarkErr) {
      // Audit remark is best-effort — never let it fail the tracking write.
      log.warn('fulfillment.remark_failed', { shopifyOrderId, err: remarkErr })
    }
  }

  // Mirror carrier + tracking onto the customer-facing QBO invoice memo.
  if (changed) await pushShippingToInvoice(localOrder)

  return localOrder
}

// Live-pull an order's fulfillments from Shopify Admin GraphQL and persist
// them onto the local order — the reliability fallback for when the
// fulfillments/* webhooks were missed or never subscribed, and for orders
// fulfilled before the subscription existed (webhooks don't backfill). The
// Order Details loader calls this (best-effort) so tracking renders on view
// regardless of webhook delivery. Reuses applyFulfillmentToOrder so the
// webhook and pull paths stay in lockstep. Returns the updated order as a
// plain object, or null if the order isn't found locally.
export async function syncFulfillmentsFromShopify({ shop, shopifyOrderId, admin }) {
  if (!shop || !shopifyOrderId) {
    throw new Error('syncFulfillmentsFromShopify: shop and shopifyOrderId are required')
  }
  const localOrder = await ShopifyOrder.findOne({ shop, shopifyOrderId })
  if (!localOrder) return null

  const data = await getOrderFulfillments({ admin, shop, shopifyOrderId })
  if (!data) return localOrder.toObject()

  let anyChanged = false
  for (const n of data.fulfillments || []) {
    if (!n.fulfillmentId) continue
    const { changed } = applyFulfillmentToOrder(localOrder, n)
    if (changed) anyChanged = true
  }
  // Mirror the order-level fulfillment status (FULFILLED / PARTIALLY_FULFILLED
  // / UNFULFILLED → lower-case) so the page can show "Fulfillment status".
  if (data.displayFulfillmentStatus) {
    const fs = String(data.displayFulfillmentStatus).toLowerCase()
    if (localOrder.fulfillmentStatus !== fs) {
      localOrder.fulfillmentStatus = fs
      anyChanged = true
    }
  }

  if (anyChanged) {
    await localOrder.save()
    console.log(
      `[orders] live-pull synced ${data.fulfillments?.length || 0} fulfillment(s) for order=${shopifyOrderId}`,
    )
    log.info('fulfillment.live_sync', {
      shop,
      shopifyOrderId,
      count: data.fulfillments?.length || 0,
    })
    // Mirror carrier + tracking onto the customer-facing QBO invoice memo.
    await pushShippingToInvoice(localOrder)
  }
  return localOrder.toObject()
}

