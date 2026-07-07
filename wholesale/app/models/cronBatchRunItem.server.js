import mongoose from 'mongoose'

// Per-invoice line items for a CronBatchRun — the "what exactly did this
// batch do" breakdown behind the Orders page's CRON Batch history table.
// One row per invoice PASS 1 (the card/ACH charge pass) attempted; kept
// in a separate collection (not embedded on CronBatchRun) so a batch
// with many invoices doesn't bloat the summary document the history
// list re-reads on every page view — items are only fetched when an
// admin expands a specific batch.
//
// Written once, in bulk, right after PASS 1 finishes — see
// services/scheduler/jobs/processPendingPayments.job.js.
const cronBatchRunItemSchema = new mongoose.Schema(
  {
    batchRunRef: { type: mongoose.Schema.Types.ObjectId, ref: 'CronBatchRun', required: true, index: true },

    shopifyOrderId: String,
    // Display label ("#1141") — falls back to shopifyOrderId when the
    // linked ShopifyOrder couldn't be resolved at write time.
    orderLabel: String,
    orderDate: Date,

    // Practitioner = the wholesale customer who placed (and is being
    // charged for) this order — there is no separate "customer" on a
    // wholesale invoice; a patient/referral relationship only exists in
    // the unrelated ns-retail commission pipeline.
    practitionerEmail: String,
    practitionerName: String,

    qboInvoiceId: String,
    qboDocNumber: String,
    currency: { type: String, default: 'USD' },
    // The amount this attempt was for — the invoice's outstanding
    // balance immediately BEFORE the charge attempt, not necessarily its
    // original total (a prior partial payment could have reduced it).
    // Deliberately NOT the post-charge balance, which is $0 for any
    // fully-approved charge and would misrepresent what was actually
    // invoiced/attempted.
    invoiceAmount: Number,
    // Card 3% / ACH 1% processing fee already baked into the invoice —
    // shown here instead of a "commission" figure, since this CRON has
    // no relationship to practitioner referral commissions (a separate,
    // ns-retail-owned pipeline on its own schedule).
    processingFeeAmount: Number,

    // Result of THIS batch's charge attempt.
    outcome: { type: String, enum: ['approved', 'declined', 'errored', 'skipped'], required: true },
    // Human-readable detail (decline reason / error message / skip
    // reason) — same text as the invoice's own remarks[] entry for this
    // attempt.
    detail: String,
  },
  { collection: 'cron_batch_run_items', timestamps: true, strict: true },
)

export default mongoose.models.CronBatchRunItem ||
  mongoose.model('CronBatchRunItem', cronBatchRunItemSchema)
