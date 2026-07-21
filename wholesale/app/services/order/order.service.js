// Order processing orchestrator — the top-level driver that turns a
// Shopify orders/create webhook payload into a customer-ready, invoiced,
// scheduler-claimed local order.
//
// Idempotent + concurrency-safe. The full lifecycle is documented in
// INTEGRATIONS.md §5 (Order processing orchestrator).

import ShopifyOrder from '../../models/order.server'
import Invoice from '../../models/invoice.server'
import { ensureCustomerForOrder, ensureDropshipCustomerMap } from '../customer/customer.service'
import {
  createInvoiceForOrder,
  appendInvoiceRemark,
  propagateSuccessfulPayment,
  dispatchInvoiceLifecycleEmails,
} from '../invoice/invoice.service'
import { toYmd, applyDerivedPaymentStatus } from '../invoice/invoice.utils'
import { chargeInvoice } from '../payment/payment.service'
import { validateShopifyOrder } from './order.validator'
import { paymentConfig } from '../payment/payment.config'
import { customerHasApprovedTag, customerHasBlockedTag, getOrderFulfillments } from '../shopify/shopify.service'
import { voidInvoice as voidQboInvoice, setInvoiceShipping } from '../qbo/qbo.service'
import {
  normalizeCarrier,
  carrierDisplayName,
  shipmentStatusLabel,
  resolveCarrierTrackingUrl,
} from '../../utils/shipping.constants'
import { trackingConfig } from './tracking.config'
import { isRetailCustomerEmail } from '../dropship/dropship.config'
import DropshipMapping from '../../models/dropshipMapping.server'
import { notifyRetailOfDropshipChange } from '../sync/fulfillmentSync.service'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('order.service')

