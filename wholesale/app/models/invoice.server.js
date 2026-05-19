import mongoose from 'mongoose'

// Local mirror of a QBO invoice. The retry scheduler scans this
// collection — never QBO directly — to decide which invoices need
// charging on the 15th / last-of-month tick.
const invoiceSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true, required: true },

    orderRef: { type: mongoose.Schema.Types.ObjectId, ref: 'ShopifyOrder', required: true },
    shopifyOrderId: { type: String, index: true },

    customerMapRef: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerMap' },
    customerEmail: { type: String, lowercase: true, index: true },

    // Optional during the brief window between claiming the (shop,
    // shopifyOrderId) slot and actually creating the invoice in QBO.
    // Set after the QBO POST succeeds.
    qboInvoiceId: { type: String, index: true },
    qboDocNumber: String,
    qboSyncToken: String,

    // Tracks the creation handshake so a crash mid-flight is recoverable:
    //   claimed  — Invoice row inserted, QBO call not yet attempted
    //   created  — QBO invoice created and id saved on this row
    //   failed   — QBO call returned an error
    qboCreationStatus: {
      type: String,
      enum: ['claimed', 'created', 'failed'],
      default: 'claimed',
      index: true,
    },
    qboCreationError: String,
    qboCreationClaimedAt: Date,

    currency: { type: String, default: 'USD' },
    amountDue: { type: Number, required: true },
    amountPaid: { type: Number, default: 0 },

    // Lifecycle of the invoice's payment, independent of QBO's own status.
    paymentStatus: {
      type: String,
      enum: ['pending', 'in_progress', 'paid', 'failed', 'cancelled'],
      default: 'pending',
      index: true,
    },

    attemptCount: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 6 },
    lastAttemptAt: Date,
    lastAttemptError: String,

    paidAt: Date,

    // Per-side sync state. After a successful NMI charge we need to
    // mirror "paid" into QBO and Shopify; either can fail independently.
    // Track them separately so an admin can see precisely what's out of
    // sync and a follow-up job can retry only the failed side.
    qboPaymentRecorded: { type: Boolean, default: false },
    qboPaymentId: String,
    shopifyMarkedPaid: { type: Boolean, default: false },
    shopifyMarkedPaidAt: Date,
    lastSyncError: String,
  },
  { collection: 'invoices', timestamps: true, strict: true },
)

invoiceSchema.index({ paymentStatus: 1, attemptCount: 1 })
// Hard guarantee at the DB level: at most one invoice per Shopify order
// per shop. If application-level checks ever race, the second insert
// throws E11000 instead of silently producing a duplicate QBO record.
invoiceSchema.index({ shop: 1, shopifyOrderId: 1 }, { unique: true })

export default mongoose.models.Invoice || mongoose.model('Invoice', invoiceSchema)
