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
    // Payment due date as returned by QBO at invoice creation. Stored as
    // an ISO date string ("YYYY-MM-DD") to match QBO's date-only format
    // — Mongoose Date would coerce to UTC midnight and risk timezone
    // off-by-ones when rendered locally.
    qboDueDate: String,
    qboTxnDate: String,
    // Full-datetime due timestamp — order date + termsDays + termsMinutes
    // (see invoice.config.js). The local Order List "Overdue" indicator
    // and cheque-reminder UI compare against this rather than qboDueDate
    // so the INVOICE_TERMS_MINUTES testing knob can drive sub-day
    // granularity. qboDueDate remains the canonical value sent to QBO
    // (date-only, per QBO's DueDate field).
    dueAt: Date,

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

    // Payment method locked at invoice creation, sourced from the
    // customer's wholesale-application preference (mirrored on CustomerMap).
    //   card  — eligible for CRON auto-charge against the NMI vault
    //   check — held until an admin records a manual cheque, or falls back to card
    //   ach   — same manual treatment as check (per project decision)
    //
    // CAN be mutated post-creation by the cheque → card admin fallback
    // (api/admin/charge-card.js). For the immutable order-time
    // preference, see `customerPaymentPreference`. For what actually
    // settled the invoice, see `paymentSettledVia`.
    paymentMethod: {
      type: String,
      enum: ['card', 'check', 'ach'],
      default: 'card',
      index: true,
    },

    // Immutable snapshot of the customer's payment-method preference at
    // the moment this invoice was created. Even if the customer updates
    // their preference later (via /api/update-profile), this never
    // changes — historical orders display the preference they were
    // placed with. Display fallback for legacy invoices missing this
    // field: use `paymentMethod` (they were equal before the
    // cheque → card override existed).
    customerPaymentPreference: {
      type: String,
      enum: ['card', 'check', 'ach'],
    },

    // Method that actually settled (or last contributed to settling)
    // the invoice. Written on every successful payment event — an
    // approved NMI charge sets it to the active `paymentMethod`
    // ('card' or 'ach'), a manual cheque receipt sets it to 'check'
    // or 'ach'. Stays null while the invoice is unpaid; the display
    // layer falls back to "Active method" (`paymentMethod`) in that
    // case. Distinct from `paymentMethod` (current operational
    // method, mutable) and `customerPaymentPreference` (order-time
    // snapshot, immutable).
    paymentSettledVia: {
      type: String,
      enum: ['card', 'check', 'ach'],
    },
    paymentSettledAt: Date,

    // Lifecycle of the invoice's payment, independent of QBO's own status.
    //
    // Derived state — never set ad-hoc. Use deriveInvoicePaymentStatus
    // (invoice.utils.js) so payments feed into a consistent transition:
    //   pending          — no money received yet
    //   in_progress      — NMI sale call is currently in flight (lock)
    //   partially_paid   — 0 < amountPaid < amountDue
    //   paid             — amountPaid >= amountDue
    //   failed           — exhausted maxAttempts without settling
    //   cancelled        — kept for backward compatibility with any
    //                      pre-existing records; no UI path currently
    //                      writes this state
    paymentStatus: {
      type: String,
      enum: [
        'pending',
        'in_progress',
        'partially_paid',
        'paid',
        'failed',
        'cancelled',
      ],
      default: 'pending',
      index: true,
    },

    attemptCount: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 6 },
    lastAttemptAt: Date,
    lastAttemptError: String,

    // Ledger of manual (non-NMI) payments recorded against this invoice —
    // currently just cheque receipts. Append-only; one entry per admin
    // action on the Order Details page.
    manualPayments: {
      type: [
        new mongoose.Schema(
          {
            kind: { type: String, enum: ['cheque', 'ach'], required: true },
            reference: { type: String, required: true },
            amount: { type: Number, required: true },
            currency: String,
            receivedAt: { type: Date, default: Date.now },
            recordedBy: String,
            recordedAt: { type: Date, default: Date.now },
            note: String,
          },
          { _id: false },
        ),
      ],
      default: [],
    },

    // Append-only follow-up / remarks ledger surfaced on the Order List
    // page's Remarks column. Each entry is a single CRON-tick or admin
    // action's worth of activity. Distinct from PaymentAttempt (which
    // is the strict charge-attempt audit log) — remarks include
    // non-charge events too (cheque reminders, manual receipts,
    // failed-payment follow-ups). PaymentAttempt is the source of
    // truth for accounting; remarks[] is the source of truth for the
    // operator-facing "what has the system been doing for this
    // order" timeline.
    //
    // kinds:
    //   cron_card_attempt    — PASS 1 CRON tried to charge a card
    //   cron_cheque_reminder — PASS 1.5 CRON logged a reminder for a
    //                          pending cheque / ACH invoice (no charge
    //                          attempted — admins still need to act)
    //   cron_failed_followup — PASS 1.5 CRON noted a failed card
    //                          invoice that exhausted retries
    //   admin_action         — admin-driven settlement event (retry,
    //                          charge-card fallback, mark cheque paid)
    //   system_note          — any other system-generated note
    remarks: {
      type: [
        new mongoose.Schema(
          {
            kind: {
              type: String,
              enum: [
                'cron_card_attempt',
                'cron_cheque_reminder',
                'cron_failed_followup',
                'admin_action',
                'system_note',
              ],
              required: true,
            },
            message: { type: String, required: true },
            amount: Number,
            currency: String,
            source: { type: String, enum: ['cron', 'admin', 'system'], default: 'system' },
            createdAt: { type: Date, default: Date.now },
          },
          { _id: false },
        ),
      ],
      default: [],
    },

    paidAt: Date,

    // Per-side sync state. With partial payments, each payment event
    // needs its own QBO Payment record and its own Shopify transaction
    // — a single "did we sync?" boolean would skip the follow-up
    // payments. We track CUMULATIVE recorded amounts so partial
    // payments stay in lockstep across all three systems:
    //
    //   qboRecordedTotal       — sum of QBO Payment.TotalAmt we've created
    //   qboPaymentIds[]        — every QBO Payment.Id we've created
    //   shopifyRecordedTotal   — sum of Shopify transactions.kind=SALE we've created
    //   shopifyTransactionIds[]— every Shopify transaction.id we've created
    //
    // `qboPaymentRecorded` is now derived: true iff
    // qboRecordedTotal >= amountPaid (within 0.005). Kept as a stored
    // boolean for backward compat with the CRON PASS 2 cursor and to
    // avoid breaking pre-partial-payment invoices that have
    // qboPaymentRecorded=true but no cumulative-total recorded.
    // `shopifyMarkedPaid` stays as the binary orderMarkAsPaid signal,
    // fired once on full settlement (transactions handle the partial
    // mirror).
    qboPaymentRecorded: { type: Boolean, default: false },
    qboPaymentId: String, // first recorded QBO Payment.Id (legacy)
    qboRecordedTotal: { type: Number, default: 0 },
    qboPaymentIds: { type: [String], default: [] },
    shopifyMarkedPaid: { type: Boolean, default: false },
    shopifyMarkedPaidAt: Date,
    shopifyRecordedTotal: { type: Number, default: 0 },
    shopifyTransactionIds: { type: [String], default: [] },
    lastSyncError: String,

    // Processing-fee state — captures the per-method surcharge added to
    // the invoice at settlement time (card=3%, ach=1%, check=0% by
    // default). The fee is decided by the **actual settlement method**
    // (paymentMethod at the moment of payment), not the customer's
    // preference: a cheque-preferred customer who gets charged via the
    // admin charge-card fallback lands here with method='card', so the
    // 3% fee applies. processingFeeAmount > 0 with processingFeeAppliedAt
    // == null means "fee owed but not yet on QBO" — propagateSuccessful-
    // Payment retries the append on every run until it lands.
    processingFeeAmount: Number,
    processingFeeRate: Number,
    processingFeeMethod: { type: String, enum: ['card', 'ach', 'check'] },
    processingFeeAppliedAt: Date,
  },
  { collection: 'invoices', timestamps: true, strict: true },
)

invoiceSchema.index({ paymentStatus: 1, attemptCount: 1 })
// Hard guarantee at the DB level: at most one invoice per Shopify order
// per shop. If application-level checks ever race, the second insert
// throws E11000 instead of silently producing a duplicate QBO record.
invoiceSchema.index({ shop: 1, shopifyOrderId: 1 }, { unique: true })

export default mongoose.models.Invoice || mongoose.model('Invoice', invoiceSchema)
