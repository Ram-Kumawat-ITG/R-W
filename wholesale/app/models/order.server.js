import mongoose from 'mongoose'

// Local mirror of every Shopify order we've ingested via webhook.
// The Shopify payload is stored raw under `rawPayload` so we can replay
// downstream processing without re-hitting the Shopify Admin API.
const orderSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true, required: true },

    shopifyOrderId: { type: String, required: true, index: true },
    shopifyOrderNumber: String,
    shopifyOrderName: String,

    customerEmail: { type: String, lowercase: true, index: true },
    shopifyCustomerId: String,

    currency: String,
    totalAmount: Number,
    financialStatus: String,
    fulfillmentStatus: String,

    // Processing pipeline state for this order. Distinct from invoice
    // payment state — this only tracks the orchestrator's progress.
    //
    // `cancelled` is a terminal state set by the orders/cancelled
    // webhook handler (see services/order/order.service.handleOrder-
    // Cancelled). Distinct from `rejected` — rejected means "we
    // never processed this because it was invalid"; cancelled means
    // "Shopify cancelled it after the fact". TERMINAL_STATUSES
    // (orchestrator) includes both so late-arriving orders/create
    // re-deliveries don't re-process either.
    processingStatus: {
      type: String,
      enum: [
        'received',
        'processing', // claimed atomically by one worker — guards against duplicate QBO invoices
        'pending_approval', // customer lacks "Approved" tag; held until admin approves, then auto-replayed
        'rejected',
        'customer_ready',
        'invoiced',
        'scheduled',
        'completed',
        'failed',
        'cancelled',
      ],
      default: 'received',
      index: true,
    },
    processingError: String,
    rejectionCode: String,

    // Cancellation metadata — set by the orders/cancelled webhook
    // handler. `cancelReason` carries Shopify's enum value
    // ('customer', 'fraud', 'inventory', 'declined', 'other').
    // `cancelledAt` is Shopify's timestamp, not ours, so re-deliveries
    // don't drift it.
    cancelledAt: Date,
    cancelReason: String,

    // Latest Shopify webhook-id we've observed for this order. Shopify
    // retries webhooks with the SAME id on at-least-once delivery, so
    // this is the cheapest dedup key. Array of all seen IDs for audit.
    lastWebhookId: { type: String, index: true },
    seenWebhookIds: { type: [String], default: [] },

    // Lock metadata so stale `processing` states (crashed mid-flight)
    // can be reclaimed by a follow-up run after a timeout.
    processingClaimedAt: Date,

    qboInvoiceId: { type: String, index: true },
    invoiceRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },

    // Payment lifecycle mirror — updated when the scheduler completes a
    // successful charge so the order doc reflects the final state
    // without a JOIN to the invoice doc.
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed'],
      default: 'pending',
      index: true,
    },
    paidAt: Date,
    nmiTransactionId: String,
    shopifyPaidSyncedAt: Date,

    rawPayload: mongoose.Schema.Types.Mixed,
    receivedAt: { type: Date, default: Date.now },
    completedAt: Date,
  },
  { collection: 'shopify_orders', timestamps: true, strict: true },
)

// Idempotency: a single Shopify order should only ever produce one local row.
orderSchema.index({ shop: 1, shopifyOrderId: 1 }, { unique: true })

export default mongoose.models.ShopifyOrder || mongoose.model('ShopifyOrder', orderSchema)
