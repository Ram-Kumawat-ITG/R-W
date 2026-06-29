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
// Plus a small helper:
//   appendInvoiceRemark — atomic $push into Invoice.remarks[] for the
//   Order List "Remarks" column.
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
  sendInvoiceEmail as sendQboInvoiceEmail,
} from '../qbo/qbo.service'
import { mintPayToken, buildPayLinkUrl, appendPayLinkToMemo } from '../payment/payLink.utils'
import {
  markShopifyOrderPaid,
  recordOrderTransaction as recordShopifyOrderTransaction,
} from '../shopify/shopify.service'
import { paymentConfig } from '../payment/payment.config'
import { invoiceConfig, dueDaysForMethod } from './invoice.config'
import {
  syncWithRetry,
  shopifyLinesToQboLines,
  computeInvoiceDueDate,
  computeInvoiceDueAt,
  toYmd,
  computeProcessingFee,
  buildProcessingFeeLine,
  findExistingProcessingFeeLine,
  applyDerivedPaymentStatus,
} from './invoice.utils'
import { buildProfileFromShopifyOrder } from '../customer/customer.utils'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('invoice.service')

// Maximum time we wait for a concurrent claimer to finish the QBO call
// before we give up and throw.
const CLAIM_WAIT_MS = 30_000
const CLAIM_POLL_MS = 500

