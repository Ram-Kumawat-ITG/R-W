import Invoice from '../../models/invoice.server'
import PaymentAttempt from '../../models/paymentAttempt.server'
import ShopifyOrder from '../../models/order.server'
import { createInvoice as createQboInvoice, recordPayment as recordQboPayment } from '../qbo/invoice.server'
import { chargeCustomerVault } from '../nmi/payment.server'
import { markShopifyOrderPaid } from '../shopify/orderUpdater.server'
import { retry } from '../retry.server'
import { config } from '../config.server'
import { createLogger } from '../logger.server'

const log = createLogger('invoice.service')

// Each downstream sync gets its own retry. Failures are isolated so one
// dead system doesn't block the others. PermanentError bypasses retry.
async function syncWithRetry(label, fn) {
  return retry(fn, {
    attempts: 3,
    baseMs: 500,
    onAttempt: ({ attempt, err, nextDelayMs }) => {
      console.warn(`[sync] ${label} attempt ${attempt} failed (next in ${nextDelayMs}ms): ${err.message}`)
    },
  })
}

// Convert Shopify line_items to QBO invoice lines.
function shopifyLinesToQboLines(order) {
  const lines = []
  for (const item of order.line_items || []) {
    const qty = Number(item.quantity ?? 1)
    const unitPrice = Number(item.price ?? 0)
    const amount = Number((qty * unitPrice).toFixed(2))
    if (!Number.isFinite(amount) || amount <= 0) continue
    lines.push({
      description: item.title || item.name || `Item ${item.id}`,
      quantity: qty,
      unitPrice,
      amount,
    })
  }
  const shippingTotal = Number(order.total_shipping_price_set?.shop_money?.amount || 0)
  if (shippingTotal > 0) {
    lines.push({
      description: 'Shipping',
      quantity: 1,
      unitPrice: shippingTotal,
      amount: shippingTotal,
    })
  }
  const taxTotal = Number(order.total_tax || 0)
  if (taxTotal > 0) {
    lines.push({
      description: 'Tax',
      quantity: 1,
      unitPrice: taxTotal,
      amount: taxTotal,
    })
  }
  if (lines.length === 0) {
    // Fallback so we still produce a balanced invoice even if Shopify
    // sent an unusual payload.
    lines.push({
      description: `Order ${order.name || order.id}`,
      quantity: 1,
      unitPrice: Number(order.total_price ?? 0),
      amount: Number(order.total_price ?? 0),
    })
  }
  return lines
}

// Maximum time we wait for a concurrent claimer to finish the QBO call
// before we give up and throw.
const CLAIM_WAIT_MS = 30_000
const CLAIM_POLL_MS = 500

