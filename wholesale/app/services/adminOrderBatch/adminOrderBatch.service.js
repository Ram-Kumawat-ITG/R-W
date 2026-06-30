// Admin Order Batch Payment Service.
//
// Replaces the process-dropship-payments CRON. Instead of auto-charging the
// NMI vault on a monthly schedule, the admin manually reviews all unpaid
// drop-ship invoices, enters a single payment reference (cheque number / bank
// transfer / EFT ref), and marks the entire batch paid in one operation.
//
// Responsibilities:
//   getUnpaidBatchPreview(shop) — analytics + invoice list for the "Next Batch"
//                                 UI tab; joins vendor bill info via the two-hop
//                                 shared-DB read (dropship_mappings → cdo_orders).
//   createAdminOrderBatch(...)  — marks each selected invoice paid (via the
//                                 existing recordManualPayment path) and records
//                                 the batch in admin_order_batches for the audit
//                                 trail. Vendor bills are reconciled automatically
//                                 by the ns-retail processBillReconciliation CRON
//                                 on its next tick once the invoices are paid.
//   listAdminOrderBatches(...)  — paginated history for the "Payment History" tab.

import connectDB from '../APIService/mongo.service'
import Invoice from '../../models/invoice.server'
import ShopifyOrder from '../../models/order.server'
import CustomerMap from '../../models/customerMap.server'
import DropshipMapping from '../../models/dropshipMapping.server'
import RetailCdoOrder from '../../models/retailCdoOrder.server'
import AdminOrderBatch from '../../models/adminOrderBatch.server'
import { recordManualPayment, appendInvoiceRemark } from '../invoice/invoice.service'
import { RETAIL_CUSTOMER_EMAIL } from '../dropship/dropship.config'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('admin.order.batch.service')

// ── Helpers ──────────────────────────────────────────────────────────────────

// Build the two-hop vendor-bill join for a set of wholesale Shopify order IDs.
// Returns a Map<wholesaleOrderId (string), vendorBillInfo>.
// No N+1: two DB queries for any batch size.
async function buildVendorBillMap(wsOrderIds) {
  if (!wsOrderIds.length) return new Map()

  const maps = await DropshipMapping.find({
    wholesaleOrderId: { $in: wsOrderIds },
  })
    .select('wholesaleOrderId retailOrderGid')
    .lean()

  const retailGidByWsId = new Map()
  const retailGids = []
  for (const m of maps) {
    if (m.wholesaleOrderId && m.retailOrderGid) {
      retailGidByWsId.set(String(m.wholesaleOrderId), m.retailOrderGid)
      retailGids.push(m.retailOrderGid)
    }
  }

  if (!retailGids.length) return new Map()

  const cdoRows = await RetailCdoOrder.find({
    shopifyOrderId: { $in: retailGids },
  })
    .select('shopifyOrderId retailQbo')
    .lean()

  const rqByGid = new Map()
  for (const c of cdoRows) rqByGid.set(c.shopifyOrderId, c.retailQbo || null)

  const result = new Map()
  for (const [wsId, gid] of retailGidByWsId) {
    const rq = rqByGid.get(gid)
    if (rq?.qboBillId) {
      result.set(wsId, {
        billId: rq.qboBillId,
        docNumber: rq.qboBillDocNumber || null,
        amount: rq.qboBillTotal ?? null,
        paymentStatus: rq.billPaymentStatus || null,
        syncStatus: rq.billSyncStatus || null,
      })
    }
  }
  return result
}