export async function createInvoiceForOrder({ shop, order, localOrder, customerMap, isDropship = false, retailOrderName = null }) {
  const shopifyOrderId = String(order.id)

  // Drop-ship invoices lock `paymentMethod: 'dropship'` regardless of the
  // customer map (the synthetic retail customer has no registration-time
  // preference). 'dropship' falls outside the wholesale CRON's card/ach
  // PASS 1 filter and carries no processing fee (no rate configured), and
  // the `isDropship` flag below segregates the row for the dedicated
  // process-dropship-payments CRON. Everything else (claim-first dedup, QBO
  // create, due date, ship address, invoice email) is shared with the
  // wholesale path.
  const lockedMethod = isDropship ? 'dropship' : customerMap.paymentMethod || 'card'

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
      paymentMethod: lockedMethod,
      customerPaymentPreference: lockedMethod,
      isDropship: Boolean(isDropship),
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
  const lines = shopifyLinesToQboLines(order)

  // Processing-fee line at creation — for card / ACH (any method with a
  // non-zero rate), append the fee line NOW so the invoice the customer
  // first receives by email already shows the full amount that will be
  // charged. We stamp `processingFeeAppliedAt` + the staging fields here;
  // every settlement-time fee path (chargeInvoice, propagateSuccessful-
  // Payment §0, checkAchSettlement, recordManualPayment) guards on these,
  // so the fee is never double-added downstream.
  //
  // Cheque (0% rate) gets NO fee line and we deliberately leave
  // `processingFeeAppliedAt` UNSET — the cheque → card admin fallback still
  // applies the 3% card fee at settlement, exactly as before. The fee is
  // sized on the post-discount grand total (order.total_price = adjusted
  // subtotal + shipping + tax), which the QBO sales lines now sum to.
  const feeBase = Number(order.total_price ?? 0)
  const creationFee = computeProcessingFee({
    baseAmount: feeBase,
    method: invoice.paymentMethod,
    rates: invoiceConfig.processingFeeRates,
  })
  if (creationFee) {
    const feeLine = buildProcessingFeeLine({ ...creationFee, baseAmount: feeBase })
    if (feeLine) {
      lines.push(feeLine)
      invoice.processingFeeAmount = creationFee.amount
      invoice.processingFeeRate = creationFee.rate
      invoice.processingFeeMethod = creationFee.method
      invoice.processingFeeAppliedAt = new Date()
      console.log(
        `[invoice] processing fee at creation — ${creationFee.method} ` +
          `$${creationFee.amount.toFixed(2)} (${(creationFee.rate * 100).toFixed(2)}% of $${feeBase.toFixed(2)})`,
      )
    }
  }
  // Due date = order date + per-method terms. The term length is
  // selected by the invoice's locked paymentMethod (cheque →
  // CHEQUE_DUE_DATE, ACH → ACH_DUE_DATE, card → CARD_DUE_DATE; each
  // falls back to INVOICE_TERMS_DAYS). Sending DueDate explicitly makes
  // us the source of truth and overrides any QBO customer-level
  // SalesTerm. Falls back to localOrder.receivedAt if Shopify's
  // created_at is missing; if both are unparseable, we omit DueDate
  // and let QBO compute it from its own defaults.
  const orderDateBasis = order?.created_at || localOrder?.receivedAt
  const termsDays = dueDaysForMethod(invoice.paymentMethod)
  const dueDate = computeInvoiceDueDate(orderDateBasis, termsDays)
  const dueAt = computeInvoiceDueAt(
    orderDateBasis,
    termsDays,
    invoiceConfig.termsMinutes,
  )
  console.log(
    `[invoice] dueDate = ${dueDate || '(QBO default)'} ` +
      `(order date ${orderDateBasis || '(unknown)'} + ${termsDays} days [method=${invoice.paymentMethod}]` +
      (invoiceConfig.termsMinutes ? ` + ${invoiceConfig.termsMinutes} min` : '') +
      `) dueAt = ${dueAt ? dueAt.toISOString() : '(none)'}`,
  )
  // Ship-to fields. Address uses the same shipping → billing → customer
  // default fallback as the customer sync (buildProfileFromShopifyOrder) so
  // the invoice still ships somewhere on pickup/digital orders with no
  // shipping_address. ShipDate is left blank at creation; pushShippingToInvoice
  // populates it after the order is fulfilled.
  const shipAddr = buildProfileFromShopifyOrder(order).shippingAddress
  console.log(`[invoice] shipAddr = ${shipAddr ? 'present' : '(none)'}`)

  // Immediate Payment — mint the durable pay-link token NOW so the public
  // /pay/<token> URL can be baked into the QBO invoice's CustomerMemo.
  // Stamped on the in-memory doc; persisted in the single save() in Phase 4.
  // The token is opaque (no amount) — outstanding is recomputed server-side
  // at click time. For non-immediate invoices payLinkUrl stays null and the
  // memo is unchanged. The URL is appended as its own full-width line (see
  // buildPayLinkMemoSuffix) so QBO's auto-linkifier can't truncate it.
  const isImmediate = invoice.paymentMethod === 'immediate'
  let payLinkUrl = null
  if (isImmediate) {
    invoice.payToken = mintPayToken()
    invoice.payTokenCreatedAt = new Date()
    payLinkUrl = buildPayLinkUrl(invoice.payToken)
    console.log(`[invoice] immediate payment — pay link ${payLinkUrl}`)
  }
  const baseMemo = `Shopify order ${order.name || order.id}`
  const memo = isImmediate && payLinkUrl
    ? appendPayLinkToMemo(baseMemo, payLinkUrl)
    : baseMemo

  let qboInvoice
  try {
    qboInvoice = await createQboInvoice({
      qboCustomerId: customerMap.qboCustomerId,
      currency: order.currency || 'USD',
      lines,
      memo,
      docNumber: isDropship && retailOrderName
        ? `RS-${retailOrderName}`.slice(0, 21)
        : (order.name?.replace(/^#/, '') || shopifyOrderId),
      dueDate,
      shipAddr,
      // Tax renders in QBO's summary "Tax" row (TxnTaxDetail.TotalTax),
      // not as a product line — see shopifyLinesToQboLines.
      taxAmount: Number(order.total_tax || 0),
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
  invoice.dueAt = dueAt || undefined
  invoice.amountDue = Number(qboInvoice.TotalAmt ?? invoice.amountDue)
  invoice.currency = qboInvoice.CurrencyRef?.value || invoice.currency
  invoice.qboCreationStatus = 'created'
  invoice.qboCreationError = undefined

  // Phase 4 — fire the initial customer-facing invoice email via QBO.
  // Mutates email-tracking fields on the in-memory doc; never throws.
  // Runs BEFORE save() so the email-tracking flags persist in the
  // single .save() below — no second write needed in the happy path.
  await dispatchInvoiceLifecycleEmails({ invoice, customerMap, event: 'created' })

  await invoice.save()

  console.log(
    `[invoice] CREATED Invoice _id=${invoice._id} qboInvoiceId=${invoice.qboInvoiceId} ` +
      `amountDue=${invoice.amountDue} status=pending ` +
      `emailedAt=${invoice.invoiceEmailSentAt ? invoice.invoiceEmailSentAt.toISOString() : '(deferred — see lastEmailError)'}`,
  )
  log.info('create.success', {
    invoiceId: invoice._id.toString(),
    qboInvoiceId: invoice.qboInvoiceId,
    amountDue: invoice.amountDue,
    invoiceEmailSent: Boolean(invoice.invoiceEmailSentAt),
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
export async function propagateSuccessfulPayment({ invoice, customerMap, transactionId }) {
  console.log(`\n[sync] propagating successful payment for invoice _id=${invoice._id}`)
  console.log(
    `[sync]   state — qboPaymentRecorded=${invoice.qboPaymentRecorded} shopifyMarkedPaid=${invoice.shopifyMarkedPaid}`,
  )
  const syncErrors = []

  // Self-heal stale paymentStatus before doing any downstream work.
  // `chargeInvoice` writes `paymentStatus='in_progress'` as a transient
  // lock and relies on the post-charge derive to release it; if a
  // previous run ever left an invoice stuck at `in_progress` (e.g. a
  // crash mid-charge before the final save, or a now-fixed sticky-
  // derive bug), this re-derivation reconciles the status with the
  // actual money fields so the rest of this function (and the local
  // mirror update at the bottom) see the correct state.
  const priorStatus = invoice.paymentStatus
  const derivedStatus = applyDerivedPaymentStatus(invoice)
  if (priorStatus !== derivedStatus) {
    console.log(
      `[sync]   status self-heal: ${priorStatus} → ${derivedStatus} ` +
        `(amountPaid=$${(invoice.amountPaid || 0).toFixed(2)} of $${(invoice.amountDue || 0).toFixed(2)})`,
    )
    log.info('status.self_heal', {
      invoiceId: invoice._id.toString(),
      from: priorStatus,
      to: derivedStatus,
      amountPaid: invoice.amountPaid,
      amountDue: invoice.amountDue,
    })
  }

  // ── 0) QBO: append processing-fee line (if owed) ──────────────
  //
  // For card / ACH invoices the fee line is normally added at CREATION
  // (createInvoiceForOrder stamps processingFeeAppliedAt), so feePending is
  // false here and this step is a no-op. It still fires as the FALLBACK
  // path for invoices that staged the fee at settlement but haven't told
  // QBO yet — the cheque → card admin override, and any legacy invoice
  // created before fee-at-creation.
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

  // ── 1) QBO: record payment(s) against the invoice ─────────────
  //
  // Multi-payment-aware: we record the DIFFERENCE between what the
  // invoice has been paid and what QBO has already booked, not just
  // "did we ever record one". Cheque-then-cheque, card-then-card, or
  // any mix all land their full ledger in QBO across multiple
  // settlement events.
  //
  // Backward-compat: invoices that pre-date `qboRecordedTotal` carry
  // `qboPaymentRecorded: true` but `qboRecordedTotal: 0`. We can't
  // tell from the doc alone whether their prior payment was for the
  // full amount or a partial, so the safe assumption is "the prior
  // payment covered everything that was paid at that time" — bring
  // qboRecordedTotal up to amountPaid so we don't double-record.
  if (invoice.qboPaymentRecorded && !(invoice.qboRecordedTotal > 0)) {
    invoice.qboRecordedTotal = Number((invoice.amountPaid || 0).toFixed(2))
    console.log(
      `[sync] QBO   • backfilling qboRecordedTotal from legacy qboPaymentRecorded flag → $${invoice.qboRecordedTotal.toFixed(2)}`,
    )
  }
  const qboOwed = Number(
    ((invoice.amountPaid || 0) - (invoice.qboRecordedTotal || 0)).toFixed(2),
  )
  if (qboOwed > 0.005) {
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
            amount: qboOwed,
            currency: invoice.currency,
            paymentRef: transactionId,
          }),
        )
        invoice.qboPaymentIds = invoice.qboPaymentIds || []
        if (qboPayment?.Id) invoice.qboPaymentIds.push(String(qboPayment.Id))
        // Keep the legacy single-id field pointing at the first
        // recorded payment for backward compat with anything still
        // reading it.
        if (!invoice.qboPaymentId && qboPayment?.Id) {
          invoice.qboPaymentId = String(qboPayment.Id)
        }
        invoice.qboRecordedTotal = Number(
          ((invoice.qboRecordedTotal || 0) + qboOwed).toFixed(2),
        )
        // Boolean is now DERIVED: cumulative >= amountPaid (within EPS).
        // CRON PASS 2 still uses the boolean as a coarse "needs sync"
        // signal; the cursor query is updated below to use the
        // cumulative-mismatch shape too.
        invoice.qboPaymentRecorded =
          invoice.qboRecordedTotal + 0.005 >= (invoice.amountPaid || 0)
        console.log(
          `[sync] QBO   ✓ recorded $${qboOwed.toFixed(2)} (id=${qboPayment?.Id}) — ` +
            `cumulative $${invoice.qboRecordedTotal.toFixed(2)}/$${(invoice.amountPaid || 0).toFixed(2)}`,
        )
        log.info('sync.qbo.recorded', {
          invoiceId: invoice._id.toString(),
          qboPaymentId: qboPayment?.Id,
          amount: qboOwed,
          cumulativeRecorded: invoice.qboRecordedTotal,
          amountPaid: invoice.amountPaid,
        })
      } catch (qboErr) {
        const msg = `QBO payment record failed after NMI success: ${qboErr.message}`
        console.error(`[sync] QBO   ✗ ${msg}`)
        log.error('sync.qbo.failed', { invoiceId: invoice._id.toString(), err: qboErr })
        syncErrors.push(msg)
      }
    }
  } else {
    console.log(
      `[sync] QBO   • already up to date (recorded $${(invoice.qboRecordedTotal || 0).toFixed(2)} of $${(invoice.amountPaid || 0).toFixed(2)})`,
    )
  }

  // ── 2) Shopify: per-payment SALE transaction + final mark-as-paid ──
  //
  // Two-step Shopify sync so partial payments are visible in Shopify
  // *before* full settlement:
  //
  //   a) Push a manual SALE transaction (REST orders/:id/transactions)
  //      for the difference between amountPaid and what Shopify has
  //      already seen. Each partial cheque receipt / partial card
  //      charge gets its own transaction — Shopify computes
  //      `displayFinancialStatus` (paid / partially_paid) from the
  //      sum of transactions.
  //
  //   b) On full settlement, also call orderMarkAsPaid. Shopify
  //      treats it as a no-op when transactions already cover the
  //      total (markShopifyOrderPaid normalizes "already paid"
  //      userErrors to success), but the call still triggers the
  //      "order paid" downstream workflow inside Shopify (notifications,
  //      fulfillment hooks).
  //
  // Backward-compat: same trick as QBO — invoices flagged
  // `shopifyMarkedPaid: true` from before the cumulative tracker
  // are assumed to have their `amountPaid` already mirrored.
  if (invoice.shopifyMarkedPaid && !(invoice.shopifyRecordedTotal > 0)) {
    invoice.shopifyRecordedTotal = Number((invoice.amountPaid || 0).toFixed(2))
    console.log(
      `[sync] SHOP  • backfilling shopifyRecordedTotal from legacy shopifyMarkedPaid flag → $${invoice.shopifyRecordedTotal.toFixed(2)}`,
    )
  }
  const shopOwed = Number(
    ((invoice.amountPaid || 0) - (invoice.shopifyRecordedTotal || 0)).toFixed(2),
  )
  if (shopOwed > 0.005) {
    try {
      const shopTxn = await syncWithRetry('shopify.record_transaction', () =>
        recordShopifyOrderTransaction({
          shop: invoice.shop,
          shopifyOrderId: invoice.shopifyOrderId,
          amount: shopOwed,
          currency: invoice.currency,
          paymentRef: transactionId,
        }),
      )
      invoice.shopifyTransactionIds = invoice.shopifyTransactionIds || []
      if (shopTxn?.shopifyTransactionId) {
        invoice.shopifyTransactionIds.push(shopTxn.shopifyTransactionId)
      }
      invoice.shopifyRecordedTotal = Number(
        ((invoice.shopifyRecordedTotal || 0) + shopOwed).toFixed(2),
      )
      console.log(
        `[sync] SHOP  ✓ transaction $${shopOwed.toFixed(2)} (id=${shopTxn?.shopifyTransactionId}) — ` +
          `cumulative $${invoice.shopifyRecordedTotal.toFixed(2)}/$${(invoice.amountPaid || 0).toFixed(2)}`,
      )
      log.info('sync.shopify.transaction', {
        invoiceId: invoice._id.toString(),
        shopifyTransactionId: shopTxn?.shopifyTransactionId,
        amount: shopOwed,
        cumulativeRecorded: invoice.shopifyRecordedTotal,
        amountPaid: invoice.amountPaid,
      })
    } catch (shopTxnErr) {
      const msg = `Shopify transaction record failed: ${shopTxnErr.message}`
      console.error(`[sync] SHOP  ✗ ${msg}`)
      log.error('sync.shopify.transaction_failed', {
        invoiceId: invoice._id.toString(),
        shopifyOrderId: invoice.shopifyOrderId,
        err: shopTxnErr,
      })
      syncErrors.push(msg)
    }
  } else {
    console.log(
      `[sync] SHOP  • transaction ledger up to date ($${(invoice.shopifyRecordedTotal || 0).toFixed(2)} of $${(invoice.amountPaid || 0).toFixed(2)})`,
    )
  }

  const fullyPaid = invoice.paymentStatus === 'paid'
  if (fullyPaid && !invoice.shopifyMarkedPaid) {
    // If our per-partial SALE transactions already sum to amountPaid,
    // Shopify's auto-computed displayFinancialStatus is already 'paid'
    // — orderMarkAsPaid would reject with "Order cannot be marked as
    // paid" (and even if we catch that via the regex, the round-trip
    // is wasted work). Just flip the local flag.
    const salesCoverTotal =
      (invoice.shopifyRecordedTotal || 0) + 0.005 >= (invoice.amountPaid || 0)
    if (salesCoverTotal) {
      invoice.shopifyMarkedPaid = true
      invoice.shopifyMarkedPaidAt = new Date()
      console.log(
        `[sync] SHOP  ✓ order considered paid via SALE transactions ` +
          `($${(invoice.shopifyRecordedTotal || 0).toFixed(2)} of $${(invoice.amountPaid || 0).toFixed(2)}) — ` +
          `orderMarkAsPaid skipped (already paid)`,
      )
      log.info('sync.shopify.marked_paid_via_transactions', {
        invoiceId: invoice._id.toString(),
        shopifyOrderId: invoice.shopifyOrderId,
        shopifyRecordedTotal: invoice.shopifyRecordedTotal,
      })
    } else {
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
    }
  } else if (invoice.shopifyMarkedPaid) {
    console.log(`[sync] SHOP  • already marked paid at ${invoice.shopifyMarkedPaidAt?.toISOString()}`)
  }

  // ── 3) ShopifyOrder local doc: mirror final payment state ──────
  try {
    // Map the Invoice status enum down to the ShopifyOrder.paymentStatus
    // enum (a narrower {pending, paid, failed} legacy enum). Partial
    // payments stay 'pending' on the order doc — the precise breakdown
    // lives on the Invoice — while the financialStatus mirror tracks
    // the richer Shopify-aligned state.
    const shopifyOrderPaymentStatus = invoice.paymentStatus === 'paid' ? 'paid' : 'pending'
    // financialStatus carries the granularity admins see in Shopify
    // (paid / partially_paid / pending) — the local mirror so the
    // Order Details page renders without a Shopify Admin round-trip.
    let financialStatus
    if (invoice.paymentStatus === 'paid') financialStatus = 'paid'
    else if (invoice.amountPaid > 0) financialStatus = 'partially_paid'
    else financialStatus = 'pending'
    const update = {
      paymentStatus: shopifyOrderPaymentStatus,
      financialStatus,
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

  // Re-send the customer-facing invoice email if this payment grew
  // amountPaid or transitioned paymentStatus since the last send.
  // The /send endpoint mails the CURRENT QBO invoice document, so the
  // customer sees the updated balance + payments list automatically —
  // no separate payment-receipt channel needed. Idempotent: the in-doc
  // snapshots (invoiceEmailedAmountPaid + invoiceEmailedStatus) prevent
  // PASS 2 sync retries and concurrent propagate calls from double-
  // sending. Best-effort: errors land on invoice.lastEmailError, never
  // block payment bookkeeping.
  await dispatchInvoiceLifecycleEmails({ invoice, customerMap, event: 'payment' })

  await invoice.save()
  return { syncErrors }
}

// Dispatch the customer-facing invoice email via QBO's `/invoice/{id}/send`
// endpoint. Best-effort: a failure never throws upward — payment sync
// state must not depend on email delivery. Errors are recorded on
// invoice.lastEmailError so operators can see them.
//
// MUTATES the in-memory invoice doc with email-tracking fields but does
// NOT call .save() — callers persist as part of their own save cycle, so
// a single Mongo write covers email state + the rest of the propagate-
// success bookkeeping.
//
// Only the INVOICE email is sent — no separate payment-receipt emails.
// QBO's `/send` mails the CURRENT invoice document, so the customer's
// re-sent copy already shows every recorded payment + the updated
// balance + the correct status. One channel covers create, partial-paid,
// and fully-paid.
//
// When it fires:
//   event='created' — first invoice email, fired once per invoice at
//                     creation time. Guard: invoiceEmailSentAt.
//   event='payment' — re-send whenever a successful payment has changed
//                     either amountPaid (a new payment recorded since
//                     the last email) or paymentStatus (pending →
//                     partially_paid, partially_paid → paid). Each
//                     partial gets its own re-send so the customer sees
//                     the new balance.
//
// QBO does not dedup `/send` calls server-side, so duplicate-send
// protection lives entirely in the local guards (invoiceEmailSentAt
// + invoiceEmailedAmountPaid + invoiceEmailedStatus).
export async function dispatchInvoiceLifecycleEmails({ invoice, customerMap, event, shipDate, trackingNum }) {
  // Resolve recipient: prefer the live customer record (it can be
  // updated via /api/update-profile after registration) and fall back
  // to the invoice's stored email for legacy rows.
  const sendTo = customerMap?.email || invoice.customerEmail
  if (!sendTo) {
    console.warn(`[email] skipped — no recipient on customerMap/invoice ${invoice._id}`)
    log.warn('email.skip_no_recipient', { invoiceId: invoice._id.toString() })
    return
  }
  // A half-claimed invoice has no QBO id yet — nothing to send.
  if (!invoice.qboInvoiceId) {
    console.warn(`[email] skipped — invoice ${invoice._id} has no qboInvoiceId yet`)
    return
  }

  // Decide whether to (re)send.
  //   - 'created'     → send once; guard on invoiceEmailSentAt
  //   - 'payment'     → re-send if amountPaid grew OR status moved since
  //                     the last (re)send (also covers the case where the
  //                     creation-time email failed and we never stamped a
  //                     baseline — both fields are falsy then)
  //   - 'fulfillment' → re-send if shipDate OR trackingNum differs from the
  //                     snapshot recorded at the last fulfillment email, so
  //                     the customer always sees the latest tracking info.
  const currentPaid = Number((invoice.amountPaid || 0).toFixed(2))
  const emailedPaid = Number((invoice.invoiceEmailedAmountPaid || 0).toFixed(2))
  const isInitial = event === 'created' && !invoice.invoiceEmailSentAt
  const isResend =
    event === 'payment' &&
    (currentPaid > emailedPaid + 0.005 ||
      invoice.invoiceEmailedStatus !== invoice.paymentStatus)
  const isFulfillmentResend =
    event === 'fulfillment' &&
    (shipDate !== invoice.invoiceEmailedShipDate ||
      trackingNum !== invoice.invoiceEmailedTrackingNum)
  if (!isInitial && !isResend && !isFulfillmentResend) {
    console.log(`[email] no action for invoice ${invoice._id} (event=${event})`)
    return
  }

  // Resolve the audit-ledger `source` from the same conditions that
  // drive the human-readable reason label below. Keep these aligned:
  // every reasonLabel branch maps to exactly one source enum value.
  const source = isInitial
    ? 'invoice_created'
    : isFulfillmentResend
    ? 'fulfillment_updated'
    : currentPaid > emailedPaid + 0.005
    ? 'payment_recorded'
    : 'status_changed'
  const reasonLabel = isInitial
    ? 'initial'
    : isFulfillmentResend
    ? `fulfillment updated (shipDate=${shipDate || '(none)'}, tracking=${trackingNum || '(none)'})`
    : source === 'payment_recorded'
    ? `payment recorded (paid $${emailedPaid.toFixed(2)} → $${currentPaid.toFixed(2)})`
    : `status changed (${invoice.invoiceEmailedStatus || '(none)'} → ${invoice.paymentStatus})`

  try {
    console.log(`[email] sending invoice email — ${reasonLabel} — to ${sendTo} (qboInvoice=${invoice.qboInvoiceId})`)
    await sendQboInvoiceEmail({ qboInvoiceId: invoice.qboInvoiceId, sendTo })
    const now = new Date()
    if (isInitial) invoice.invoiceEmailSentAt = now
    invoice.invoiceEmailLastSentAt = now
    invoice.invoiceEmailedStatus = invoice.paymentStatus
    invoice.invoiceEmailedAmountPaid = currentPaid
    // Fulfillment snapshot: only overwrite when this send was triggered by
    // fulfillment so that payment re-sends don't erase the shipping snapshot.
    if (event === 'fulfillment') {
      invoice.invoiceEmailedShipDate = shipDate
      invoice.invoiceEmailedTrackingNum = trackingNum
    }
    invoice.lastEmailError = undefined
    recordEmailEvent(invoice, {
      triggerType: 'auto',
      triggeredBy: 'system',
      source,
      recipient: sendTo,
      status: 'sent',
    })
    log.info('email.invoice_sent', {
      invoiceId: invoice._id.toString(),
      qboInvoiceId: invoice.qboInvoiceId,
      sendTo,
      reason: reasonLabel,
      status: invoice.paymentStatus,
      amountPaid: currentPaid,
    })
  } catch (err) {
    const msg = `Invoice email failed (${reasonLabel}): ${err.message}`
    console.error(`[email] ${msg}`)
    invoice.lastEmailError = msg
    recordEmailEvent(invoice, {
      triggerType: 'auto',
      triggeredBy: 'system',
      source,
      recipient: sendTo,
      status: 'failed',
      errorMessage: err.message,
    })
    log.error('email.invoice_failed', { invoiceId: invoice._id.toString(), reason: reasonLabel, err })
  }
}

// Push one entry onto invoice.emailEvents[]. Pure in-memory mutation —
// the caller's existing .save() persists it alongside the baseline
// fields, so the ledger and the dedup state can never disagree.
// Exported for the admin "Send invoice" endpoint which manages its own
// save cycle; the auto path inside dispatchInvoiceLifecycleEmails calls
// this for both success and failure outcomes.
//
// `paymentStatusSnapshot` / `amountPaidSnapshot` come from the invoice's
// CURRENT state (the state QBO just received via /send), so the history
// reads sensibly even after later payments change the live values.
export function recordEmailEvent(invoice, {
  triggerType,
  triggeredBy,
  source,
  recipient,
  status,
  errorMessage,
}) {
  if (!Array.isArray(invoice.emailEvents)) invoice.emailEvents = []
  invoice.emailEvents.push({
    createdAt: new Date(),
    triggerType,
    triggeredBy,
    source,
    recipient,
    status,
    errorMessage: errorMessage || undefined,
    paymentStatusSnapshot: invoice.paymentStatus,
    amountPaidSnapshot: Number((invoice.amountPaid || 0).toFixed(2)),
  })
}

// Atomic $push into Invoice.remarks[]. The remarks ledger powers the
// Order List "Remarks" column — every CRON tick and admin settlement
// action appends one entry so operators can see the follow-up trail
// without opening the Order Details page. Distinct from PaymentAttempt
// (strict charge audit) and manualPayments[] (cheque/ACH receipts);
// this one is the operator-facing "what happened next" feed.
//
// `invoiceId` accepts either a Mongoose ObjectId or its string form.
// `entry.kind` must match the Invoice schema's remarks enum.
export async function appendInvoiceRemark(invoiceId, entry) {
  if (!invoiceId) throw new Error('appendInvoiceRemark: invoiceId is required')
  if (!entry?.kind || !entry?.message) {
    throw new Error('appendInvoiceRemark: entry.kind and entry.message are required')
  }
  await Invoice.updateOne(
    { _id: invoiceId },
    {
      $push: {
        remarks: {
          kind: entry.kind,
          message: entry.message,
          amount: entry.amount,
          currency: entry.currency,
          source: entry.source || 'system',
          createdAt: entry.createdAt || new Date(),
        },
      },
    },
  )
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
  if (
    invoice.paymentStatus === 'paid' ||
    invoice.paymentStatus === 'cancelled' ||
    invoice.paymentStatus === 'refunded'
  ) {
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
  // Record what settled this — `cheque` kind maps to the canonical
  // 'check' enum value on the Invoice; 'ach' stays 'ach'. Latest write
  // wins for partial-payment sequences (Invoice.manualPayments[] has
  // the full ledger if more detail is needed).
  invoice.paymentSettledVia = kind === 'ach' ? 'ach' : 'check'
  invoice.paymentSettledAt = new Date()
  // Single source of truth for the status transition. partially_paid
  // when amt closes some but not all of the outstanding balance; paid
  // when fully settled.
  applyDerivedPaymentStatus(invoice)
  await invoice.save()

  // Propagate to QBO + Shopify + local order doc. Uses paymentRef so the
  // QBO RecordPayment carries the cheque/ACH reference (not a NMI txn id).
  const { syncErrors } = await propagateSuccessfulPayment({
    invoice,
    customerMap,
    amount: amt,
    transactionId: paymentRef,
  })

  // Surface the receipt on the Order List "Remarks" column. Includes the
  // admin email + reference so the audit trail is operator-readable
  // without clicking into the Order Details page.
  await appendInvoiceRemark(invoice._id, {
    kind: 'admin_action',
    message:
      `Admin marked ${kind} payment received — ref ${ref} ($${amt.toFixed(2)})` +
      (recordedBy ? ` by ${recordedBy}` : ''),
    amount: amt,
    currency: invoice.currency,
    source: 'admin',
  })

  return { invoice, attempt, syncErrors }
}