// Statuses that mean "no work to redo" — re-deliveries return early.
const TERMINAL_STATUSES = new Set([
  'completed',
  'invoiced',
  'scheduled',
  'rejected',
  'cancelled',
  // Admin Orders (legacy retail drop-ship state) are terminal — kept for
  // orders ingested before drop-ship invoicing existed.
  'admin_order',
  // Drop-ship orders that have had their UNPAID QBO invoice created. Terminal
  // for the orchestrator (re-deliveries return the existing doc untouched);
  // the dedicated process-dropship-payments CRON drives them to `completed`.
  'dropship_invoiced',
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

  // Drop-ship short-circuit — orders placed by the retail drop-ship customer
  // (DROPSHIP_RETAIL_CUSTOMER_EMAIL) are NOT wholesale orders and skip the
  // wholesale approval gate + NMI-vault customer setup. Instead they get an
  // UNPAID QBO invoice immediately (right after the atomic claim, before the
  // approval gate / wholesale customer setup), and the dedicated
  // process-dropship-payments CRON collects payment later against the
  // configured DROPSHIP_NMI_VAULT_ID and records it in QBO. This runs on the
  // replay path too (replayPendingOrdersForCustomer → here). The order is
  // excluded from the wholesale Orders list (by email) and surfaces on the
  // dedicated Admin Orders page; its invoice is excluded from the wholesale
  // payment CRON (isDropship flag) and swept only by the dropship CRON.
  const orderEmail = order.email || order.customer?.email || ''
  if (isRetailCustomerEmail(orderEmail)) {
    return await invoiceDropshipOrder({ shop, order, local })
  }

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
  const [approved, blocked] = await Promise.all([
    customerHasApprovedTag({ shop, customerId: shopifyCustomerId }),
    customerHasBlockedTag({ shop, customerId: shopifyCustomerId }),
  ])

  if (blocked) {
    console.log(
      `[orders] HOLD — customer ${shopifyCustomerId} is blocked; ` +
        `skipping QBO + NMI until unblocked. Will resume when the Blocked tag is removed.`,
    )
    log.info('hold.blocked', { shopifyOrderId, shopifyCustomerId })
    local.processingStatus = 'pending_approval'
    local.processingError = 'Customer is blocked'
    await local.save()
    return local
  }

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

    // Step 3 — Practitioner prepaid short-circuit. Approved wholesale
    // customers who complete payment directly at Shopify checkout arrive
    // with financial_status='paid'. There is nothing left to collect —
    // the money landed in Shopify's ledger via checkout and the QBO
    // invoice was just created above. Skip the NMI charge entirely;
    // settle the invoice immediately and let propagateSuccessfulPayment
    // record the QBO Payment + mirror the completed state everywhere.
    if (order.financial_status === 'paid') {
      return await settlePrepaidOrder({ shop, order, local, invoice, customerMap })
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

// Settle a Practitioner Order that was already paid at Shopify checkout.
// Called from processShopifyOrder when order.financial_status === 'paid',
// after the approval gate and QBO invoice creation.
//
// What this does:
//   1. Marks the invoice fully paid (amountPaid = amountDue, paidAt = now).
//   2. Pre-marks shopifyMarkedPaid=true + shopifyRecordedTotal=amountDue so
//      propagateSuccessfulPayment skips posting a manual SALE transaction and
//      skips orderMarkAsPaid — both redundant because the payment already
//      landed in Shopify's ledger via the checkout flow.
//   3. Appends a system_note explaining the checkout-paid path.
//   4. Calls propagateSuccessfulPayment (transactionId=undefined) which
//      records the QBO Payment, updates ShopifyOrder to processingStatus=
//      'completed', and dispatches the lifecycle email re-send.
//
// The invoice is naturally excluded from the payment CRON after this:
//   PASS 1 filters paymentStatus:'pending' — a 'paid' invoice doesn't match.
//   PASS 2 backstops any partial QBO sync failure on the next tick.
//
// Admin Orders (drop-ship) and unapproved customers are unaffected — both
// are handled earlier in the pipeline before reaching this function.
async function settlePrepaidOrder({ shop, order, local, invoice, customerMap }) {
  const shopifyOrderId = String(order.id)
  const now = new Date()

  console.log(
    `[orders] PREPAID — order ${shopifyOrderId} paid at Shopify checkout ` +
      `(financial_status=${order.financial_status}); settling QBO invoice immediately.`,
  )
  try {
    // Mark the invoice as fully paid. Pre-set shopifyMarkedPaid + the
    // cumulative shopifyRecordedTotal to the full amount so the Shopify
    // sync step inside propagateSuccessfulPayment sees shopOwed=0 and
    // skips the redundant SALE transaction + orderMarkAsPaid — the
    // checkout payment already covers both.
    invoice.amountPaid = invoice.amountDue
    invoice.paidAt = now
    invoice.shopifyMarkedPaid = true
    invoice.shopifyMarkedPaidAt = now
    invoice.shopifyRecordedTotal = invoice.amountDue
    applyDerivedPaymentStatus(invoice) // → paymentStatus = 'paid'

    await appendInvoiceRemark(invoice._id, {
      kind: 'system_note',
      message:
        `Order paid at Shopify checkout (financial_status=${order.financial_status}); ` +
        `invoice settled immediately — no NMI charge required.`,
      source: 'system',
      currency: invoice.currency,
    })

    // Record the QBO Payment, update ShopifyOrder → completed, send email.
    // No NMI transaction id — the payment originated from Shopify checkout.
    await propagateSuccessfulPayment({ invoice, customerMap, transactionId: undefined })

    // propagateSuccessfulPayment set processingStatus='completed' on the
    // ShopifyOrder via findOneAndUpdate. Re-fetch so the returned doc
    // reflects the terminal state rather than the stale in-memory object.
    const updated = await ShopifyOrder.findById(local._id)

    console.log(
      `[orders] PREPAID DONE order=${shopifyOrderId} qboInvoice=${invoice.qboInvoiceId} ` +
        `paymentStatus=${invoice.paymentStatus}`,
    )
    log.info('prepaid.settled', {
      shopifyOrderId,
      qboInvoiceId: invoice.qboInvoiceId,
      invoiceId: invoice._id.toString(),
      amountDue: invoice.amountDue,
    })
    return updated || local
  } catch (err) {
    console.error(`[orders] PREPAID FAILED order=${shopifyOrderId}: ${err.message}`)
    console.error(err.stack || err)
    log.error('prepaid.failed', { shopifyOrderId, err })
    local.processingStatus = 'failed'
    local.processingError = err.message
    await local.save()
    throw err
  }
}

// Drop-ship order handler — orders placed by the retail drop-ship customer
// (DROPSHIP_RETAIL_CUSTOMER_EMAIL) get an UNPAID QBO invoice on creation; the
// dedicated process-dropship-payments CRON later charges the configured NMI
// vault (DROPSHIP_NMI_VAULT_ID) and records the QBO payment. This supersedes
// the old "Admin Order" diversion (which never invoiced these orders).
//
// Idempotent + concurrency-safe: createInvoiceForOrder does a claim-first
// insert against the unique (shop, shopifyOrderId) index, so concurrent
// webhook deliveries (or a replay) produce exactly one invoice. On any
// failure the order is left `failed` (reclaimable on the next delivery).
async function invoiceDropshipOrder({ shop, order, local }) {
  const shopifyOrderId = String(order.id)
  const orderEmail = order.email || order.customer?.email || ''
  console.log(
    `[orders] DROP-SHIP — ${shopifyOrderId} placed by retail drop-ship customer ` +
      `(${orderEmail}); creating UNPAID QBO invoice (collected via Admin Order Batch Payment UI).`,
  )
  try {
    const customerMap = await ensureDropshipCustomerMap({ shop, order })
    console.log(`[orders] drop-ship customer ready — qboId=${customerMap.qboCustomerId}`)

    // Resolve the retail order name from the dropship mapping so the QBO invoice
    // DocNumber uses the RS-#<retail> format (e.g. "RS-#1234") rather than the
    // wholesale order number. Best-effort — falls back to order.name if not found.
    const mapping = await DropshipMapping.findOne({ shop, wholesaleOrderId: shopifyOrderId })
      .select('retailOrderName')
      .lean()
    const retailOrderName = mapping?.retailOrderName || null
    console.log(
      `[orders] drop-ship mapping — wholesaleOrderId=${shopifyOrderId} retailOrderName=${retailOrderName || '(not found)'}`,
    )

    const invoice = await createInvoiceForOrder({
      shop,
      order,
      localOrder: local,
      customerMap,
      isDropship: true,
      retailOrderName,
    })

    local.qboInvoiceId = invoice.qboInvoiceId
    local.invoiceRef = invoice._id
    local.processingStatus = 'dropship_invoiced'
    local.processingError = undefined
    await local.save()

    // Cancellation race guard — mirror the wholesale path. If orders/cancelled
    // overtook us mid-creation, void the just-created (still UNPAID) invoice
    // and restore the cancelled status our save() above may have overwritten.
    const cancelCheck = await ShopifyOrder.findById(local._id)
      .select('cancelledAt cancelReason')
      .lean()
    if (cancelCheck?.cancelledAt) {
      console.log(
        `[orders] drop-ship — orders/cancelled overtook creation (reason="${cancelCheck.cancelReason || 'cancelled'}"); voiding new invoice`,
      )
      log.warn('dropship.cancel_during_creation', {
        shopifyOrderId,
        invoiceId: invoice._id.toString(),
        qboInvoiceId: invoice.qboInvoiceId,
      })
      invoice.paymentStatus = 'cancelled'
      await invoice.save()
      if (invoice.qboInvoiceId) {
        try {
          await voidQboInvoice(invoice.qboInvoiceId)
          console.log(`[orders] drop-ship race-fix — voided QBO invoice ${invoice.qboInvoiceId}`)
        } catch (qboErr) {
          console.error(`[orders] drop-ship race-fix — QBO void failed: ${qboErr.message}`)
          log.error('dropship.cancel_race_void_failed', {
            invoiceId: invoice._id.toString(),
            qboInvoiceId: invoice.qboInvoiceId,
            err: qboErr,
          })
        }
      }
      await ShopifyOrder.updateOne(
        { _id: local._id },
        { $set: { processingStatus: 'cancelled' } },
      )
      return await ShopifyOrder.findById(local._id)
    }

    console.log(
      `[orders] DROP-SHIP DONE order=${shopifyOrderId} qboInvoice=${invoice.qboInvoiceId} ` +
        `($${invoice.amountDue}) — UNPAID, queued for process-dropship-payments CRON`,
    )
    log.info('dropship.invoiced', {
      shopifyOrderId,
      qboInvoiceId: invoice.qboInvoiceId,
      invoiceId: invoice._id.toString(),
      amountDue: invoice.amountDue,
    })
    return local
  } catch (err) {
    console.error(`[orders] DROP-SHIP FAILED order=${shopifyOrderId}: ${err.message}`)
    console.error(err.stack || err)
    log.error('dropship.failed', { shopifyOrderId, err })
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

  // Mirror the cancellation onto the linked retail Shopify order (drop-ship
  // only; gated + deduped inside). Fired here — before the invoice/QBO work —
  // so it runs even for orders that never carried an invoice. Best-effort.
  try {
    await notifyRetailOfDropshipChange({ localOrder, event: 'cancelled' })
  } catch (err) {
    log.warn('cancel.retail_sync_failed', { shopifyOrderId, err })
  }

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
// invoice, then re-send the invoice email so the customer sees the latest
// tracking info. Best-effort — QBO or email failure must never break tracking
// capture. Called from both fulfillment paths whenever tracking changed.
// Idempotent: setInvoiceShipping replaces the managed shipping block, and
// dispatchInvoiceLifecycleEmails deduplicates on the shipDate/trackingNum
// snapshot so re-writing the same info is a no-op.
async function pushShippingToInvoice(localOrder) {
  if (!localOrder?.invoiceRef) return
  let invoice
  try {
    invoice = await Invoice.findById(localOrder.invoiceRef).select(
      'qboInvoiceId qboSyncToken customerEmail paymentStatus amountPaid ' +
        'invoiceEmailSentAt invoiceEmailLastSentAt invoiceEmailedStatus ' +
        'invoiceEmailedAmountPaid invoiceEmailedShipDate invoiceEmailedTrackingNum ' +
        'lastEmailError emailEvents',
    )
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
      const head = `${carrier} — ${num}${statusLabel ? ` (${statusLabel})` : ''}`
      // QBO's CustomerMemo is plain text (no rich hyperlinks), so include the
      // full tracking URL — most invoice-PDF / email clients auto-linkify a
      // bare URL, giving the customer a clickable tracking link on the doc.
      return f.trackingUrl ? `${head}\n  Track: ${f.trackingUrl}` : head
    })
  // Official Ship Date for the QBO invoice = the Shopify fulfillment date
  // (earliest shipment). Date-only (YYYY-MM-DD) to match QBO's ShipDate field.
  const shipDate = localOrder.shippedAt ? toYmd(localOrder.shippedAt) : undefined
  // Native QBO TrackingNum (renders in the header below Ship Date): carrier +
  // number per shipment, joined for multi-shipment orders.
  const trackingNum =
    (localOrder.fulfillments || [])
      .filter((f) => f.trackingNumber)
      .map((f) => `${carrierDisplayName(f.carrierKey, f.trackingCompany)} ${f.trackingNumber}`)
      .join(' | ') || undefined
  if (!lines.length && !shipDate && !trackingNum) return
  try {
    const updated = await setInvoiceShipping({
      qboInvoiceId: invoice.qboInvoiceId,
      lines,
      shipDate,
      trackingNum,
    })
    if (updated?.SyncToken) invoice.qboSyncToken = updated.SyncToken
    console.log(
      `[orders] shipping synced to QBO invoice ${invoice.qboInvoiceId} ` +
        `(${lines.length} line(s), shipDate=${shipDate || '(unchanged)'})`,
    )
  } catch (err) {
    log.warn('fulfillment.invoice_memo_failed', { invoiceId: String(localOrder.invoiceRef), err })
  }
  // Re-send the invoice email with updated shipping details. customerMap is
  // not available in this context — dispatchInvoiceLifecycleEmails falls back
  // to invoice.customerEmail automatically when customerMap is null.
  try {
    await dispatchInvoiceLifecycleEmails({
      invoice,
      customerMap: null,
      event: 'fulfillment',
      shipDate,
      trackingNum,
    })
  } catch (err) {
    log.warn('fulfillment.invoice_email_failed', { invoiceId: String(localOrder.invoiceRef), err })
  }
  // Single save persists both the QBO SyncToken and any email snapshot fields
  // mutated by dispatchInvoiceLifecycleEmails (emailEvents, invoiceEmailedShipDate, etc.).
  try {
    await invoice.save()
  } catch (err) {
    log.warn('fulfillment.invoice_save_failed', { invoiceId: String(localOrder.invoiceRef), err })
  }
}

// Recompute the order's official Ship Date = the EARLIEST fulfillment date
// across all shipments (when it first shipped). Mutates localOrder; returns
// true when the value changed (so callers know to persist).
function recomputeShipDate(localOrder) {
  const times = (localOrder.fulfillments || [])
    .map((f) => (f.fulfilledAt ? new Date(f.fulfilledAt).getTime() : NaN))
    .filter((t) => Number.isFinite(t))
  const earliest = times.length ? new Date(Math.min(...times)) : null
  const prev = localOrder.shippedAt ? new Date(localOrder.shippedAt).getTime() : null
  const next = earliest ? earliest.getTime() : null
  if (prev !== next) {
    localOrder.shippedAt = earliest
    return true
  }
  return false
}

// Recompute the order's official Delivery Date — set ONLY when every active
// (non-cancelled) shipment has a `deliveredAt`; the value is the LATEST of them
// (the moment the whole order became delivered). Null while any active shipment
// is still in flight. Mirrors recomputeShipDate. Mutates localOrder; returns
// true when the value changed (so callers know to persist + mirror to retail).
function recomputeDeliveredAt(localOrder) {
  const active = (localOrder.fulfillments || []).filter(
    (f) => String(f.status || '').toLowerCase() !== 'cancelled',
  )
  let next = null
  if (active.length) {
    const times = active.map((f) =>
      f.deliveredAt ? new Date(f.deliveredAt).getTime() : NaN,
    )
    if (times.every((t) => Number.isFinite(t))) next = new Date(Math.max(...times))
  }
  const prev = localOrder.deliveredAt ? new Date(localOrder.deliveredAt).getTime() : null
  const nextMs = next ? next.getTime() : null
  if (prev !== nextMs) {
    localOrder.deliveredAt = next
    return true
  }
  return false
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

  // Delivery milestone: stamp deliveredAt the first time the carrier status is
  // `delivered` (first-detection-wins — never overwritten on later re-syncs, so
  // the recorded delivery date is stable). Prefer the caller-supplied
  // observation time (the webhook's `updated_at`), else `now`.
  const isDelivered = String(n.shipmentStatus || '').toLowerCase() === 'delivered'
  const deliveredStamp = n.deliveredAt ? new Date(n.deliveredAt) : now

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
    if (isDelivered && !existing.deliveredAt) existing.deliveredAt = deliveredStamp
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
      deliveredAt: isDelivered ? deliveredStamp : undefined,
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
    // Best-available delivery-observation time — the fulfillment's last-updated
    // timestamp, which Shopify bumps when the carrier reports `delivered`.
    // applyFulfillmentToOrder only uses it when shipment_status is `delivered`.
    deliveredAt: fulfillment.updated_at || null,
  }
  const { changed, isNew, carrierKey, trackingUrl } = applyFulfillmentToOrder(
    localOrder,
    normalized,
  )
  recomputeShipDate(localOrder)
  recomputeDeliveredAt(localOrder)
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

  // Mirror the fulfillment status onto the linked retail Shopify order (only
  // for drop-ship orders; gated + deduped inside). Best-effort — never let a
  // retail-sync failure break tracking capture.
  if (changed) {
    try {
      await notifyRetailOfDropshipChange({ localOrder, event: 'fulfillment' })
    } catch (err) {
      log.warn('fulfillment.retail_sync_failed', { shopifyOrderId, err })
    }
  }

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
  //
  // MONOTONIC GUARD: never let a live re-read regress a fulfilled/delivered
  // order back to unfulfilled/partially_fulfilled. Shopify can transiently
  // report a lower displayFulfillmentStatus (order edit in flight, a drop-ship
  // order whose real shipment is tracked on the linked retail order, a stale
  // read), which previously wiped the delivered state the customer already saw
  // — the reported "reverts to Unfulfilled after Delivered" bug. `deliveredAt`
  // is stamped first-detection-wins and the fulfillments[] rows persist, so
  // together they are the durable "this order shipped/was delivered" signal.
  // Genuine reversals (restocked / returned) are still honored.
  if (data.displayFulfillmentStatus) {
    const fs = String(data.displayFulfillmentStatus).toLowerCase()
    const RANK = { unfulfilled: 0, partial: 1, partially_fulfilled: 1, fulfilled: 2 }
    const activeFf = (localOrder.fulfillments || []).filter(
      (f) => String(f.status || '').toLowerCase() !== 'cancelled',
    )
    const hasShipped = Boolean(localOrder.deliveredAt) || activeFf.length > 0
    const curRank = RANK[String(localOrder.fulfillmentStatus || '').toLowerCase()] ?? -1
    const nextRank = RANK[fs] ?? -1
    const isReversal = fs === 'restocked' || fs === 'returned'
    const wouldRegress = hasShipped && nextRank >= 0 && nextRank < curRank
    if (localOrder.fulfillmentStatus !== fs && (isReversal || !wouldRegress)) {
      localOrder.fulfillmentStatus = fs
      anyChanged = true
    }
  }
  if (recomputeShipDate(localOrder)) anyChanged = true
  if (recomputeDeliveredAt(localOrder)) anyChanged = true

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
  }
  // Mirror carrier + tracking + ship date onto the customer-facing QBO
  // invoice — even when fulfillment data didn't change this run, so the
  // native TrackingNum / ShipDate backfill onto invoices synced before those
  // fields were added. Idempotent: setInvoiceShipping no-ops when nothing
  // differs, so this doesn't write on every view once converged.
  if ((localOrder.fulfillments || []).length) {
    await pushShippingToInvoice(localOrder)
  }

  // Mirror onto the linked retail Shopify order when this pull changed
  // anything (drop-ship only; gated + deduped inside). Best-effort.
  if (anyChanged) {
    try {
      await notifyRetailOfDropshipChange({ localOrder, event: 'fulfillment' })
    } catch (err) {
      log.warn('fulfillment.retail_sync_failed', { shopifyOrderId, err })
    }
  }
  return localOrder.toObject()
}