// Generate a unique batchId of the form "BATCH-YYYYMMDD-NNN".
// Uses Mongo's existing admin_order_batches count for the sequence — good
// enough for a low-volume manual operation.
async function generateBatchId() {
  const now = new Date()
  const datePart = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('')
  const count = await AdminOrderBatch.countDocuments()
  const seq = String(count + 1).padStart(3, '0')
  return `BATCH-${datePart}-${seq}`
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns analytics + full invoice list for the pending batch UI.
 *
 * Includes ALL unpaid drop-ship invoices (paymentStatus 'pending' or
 * 'partially_paid'), joined with their vendor bill state from ns-retail.
 * The UI renders these so the admin can select/deselect individual invoices
 * before submitting the batch.
 */
export async function getUnpaidBatchPreview({ shop }) {
  await connectDB()

  // Load unpaid drop-ship invoices (all statuses that still have a balance).
  const invoices = await Invoice.find({
    shop,
    isDropship: true,
    paymentStatus: { $in: ['pending', 'partially_paid', 'failed'] },
  })
    .lean()

  if (!invoices.length) {
    return {
      invoices: [],
      totalInvoiceAmount: 0,
      totalVendorBillAmount: 0,
      totalBatchAmount: 0,
      orderCount: 0,
      vendorBreakdown: [],
    }
  }

  // Load the wholesale ShopifyOrder rows to get readable order names.
  const orderRefs = invoices.map((i) => i.orderRef).filter(Boolean)
  const orders = await ShopifyOrder.find({ _id: { $in: orderRefs } })
    .select('_id shopifyOrderId shopifyOrderNumber shopifyOrderName')
    .lean()
  const orderByRef = new Map()
  for (const o of orders) orderByRef.set(o._id.toString(), o)

  // Two-hop vendor-bill join.
  const wsOrderIds = invoices.map((i) => String(i.shopifyOrderId)).filter(Boolean)
  const vendorBillMap = await buildVendorBillMap(wsOrderIds)

  // Build the enriched invoice list.
  let totalInvoiceAmount = 0
  let totalVendorBillAmount = 0
  const enriched = []

  for (const inv of invoices) {
    const order = orderByRef.get(inv.orderRef?.toString())
    const wsOrderId = String(inv.shopifyOrderId || '')
    const bill = vendorBillMap.get(wsOrderId) || null
    const outstanding = Number((inv.amountDue - inv.amountPaid).toFixed(2))

    totalInvoiceAmount += outstanding
    if (bill?.amount != null) totalVendorBillAmount += Number(bill.amount)

    enriched.push({
      invoiceId: inv._id.toString(),
      shopifyOrderId: wsOrderId,
      orderName:
        order?.shopifyOrderName ||
        (order?.shopifyOrderNumber ? `#${order.shopifyOrderNumber}` : wsOrderId),
      qboInvoiceId: inv.qboInvoiceId || null,
      qboDocNumber: inv.qboDocNumber || null,
      amountDue: inv.amountDue,
      amountPaid: inv.amountPaid,
      outstanding,
      currency: inv.currency || 'USD',
      paymentStatus: inv.paymentStatus,
      attemptCount: inv.attemptCount ?? 0,
      maxAttempts: inv.maxAttempts ?? 6,
      vendorBill: bill,
      // Latest remark for quick context
      latestRemark: (() => {
        const list = Array.isArray(inv.remarks) ? inv.remarks : []
        const last = list.length ? list[list.length - 1] : null
        return last ? { message: last.message, createdAt: last.createdAt } : null
      })(),
    })
  }

  // Compute totals.
  // Batch total = invoice total only. Vendor bills are auto-reconciled by the
  // ns-retail processBillReconciliation CRON once invoices are marked paid —
  // the admin makes ONE payment covering the invoice total; vendor bills are
  // not a separate payment obligation from the wholesale side.
  totalInvoiceAmount = Number(totalInvoiceAmount.toFixed(2))
  totalVendorBillAmount = Number(totalVendorBillAmount.toFixed(2))
  const totalBatchAmount = totalInvoiceAmount

  // Order-wise breakdown (each row IS the vendor — the retail customer is the
  // single "vendor" from the wholesale perspective; the breakdown shows per-order
  // amounts for the admin's review before batch submission).
  const vendorBreakdown = enriched.map((inv) => ({
    orderName: inv.orderName,
    shopifyOrderId: inv.shopifyOrderId,
    invoiceAmount: inv.outstanding,
    vendorBillAmount: inv.vendorBill?.amount ?? null,
    currency: inv.currency,
  }))

  return {
    invoices: enriched,
    totalInvoiceAmount,
    totalVendorBillAmount,
    totalBatchAmount,
    orderCount: enriched.length,
    vendorBreakdown,
  }
}

/**
 * Creates a batch payment record and marks every selected invoice paid.
 *
 * For each invoice:
 *   1. Calls recordManualPayment (kind='cheque', reference=referenceNumber)
 *      which bumps amountPaid, runs propagateSuccessfulPayment (QBO Payment
 *      record + Shopify mark-paid), and appends to the invoice's manualPayments
 *      ledger.
 *   2. Records the outcome in the AdminOrderBatch document.
 *
 * Vendor bills are reconciled by the ns-retail processBillReconciliation CRON
 * automatically on its next tick once the invoices are paid (within 6 h
 * production / 2 min testing). No immediate QBO write from wholesale side is
 * needed for bills.
 *
 * Returns the saved AdminOrderBatch document.
 */
export async function createAdminOrderBatch({
  shop,
  selectedInvoiceIds, // string[] of Invoice._id to include
  referenceNumber,
  paymentDate,
  notes,
  processedBy,
}) {
  await connectDB()

  if (!referenceNumber?.trim()) throw new Error('Reference number is required')
  if (!paymentDate) throw new Error('Payment date is required')
  if (!selectedInvoiceIds?.length) throw new Error('No invoices selected for this batch')

  const payDate = new Date(paymentDate)
  if (!Number.isFinite(payDate.getTime())) throw new Error('Payment date is not a valid date')

  // Load the selected invoices (must be drop-ship + belonging to this shop).
  const invoices = await Invoice.find({
    _id: { $in: selectedInvoiceIds },
    shop,
    isDropship: true,
  })

  if (!invoices.length) throw new Error('No matching drop-ship invoices found')

  // Load the single drop-ship customer map (shared across all drop-ship invoices
  // for the same retail customer email).
  const dropshipCustomerMap = await CustomerMap.findOne({
    shop,
    email: RETAIL_CUSTOMER_EMAIL,
  })

  // Load vendor bill snapshot for all invoices (for the audit trail).
  const wsOrderIds = invoices.map((i) => String(i.shopifyOrderId)).filter(Boolean)
  const vendorBillMap = await buildVendorBillMap(wsOrderIds)

  // Load order names for display.
  const orderRefs = invoices.map((i) => i.orderRef).filter(Boolean)
  const orders = await ShopifyOrder.find({ _id: { $in: orderRefs } })
    .select('_id shopifyOrderId shopifyOrderNumber shopifyOrderName')
    .lean()
  const orderByRef = new Map()
  for (const o of orders) orderByRef.set(o._id.toString(), o)

  const batchId = await generateBatchId()
  const invoiceDetails = []
  let totalInvoiceAmount = 0
  let totalVendorBillAmount = 0
  let successCount = 0
  let errorCount = 0
  const errors = []

  log.info('batch.start', {
    batchId,
    shop,
    invoiceCount: invoices.length,
    referenceNumber,
    processedBy,
  })

  for (const invoice of invoices) {
    const wsOrderId = String(invoice.shopifyOrderId || '')
    const bill = vendorBillMap.get(wsOrderId) || null
    const order = orderByRef.get(invoice.orderRef?.toString())
    const orderName =
      order?.shopifyOrderName ||
      (order?.shopifyOrderNumber ? `#${order.shopifyOrderNumber}` : wsOrderId)

    const detail = {
      invoiceId: invoice._id,
      shopifyOrderId: wsOrderId,
      orderName,
      qboInvoiceId: invoice.qboInvoiceId || null,
      qboDocNumber: invoice.qboDocNumber || null,
      amountDue: invoice.amountDue,
      currency: invoice.currency || 'USD',
      vendorBillId: bill?.billId || null,
      vendorBillDocNumber: bill?.docNumber || null,
      vendorBillAmount: bill?.amount ?? null,
      vendorBillPaymentStatus: bill?.paymentStatus || null,
      markResult: 'skipped',
      markError: null,
    }

    // Skip already-paid or cancelled invoices — they shouldn't be in the list
    // but guard defensively.
    if (
      invoice.paymentStatus === 'paid' ||
      invoice.paymentStatus === 'cancelled'
    ) {
      detail.markResult = 'skipped'
      detail.markError = `Invoice already ${invoice.paymentStatus}`
      invoiceDetails.push(detail)
      continue
    }

    const outstanding = Number((invoice.amountDue - invoice.amountPaid).toFixed(2))
    if (outstanding <= 0) {
      detail.markResult = 'skipped'
      detail.markError = 'Outstanding balance is zero'
      invoiceDetails.push(detail)
      continue
    }

    try {
      // Use the drop-ship customer map. If it's missing (edge case: order
      // predates the customerMap), propagateSuccessfulPayment will still run
      // but QBO/Shopify sync may not record perfectly — the CRON PASS B will
      // catch it next tick.
      const customerMap = dropshipCustomerMap || null

      await recordManualPayment({
        invoice,
        customerMap,
        kind: 'cheque',
        reference: referenceNumber.trim(),
        amount: outstanding,
        receivedAt: payDate,
        recordedBy: processedBy,
        note: notes
          ? `Batch payment ${batchId}${notes ? ': ' + notes : ''}`
          : `Batch payment ${batchId}`,
      })

      // Append a batch-specific remark so the order history is clear.
      await appendInvoiceRemark(invoice._id, {
        kind: 'admin_action',
        message: `Batch payment ${batchId} — ref: ${referenceNumber.trim()} — $${outstanding.toFixed(2)} marked paid`,
        amount: 0,
        currency: invoice.currency || 'USD',
        source: 'admin',
      })

      detail.markResult = 'success'
      totalInvoiceAmount += outstanding
      if (bill?.amount != null) totalVendorBillAmount += Number(bill.amount)
      successCount += 1

      log.info('batch.invoice.success', {
        batchId,
        invoiceId: invoice._id.toString(),
        amount: outstanding,
      })
    } catch (err) {
      detail.markResult = 'error'
      detail.markError = err?.message || 'Unknown error'
      errorCount += 1
      errors.push(`Order ${orderName}: ${err?.message || 'Unknown error'}`)
      log.error('batch.invoice.error', {
        batchId,
        invoiceId: invoice._id.toString(),
        err,
      })
      console.error(`[batch] Failed to mark invoice ${invoice._id}:`, err?.message)
    }

    invoiceDetails.push(detail)
  }

  totalInvoiceAmount = Number(totalInvoiceAmount.toFixed(2))
  totalVendorBillAmount = Number(totalVendorBillAmount.toFixed(2))
  // Batch total = invoice total only (vendor bills are reconciled separately
  // by the ns-retail CRON; the admin's single cheque covers invoice amounts).
  const totalBatchAmount = totalInvoiceAmount

  const batchStatus =
    successCount === 0 ? 'failed' : errorCount > 0 ? 'partial' : 'completed'

  const batch = await AdminOrderBatch.create({
    batchId,
    shop,
    referenceNumber: referenceNumber.trim(),
    paymentDate: payDate,
    notes: notes?.trim() || undefined,
    totalInvoiceAmount,
    totalVendorBillAmount,
    totalBatchAmount,
    orderCount: successCount,
    invoiceIds: invoiceDetails
      .filter((d) => d.markResult === 'success')
      .map((d) => d.invoiceId),
    invoiceDetails,
    processedBy,
    processedAt: new Date(),
    status: batchStatus,
    successCount,
    errorCount,
    errors,
  })

  log.info('batch.done', {
    batchId,
    status: batchStatus,
    successCount,
    errorCount,
    totalInvoiceAmount,
    totalBatchAmount,
  })

  return batch
}

/**
 * Paginated list of past batch payments for the history UI.
 */
export async function listAdminOrderBatches({ shop, page = 1, pageSize = 10 }) {
  await connectDB()

  const skip = (Math.max(1, page) - 1) * pageSize
  const total = await AdminOrderBatch.countDocuments({ shop })
  const batches = await AdminOrderBatch.find({ shop })
    .sort({ processedAt: -1 })
    .skip(skip)
    .limit(pageSize)
    .lean()

  return { batches, total, page, pageSize }
}

/**
 * Aggregate stats for the analytics dashboard on the Payment History tab.
 * Returns all-time totals; monthly breakdown is computed client-side from
 * the loaded batch list.
 */
export async function getAdminOrderBatchStats({ shop }) {
  await connectDB()

  const [totals] = await AdminOrderBatch.aggregate([
    { $match: { shop } },
    {
      $group: {
        _id: null,
        totalBatches: { $sum: 1 },
        totalAmount: { $sum: '$totalBatchAmount' },
        totalOrders: { $sum: '$orderCount' },
        completedBatches: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
      },
    },
  ])

  return {
    totalBatches: totals?.totalBatches ?? 0,
    totalAmount: totals?.totalAmount ?? 0,
    totalOrders: totals?.totalOrders ?? 0,
    completedBatches: totals?.completedBatches ?? 0,
  }
}
