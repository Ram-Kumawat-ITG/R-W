// POST /api/admin/admin-order-batch
//
// Creates a batch payment for a set of unpaid drop-ship invoices.
// The admin enters a cheque / reference number, payment date, and optional
// notes. Each selected invoice is marked paid and a batch audit record is
// stored. Vendor bills are reconciled automatically by the ns-retail
// processBillReconciliation CRON on its next tick.
//
// Body:
//   {
//     selectedInvoiceIds: string[],   // Invoice._id values to include
//     referenceNumber: string,         // cheque / EFT / bank ref
//     paymentDate: string,             // ISO date string
//     notes?: string,
//   }

import { authenticate } from '../../shopify.server'
import { createAdminOrderBatch } from '../../services/adminOrderBatch/adminOrderBatch.service'
import { sendResponse } from '../../services/APIService/api.service'

export async function action({ request }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let session
  try {
    const auth = await authenticate.admin(request)
    session = auth.session
  } catch {
    return sendResponse(401, 'error', 'Unauthorized', null)
  }

  let body
  try {
    body = await request.json()
  } catch {
    return sendResponse(400, 'error', 'Request body must be valid JSON', null)
  }

  const { selectedInvoiceIds, referenceNumber, paymentDate, notes } = body || {}

  if (!Array.isArray(selectedInvoiceIds) || selectedInvoiceIds.length === 0) {
    return sendResponse(400, 'error', 'selectedInvoiceIds must be a non-empty array', null)
  }
  if (!referenceNumber?.trim()) {
    return sendResponse(400, 'error', 'Reference number is required', null)
  }
  if (!paymentDate) {
    return sendResponse(400, 'error', 'Payment date is required', null)
  }

  const processedBy =
    session?.onlineAccessInfo?.associated_user?.email || session?.shop || 'admin'

  let batch
  try {
    batch = await createAdminOrderBatch({
      shop: session.shop,
      selectedInvoiceIds,
      referenceNumber,
      paymentDate,
      notes,
      processedBy,
    })
  } catch (err) {
    console.error('[api/admin-order-batch] createAdminOrderBatch threw:', err?.message || err)
    const isValidation =
      /required|not valid|no invoices|no matching/i.test(err?.message || '')
    return sendResponse(
      isValidation ? 400 : 500,
      'error',
      err?.message || 'Failed to create batch payment',
      null,
    )
  }

  return sendResponse(200, 'success', 'Batch payment created', {
    batchId: batch.batchId,
    status: batch.status,
    successCount: batch.successCount,
    errorCount: batch.errorCount,
    totalInvoiceAmount: batch.totalInvoiceAmount,
    totalBatchAmount: batch.totalBatchAmount,
    orderCount: batch.orderCount,
    errors: batch.errors,
  })
}
