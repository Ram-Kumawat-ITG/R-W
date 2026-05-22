// Invoice service — creation + downstream sync.
//
// Three operations live here:
//   1. createInvoiceForOrder — claim-first QBO invoice creation, the
//      structural duplicate-invoice guard
//   2. propagateSuccessfulPayment — sync a successful charge to QBO,
//      Shopify, and the local shopify_orders doc (idempotent per-side)
//   3. waitForClaimToComplete — internal helper for losing concurrent
//      workers to wait for the winner's QBO call
//
// The actual NMI charge attempt lives in services/payment/payment.service.js.

import Invoice from '../../models/invoice.server'
import ShopifyOrder from '../../models/order.server'
import PaymentAttempt from '../../models/paymentAttempt.server'
import {
  createInvoice as createQboInvoice,
  recordPayment as recordQboPayment,
  appendInvoiceLines as appendQboInvoiceLines,
  getInvoice as getQboInvoice,
} from '../qbo/qbo.service'
import { markShopifyOrderPaid } from '../shopify/shopify.service'
import { paymentConfig } from '../payment/payment.config'
import { invoiceConfig } from './invoice.config'
import {
  syncWithRetry,
  shopifyLinesToQboLines,
  computeInvoiceDueDate,
  toYmd,
  computeProcessingFee,
  buildProcessingFeeLine,
  findExistingProcessingFeeLine,
} from './invoice.utils'
import { buildProfileFromShopifyOrder } from '../customer/customer.utils'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('invoice.service')

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
      // Lock the payment method at invoice creation. Cheque/ACH invoices
      // are skipped by the CRON scheduler; only 'card' is auto-charged.
      // `paymentMethod` is the active/operational method — the cheque →
      // card admin fallback flips it. `customerPaymentPreference` is
      // the immutable order-time snapshot; even if the customer changes
      // their preference later, this stays. Both start equal.
      paymentMethod: customerMap.paymentMethod || 'card',
      customerPaymentPreference: customerMap.paymentMethod || 'card',
      paymentStatus: 'pending',
      maxAttempts: paymentConfig.maxRetryAttempts,
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
  // No processing-fee line at creation — the fee is appended at
  // settlement time, with the rate selected by the actual settlement
  // method (card / ach / check). This keeps the fee tied to the real
  // method used to settle, including the cheque → card admin fallback
  // and ACH receipts. See propagateSuccessfulPayment + recordManual-
  // Payment for the append flow.
  const lines = shopifyLinesToQboLines(order)
  // Due date = order date + termsDays. Sending DueDate explicitly makes
  // us the source of truth and overrides any QBO customer-level
  // SalesTerm. Falls back to localOrder.receivedAt if Shopify's
  // created_at is missing; if both are unparseable, we omit DueDate
  // and let QBO compute it from its own defaults.
  const orderDateBasis = order?.created_at || localOrder?.receivedAt
  const dueDate = computeInvoiceDueDate(orderDateBasis, invoiceConfig.termsDays)
  console.log(
    `[invoice] dueDate = ${dueDate || '(QBO default)'} ` +
      `(order date ${orderDateBasis || '(unknown)'} + ${invoiceConfig.termsDays} days)`,
  )
  // Ship-to fields. Address uses the same shipping → billing → customer
  // default fallback as the customer sync (buildProfileFromShopifyOrder) so
  // the invoice still ships somewhere on pickup/digital orders with no
  // shipping_address. ShipDate is the order date — Shopify's orders/create
  // fires pre-fulfillment so we use created_at as the invoice's ship-on date.
  const shipAddr = buildProfileFromShopifyOrder(order).shippingAddress
  const shipDate = toYmd(orderDateBasis)
  console.log(
    `[invoice] shipDate = ${shipDate || '(none)'} shipAddr = ${shipAddr ? 'present' : '(none)'}`,
  )
  let qboInvoice
  try {
    qboInvoice = await createQboInvoice({
      qboCustomerId: customerMap.qboCustomerId,
      currency: order.currency || 'USD',
      lines,
      memo: `Shopify order ${order.name || order.id}`,
      docNumber: order.name?.replace(/^#/, '') || shopifyOrderId,
      dueDate,
      shipAddr,
      shipDate,
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
  invoice.qboDueDate = qboInvoice.DueDate || undefined
  invoice.qboTxnDate = qboInvoice.TxnDate || undefined
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

// Propagate a successful NMI payment to QBO, Shopify, and the local
// shopify_orders doc. Each side has its own per-side flag on the
// invoice so this function is safe to call multiple times — already-
// synced sides are skipped, only the failed sides are retried.
//
// Called from payment.service.js after an approved NMI charge, and
// directly from the scheduler's PASS 2 when a previous charge succeeded
// but a downstream sync failed.
export async function propagateSuccessfulPayment({ invoice, customerMap, amount, transactionId }) {
  console.log(`\n[sync] propagating successful payment for invoice _id=${invoice._id}`)
  console.log(
    `[sync]   state — qboPaymentRecorded=${invoice.qboPaymentRecorded} shopifyMarkedPaid=${invoice.shopifyMarkedPaid}`,
  )
  const syncErrors = []

  // ── 0) QBO: append processing-fee line (if owed) ──────────────
  //
  // Runs BEFORE recordPayment because the recorded payment amount has
  // to match the invoice's TotalAmt; without the fee line, QBO would
  // see a $103 payment against a $100 invoice and create a customer
  // credit. processingFeeAmount > 0 && !processingFeeAppliedAt means
  // chargeInvoice / recordManualPayment staged the fee but QBO hasn't
  // been told yet.
  //
  // If this step fails, we skip recordPayment too and surface the
  // error — scheduler PASS 2 retries both on the next tick. Defensive
  // idempotency via findExistingProcessingFeeLine handles the case
  // where a prior run wrote the line but crashed before flipping the
  // local flag.
  const feePending = invoice.processingFeeAmount > 0 && !invoice.processingFeeAppliedAt
  let feeReady = !feePending
  if (feePending) {
    try {
      const updated = await syncWithRetry('qbo.append_processing_fee', async () => {
        const current = await getQboInvoice(invoice.qboInvoiceId)
        const existing = findExistingProcessingFeeLine(current?.Line)
        if (existing) {
          console.log(
            `[sync] QBO   • fee line already on invoice (LineId=${existing.Id || '?'}) — adopting`,
          )
          return current
        }
        const line = buildProcessingFeeLine({
          amount: invoice.processingFeeAmount,
          rate: invoice.processingFeeRate,
          method: invoice.processingFeeMethod,
        })
        if (!line) {
          throw new Error('processing-fee line builder returned null — bad rate or amount')
        }
        return appendQboInvoiceLines({
          qboInvoiceId: invoice.qboInvoiceId,
          newLines: [line],
        })
      })
      invoice.qboSyncToken = updated?.SyncToken || invoice.qboSyncToken
      invoice.processingFeeAppliedAt = new Date()
      feeReady = true
      console.log(
        `[sync] QBO   ✓ ${invoice.processingFeeMethod} fee $${invoice.processingFeeAmount.toFixed(2)} appended ` +
          `(SyncToken=${invoice.qboSyncToken})`,
      )
      log.info('sync.qbo.fee_appended', {
        invoiceId: invoice._id.toString(),
        amount: invoice.processingFeeAmount,
        rate: invoice.processingFeeRate,
        method: invoice.processingFeeMethod,
      })
    } catch (feeErr) {
      const msg = `QBO processing-fee append failed: ${feeErr.message}`
      console.error(`[sync] QBO   ✗ ${msg}`)
      log.error('sync.qbo.fee_failed', { invoiceId: invoice._id.toString(), err: feeErr })
      syncErrors.push(msg)
    }
  } else if (invoice.processingFeeAppliedAt) {
    console.log(
      `[sync] QBO   • ${invoice.processingFeeMethod || 'processing'} fee already applied ` +
        `at ${invoice.processingFeeAppliedAt.toISOString()}`,
    )
  }

  // ── 1) QBO: record payment against the invoice ────────────────
  if (!invoice.qboPaymentRecorded) {
    if (!feeReady) {
      const msg =
        'QBO recordPayment skipped — processing-fee line not yet on invoice; recording ' +
        'payment now would leave the invoice out of balance'
      console.warn(`[sync] QBO   ⤳ ${msg}`)
      log.warn('sync.qbo.record_skipped', {
        invoiceId: invoice._id.toString(),
        reason: 'fee_pending',
      })
      syncErrors.push(msg)
    } else {
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

// Record a manual (non-NMI) payment against an invoice — admin clicks
// "Mark cheque paid" on the Order Details page. Appends a manualPayments
// ledger entry + an audit PaymentAttempt row, mutates the invoice's
// amountPaid / paymentStatus, then runs the same propagateSuccessfulPayment
// path that an approved NMI charge would (so QBO records the payment and
// Shopify marks the order paid). The cheque reference is forwarded to
// QBO as the paymentRef so it shows up on the QBO payment record.
//
// Returns { invoice, attempt, syncErrors }. Throws PermanentError-style
// Errors on validation problems (caller maps to HTTP 4xx).
export async function recordManualPayment({
  invoice,
  customerMap,
  kind = 'cheque',
  reference,
  amount,
  receivedAt,
  recordedBy,
  note,
}) {
  if (invoice.paymentStatus === 'paid' || invoice.paymentStatus === 'cancelled') {
    throw new Error(`Invoice is already ${invoice.paymentStatus}`)
  }
  if (invoice.paymentStatus === 'in_progress') {
    throw new Error('A charge is currently in progress for this invoice')
  }
  if (!reference || !String(reference).trim()) {
    throw new Error('Cheque reference is required')
  }

  // Per-method processing fee. For manual ACH receipts (kind='ach'),
  // the customer is expected to send (base + 1%) — the admin records
  // the inflated amount, which equals the new outstanding once the fee
  // line lands on QBO. For cheque receipts (kind='cheque'), no fee.
  // The fee is applied at most once per invoice — once
  // processingFeeAppliedAt is set, this call accepts the existing
  // amountDue (already inflated) without re-adding.
  const baseOutstanding = Number((invoice.amountDue - invoice.amountPaid).toFixed(2))
  // kind='cheque' corresponds to the 'check' method in our config.
  const feeMethod = kind === 'ach' ? 'ach' : 'check'
  const feePreview =
    !invoice.processingFeeAppliedAt &&
    computeProcessingFee({
      baseAmount: baseOutstanding,
      method: feeMethod,
      rates: invoiceConfig.processingFeeRates,
    })
  const feeAmount = feePreview ? feePreview.amount : 0
  const outstanding = Number((baseOutstanding + feeAmount).toFixed(2))

  const amt = amount != null ? Number(amount) : outstanding
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error('Amount must be a positive number')
  }
  if (amt > outstanding + 0.001) {
    throw new Error(`Amount $${amt.toFixed(2)} exceeds outstanding balance $${outstanding.toFixed(2)}`)
  }

  const attemptNumber = invoice.attemptCount + 1
  const ref = String(reference).trim()
  const paymentRef = `${kind}:${ref}`

  console.log(
    `[invoice] recordManualPayment kind=${kind} ref="${ref}" amount=$${amt.toFixed(2)} ` +
      `invoice=${invoice._id} base=$${baseOutstanding.toFixed(2)} fee=$${feeAmount.toFixed(2)} ` +
      `outstanding=$${outstanding.toFixed(2)}`,
  )
  log.info('manual_payment.recording', {
    invoiceId: invoice._id.toString(),
    kind,
    reference: ref,
    amount: amt,
    feeAmount,
    recordedBy,
  })

  invoice.manualPayments.push({
    kind,
    reference: ref,
    amount: amt,
    currency: invoice.currency,
    receivedAt: receivedAt || new Date(),
    recordedBy,
    recordedAt: new Date(),
    note: note || undefined,
  })

  const attempt = await PaymentAttempt.create({
    invoiceRef: invoice._id,
    qboInvoiceId: invoice.qboInvoiceId,
    attemptNumber,
    amount: amt,
    currency: invoice.currency,
    outcome: 'manual_paid',
    nmiResponseText: `Manual ${kind} payment — ref ${ref}`,
  })

  invoice.attemptCount = attemptNumber
  invoice.lastAttemptAt = new Date()
  invoice.lastAttemptError = null
  // Stage processing-fee state so propagateSuccessfulPayment appends
  // the fee line to QBO before recording the payment. For cheque
  // (0% fee), feePreview is null and this block is skipped.
  if (feePreview) {
    invoice.processingFeeAmount = feePreview.amount
    invoice.processingFeeRate = feePreview.rate
    invoice.processingFeeMethod = feePreview.method
    invoice.amountDue = Number((invoice.amountDue + feeAmount).toFixed(2))
  }
  invoice.amountPaid = Number((invoice.amountPaid + amt).toFixed(2))
  invoice.paidAt = invoice.paidAt || new Date()
  invoice.paymentStatus = invoice.amountPaid >= invoice.amountDue ? 'paid' : 'pending'
  // Record what settled this — `cheque` kind maps to the canonical
  // 'check' enum value on the Invoice; 'ach' stays 'ach'. Latest write
  // wins for partial-payment sequences (Invoice.manualPayments[] has
  // the full ledger if more detail is needed).
  invoice.paymentSettledVia = kind === 'ach' ? 'ach' : 'check'
  invoice.paymentSettledAt = new Date()
  await invoice.save()

  // Propagate to QBO + Shopify + local order doc. Uses paymentRef so the
  // QBO RecordPayment carries the cheque/ACH reference (not a NMI txn id).
  const { syncErrors } = await propagateSuccessfulPayment({
    invoice,
    customerMap,
    amount: amt,
    transactionId: paymentRef,
  })

  return { invoice, attempt, syncErrors }
}