export async function createInvoiceForOrder({ shop, order, localOrder, customerMap }) {
  const shopifyOrderId = String(order.id)

  // Phase 1 — ATOMIC CLAIM via unique-index protected insert.
  //
  // We insert the Invoice row BEFORE calling QBO. The unique
  // (shop, shopifyOrderId) index acts as the lock: only one worker
  // succeeds insert; everyone else gets E11000 and waits/reuses.
  //
  // This is the critical fix for duplicate QBO invoices — the previous
  // ordering (QBO POST → Invoice insert) let two workers each call QBO
  // before either inserted.
  console.log(`[invoice] phase 1 — claiming Invoice slot for shop=${shop} order=${shopifyOrderId}`)
  let invoice
  try {
    invoice = await Invoice.create({
      shop,
      orderRef: localOrder._id,
      shopifyOrderId,
      customerMapRef: customerMap._id,
      customerEmail: customerMap.email,
      currency: order.currency || 'USD',
      amountDue: Number(order.total_price ?? 0), // placeholder, refined after QBO POST returns
      paymentStatus: 'pending',
      maxAttempts: config.payments.maxRetryAttempts,
      qboCreationStatus: 'claimed',
      qboCreationClaimedAt: new Date(),
    })
    console.log(`[invoice] CLAIMED Invoice _id=${invoice._id} — this worker owns the QBO call`)
  } catch (err) {
    if (err?.code === 11000) {
      // Another worker beat us to the claim. Reuse / wait for theirs.
      console.log(`[invoice] LOST CLAIM RACE — another worker owns this order; reusing their Invoice`)
      log.info('create.claim_lost', { shopifyOrderId })
      return await waitForClaimToComplete(shop, shopifyOrderId)
    }
    throw err
  }

  // Phase 2 — call QBO with the lock held.
  console.log(`[invoice] phase 2 — calling QBO createInvoice (we hold the claim)`)
  const lines = shopifyLinesToQboLines(order)
  let qboInvoice
  try {
    qboInvoice = await createQboInvoice({
      qboCustomerId: customerMap.qboCustomerId,
      currency: order.currency || 'USD',
      lines,
      memo: `Shopify order ${order.name || order.id}`,
      docNumber: order.name?.replace(/^#/, '') || shopifyOrderId,
    })
  } catch (qboErr) {
    // QBO call failed — mark the claim as failed so a re-run can
    // either retry or void it. We keep the Invoice row (with the
    // unique slot) so no one tries to claim again concurrently.
    console.error(`[invoice] QBO createInvoice FAILED for order ${shopifyOrderId}: ${qboErr.message}`)
    invoice.qboCreationStatus = 'failed'
    invoice.qboCreationError = qboErr.message
    await invoice.save()
    log.error('create.qbo_failed', { invoiceId: invoice._id.toString(), shopifyOrderId, err: qboErr })
    throw qboErr
  }

  // Phase 3 — write the QBO ids onto the claimed row.
  invoice.qboInvoiceId = qboInvoice.Id
  invoice.qboDocNumber = qboInvoice.DocNumber
  invoice.qboSyncToken = qboInvoice.SyncToken
  invoice.amountDue = Number(qboInvoice.TotalAmt ?? invoice.amountDue)
  invoice.currency = qboInvoice.CurrencyRef?.value || invoice.currency
  invoice.qboCreationStatus = 'created'
  invoice.qboCreationError = undefined
  await invoice.save()

  console.log(
    `[invoice] CREATED Invoice _id=${invoice._id} qboInvoiceId=${invoice.qboInvoiceId} ` +
      `amountDue=${invoice.amountDue} status=pending`,
  )
  log.info('create.success', {
    invoiceId: invoice._id.toString(),
    qboInvoiceId: invoice.qboInvoiceId,
    amountDue: invoice.amountDue,
  })
  return invoice
}

// When we lose the claim race, the winning worker is still mid-flight
// to QBO. Poll briefly until they finish so the caller gets a fully-
// populated Invoice (with qboInvoiceId) — rather than a half-claimed one.
async function waitForClaimToComplete(shop, shopifyOrderId) {
  const deadline = Date.now() + CLAIM_WAIT_MS
  while (Date.now() < deadline) {
    const existing = await Invoice.findOne({ shop, shopifyOrderId })
    if (!existing) {
      // Edge case: claimant rolled back. Caller should retry.
      throw new Error(`Invoice slot was claimed then disappeared for order ${shopifyOrderId}`)
    }
    if (existing.qboCreationStatus === 'created' || existing.qboInvoiceId) {
      console.log(
        `[invoice] claim complete — reusing Invoice _id=${existing._id} qboInvoiceId=${existing.qboInvoiceId}`,
      )
      return existing
    }
    if (existing.qboCreationStatus === 'failed') {
      // The winning worker failed at QBO. Surface so the caller can
      // mark the order failed; do NOT retry QBO ourselves — that's
      // a job for explicit operator action to avoid double-billing.
      throw new Error(
        `Concurrent worker's QBO create failed: ${existing.qboCreationError || 'unknown'}`,
      )
    }
    // Still 'claimed' — give them another moment.
    await new Promise((r) => setTimeout(r, CLAIM_POLL_MS))
  }
  throw new Error(`Timed out waiting for concurrent claim to complete on order ${shopifyOrderId}`)
}

// Attempt a single NMI charge against the invoice's outstanding balance.
// Caller is responsible for picking which invoices are eligible — this
// function only mutates the single invoice it's given.
export async function attemptInvoiceCharge({ invoice, customerMap }) {
  if (invoice.paymentStatus === 'paid' || invoice.paymentStatus === 'cancelled') {
    return { skipped: true, reason: `invoice already ${invoice.paymentStatus}` }
  }
  if (invoice.attemptCount >= invoice.maxAttempts) {
    return { skipped: true, reason: 'max attempts reached' }
  }
  if (!customerMap?.nmiCustomerVaultId) {
    const attemptNumber = invoice.attemptCount + 1
    await PaymentAttempt.create({
      invoiceRef: invoice._id,
      qboInvoiceId: invoice.qboInvoiceId,
      attemptNumber,
      amount: invoice.amountDue - invoice.amountPaid,
      currency: invoice.currency,
      outcome: 'skipped',
      errorMessage: 'no NMI customer vault on file',
    })
    invoice.attemptCount = attemptNumber
    invoice.lastAttemptAt = new Date()
    invoice.lastAttemptError = 'no NMI customer vault on file'
    if (invoice.attemptCount >= invoice.maxAttempts) invoice.paymentStatus = 'failed'
    await invoice.save()
    return { skipped: true, reason: 'no NMI customer vault on file' }
  }

  // Mark in-flight so two concurrent jobs don't both charge the same card.
  // We rely on the document version to detect concurrent updates.
  invoice.paymentStatus = 'in_progress'
  await invoice.save()

  const amount = Number((invoice.amountDue - invoice.amountPaid).toFixed(2))
  const attemptNumber = invoice.attemptCount + 1
  let result
  try {
    result = await chargeCustomerVault({
      customerVaultId: customerMap.nmiCustomerVaultId,
      amount,
      currency: invoice.currency,
      orderId: invoice.shopifyOrderId,
      invoiceNumber: invoice.qboDocNumber || invoice.qboInvoiceId,
    })
  } catch (err) {
    log.error('charge.threw', { invoiceId: invoice._id.toString(), err })
    await PaymentAttempt.create({
      invoiceRef: invoice._id,
      qboInvoiceId: invoice.qboInvoiceId,
      attemptNumber,
      amount,
      currency: invoice.currency,
      outcome: 'error',
      errorMessage: err.message,
    })
    invoice.attemptCount = attemptNumber
    invoice.lastAttemptAt = new Date()
    invoice.lastAttemptError = err.message
    invoice.paymentStatus = invoice.attemptCount >= invoice.maxAttempts ? 'failed' : 'pending'
    await invoice.save()
    return { skipped: false, outcome: 'error', error: err.message }
  }

  await PaymentAttempt.create({
    invoiceRef: invoice._id,
    qboInvoiceId: invoice.qboInvoiceId,
    attemptNumber,
    amount,
    currency: invoice.currency,
    outcome: result.outcome,
    nmiTransactionId: result.transactionId,
    nmiResponseCode: result.responseCode,
    nmiResponseText: result.responseText,
    nmiAuthCode: result.authCode,
    nmiAvsResponse: result.avsResponse,
    nmiCvvResponse: result.cvvResponse,
    rawResponse: result.raw,
  })

  invoice.attemptCount = attemptNumber
  invoice.lastAttemptAt = new Date()
  invoice.lastAttemptError = result.outcome === 'approved' ? null : result.responseText

  if (result.outcome === 'approved') {
    invoice.amountPaid = Number((invoice.amountPaid + amount).toFixed(2))
    invoice.paidAt = new Date()
    invoice.paymentStatus = invoice.amountPaid >= invoice.amountDue ? 'paid' : 'pending'

    await propagateSuccessfulPayment({
      invoice,
      customerMap,
      amount,
      transactionId: result.transactionId,
    })
  } else {
    invoice.paymentStatus = invoice.attemptCount >= invoice.maxAttempts ? 'failed' : 'pending'
  }
  await invoice.save()

  return {
    skipped: false,
    outcome: result.outcome,
    transactionId: result.transactionId,
    responseText: result.responseText,
  }
}

// Propagate a successful NMI payment to QBO, Shopify, and the local
// shopify_orders doc. Each side has its own per-side flag on the
// invoice so this function is safe to call multiple times — already-
// synced sides are skipped, only the failed sides are retried.
//
// Exported so the scheduler can drive sync-only retries when a previous
// charge succeeded but a downstream sync failed.
export async function propagateSuccessfulPayment({ invoice, customerMap, amount, transactionId }) {
  console.log(`\n[sync] propagating successful payment for invoice _id=${invoice._id}`)
  console.log(
    `[sync]   state — qboPaymentRecorded=${invoice.qboPaymentRecorded} shopifyMarkedPaid=${invoice.shopifyMarkedPaid}`,
  )
  const syncErrors = []

  // ── 1) QBO: record payment against the invoice ────────────────
  if (!invoice.qboPaymentRecorded) {
    try {
      const qboPayment = await syncWithRetry('qbo.record_payment', () =>
        recordQboPayment({
          qboCustomerId: customerMap.qboCustomerId,
          qboInvoiceId: invoice.qboInvoiceId,
          amount,
          currency: invoice.currency,
          paymentRef: transactionId,
        }),
      )
      invoice.qboPaymentRecorded = true
      invoice.qboPaymentId = qboPayment?.Id
      console.log(`[sync] QBO   ✓ payment recorded id=${qboPayment?.Id}`)
      log.info('sync.qbo.recorded', { invoiceId: invoice._id.toString(), qboPaymentId: qboPayment?.Id })
    } catch (qboErr) {
      const msg = `QBO payment record failed after NMI success: ${qboErr.message}`
      console.error(`[sync] QBO   ✗ ${msg}`)
      log.error('sync.qbo.failed', { invoiceId: invoice._id.toString(), err: qboErr })
      syncErrors.push(msg)
    }
  } else {
    console.log(`[sync] QBO   • already recorded (id=${invoice.qboPaymentId})`)
  }

  // ── 2) Shopify: mark order as paid ────────────────────────────
  if (!invoice.shopifyMarkedPaid) {
    try {
      const shopRes = await syncWithRetry('shopify.mark_paid', () =>
        markShopifyOrderPaid({
          shop: invoice.shop,
          shopifyOrderId: invoice.shopifyOrderId,
        }),
      )
      invoice.shopifyMarkedPaid = true
      invoice.shopifyMarkedPaidAt = new Date()
      console.log(`[sync] SHOP  ✓ order marked paid (status=${shopRes?.financialStatus})`)
      log.info('sync.shopify.marked_paid', {
        invoiceId: invoice._id.toString(),
        shopifyOrderId: invoice.shopifyOrderId,
        alreadyPaid: shopRes?.alreadyPaid,
      })
    } catch (shopErr) {
      const msg = `Shopify orderMarkAsPaid failed after NMI success: ${shopErr.message}`
      console.error(`[sync] SHOP  ✗ ${msg}`)
      log.error('sync.shopify.failed', {
        invoiceId: invoice._id.toString(),
        shopifyOrderId: invoice.shopifyOrderId,
        err: shopErr,
      })
      syncErrors.push(msg)
    }
  } else {
    console.log(`[sync] SHOP  • already marked paid at ${invoice.shopifyMarkedPaidAt?.toISOString()}`)
  }

  // ── 3) ShopifyOrder local doc: mirror final payment state ──────
  try {
    const update = {
      paymentStatus: invoice.paymentStatus, // 'paid' or still 'pending' for partial
      financialStatus: invoice.paymentStatus === 'paid' ? 'paid' : 'partially_paid',
    }
    if (transactionId) update.nmiTransactionId = transactionId
    if (invoice.paymentStatus === 'paid') {
      update.paidAt = invoice.paidAt
      update.processingStatus = 'completed'
      update.completedAt = new Date()
    }
    if (invoice.shopifyMarkedPaid) update.shopifyPaidSyncedAt = invoice.shopifyMarkedPaidAt
    const updated = await ShopifyOrder.findOneAndUpdate(
      { _id: invoice.orderRef },
      { $set: update },
      { new: true },
    )
    console.log(
      `[sync] DB    ✓ shopify_orders _id=${updated?._id} ` +
        `paymentStatus=${updated?.paymentStatus} financialStatus=${updated?.financialStatus} ` +
        `processingStatus=${updated?.processingStatus}`,
    )
    log.info('sync.local.updated', {
      invoiceId: invoice._id.toString(),
      orderId: updated?._id?.toString(),
      paymentStatus: updated?.paymentStatus,
    })
  } catch (dbErr) {
    const msg = `Local shopify_orders update failed: ${dbErr.message}`
    console.error(`[sync] DB    ✗ ${msg}`)
    log.error('sync.local.failed', { invoiceId: invoice._id.toString(), err: dbErr })
    syncErrors.push(msg)
  }

  invoice.lastSyncError = syncErrors.length ? syncErrors.join(' | ') : undefined
  if (syncErrors.length) {
    console.warn(`[sync] completed with ${syncErrors.length} sync error(s) — see invoice.lastSyncError`)
  } else {
    console.log(`[sync] all systems in sync ✓`)
  }
  await invoice.save()
  return { syncErrors }
}
