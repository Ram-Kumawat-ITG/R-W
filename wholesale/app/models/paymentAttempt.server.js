import mongoose from 'mongoose'

// Append-only ledger of every NMI charge attempt. Stored separately
// from the invoice so we keep full audit history even after the
// invoice is paid/cancelled.
const paymentAttemptSchema = new mongoose.Schema(
  {
    invoiceRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true, index: true },
    qboInvoiceId: { type: String, index: true },

    attemptNumber: { type: Number, required: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },

    // Result of the NMI call, or 'manual_paid' for a cheque/ACH receipt
    // recorded by an admin from the Order Details page (no NMI fields set
    // on those rows — only attemptNumber, amount, and outcome).
    outcome: {
      type: String,
      enum: ['approved', 'declined', 'error', 'skipped', 'manual_paid'],
      required: true,
      index: true,
    },
    nmiTransactionId: String,
    nmiResponseCode: String,
    nmiResponseText: String,
    nmiAuthCode: String,
    nmiAvsResponse: String,
    nmiCvvResponse: String,

    errorMessage: String,
    rawResponse: mongoose.Schema.Types.Mixed,

    attemptedAt: { type: Date, default: Date.now, index: true },
  },
  { collection: 'payment_attempts', timestamps: true, strict: true },
)

export default mongoose.models.PaymentAttempt ||
  mongoose.model('PaymentAttempt', paymentAttemptSchema)
