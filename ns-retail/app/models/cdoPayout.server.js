// CDO payout — a disbursement of accrued commissions to a practitioner,
// recorded in QuickBooks Online as a Vendor Bill + BillPayment. Owned by
// the CDO Program module. Schema + indexes only.
//
// Lifecycle (approve-then-auto-execute):
//   draft → awaiting_approval → approved → processing → paid
//                                    └→ rejected / cancelled, processing → failed
// A batch run aggregates eligible commissions into `awaiting_approval`
// rows; an admin approves; execution creates the QBO Bill + BillPayment
// and settles the linked commissions. Every transition appends a
// `remarks[]` audit entry (mirrors the wholesale Invoice.remarks ledger).

import mongoose from "mongoose";

// Check payout details — only populated for method: "check" payouts once
// the admin marks them paid after physically issuing the check.
const checkDetailsSchema = new mongoose.Schema(
  {
    checkNumber: { type: String, default: null },
    checkDate: { type: Date, default: null },
    mailedTo: { type: String, default: null },
    notes: { type: String, default: null },
    issuedBy: { type: String, default: null }, // admin email / actor
    issuedAt: { type: Date, default: null },
  },
  { _id: false },
);

// Append-only audit entry for the payout timeline.
const remarkSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: [
        "batch_created",
        "approved",
        "rejected",
        "bill_created",
        "payment_recorded",
        "bank_validated",
        "bank_invalid",
        "transfer_initiated",
        "settled",
        "returned",
        "settlement_pending",
        "failed",
        "cancelled",
        "check_issued",
        "system_note",
        "admin_action",
      ],
      default: "system_note",
    },
    message: String,
    actor: String, // admin email or "system"
    source: { type: String, enum: ["admin", "system", "cron"], default: "system" },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const cdoPayoutSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },

    practitionerId: { type: String, index: true },
    practitionerSource: {
      type: String,
      enum: ["cdo", "wholesale"],
      default: "wholesale",
    },
    practitionerEmail: { type: String, lowercase: true, index: true },
    practitionerName: String,

    currency: { type: String, default: "USD" },
    amount: { type: Number, default: 0 },

    method: {
      type: String,
      enum: ["ach", "bank", "paypal", "check", "manual"],
      default: "ach",
    },

    status: {
      type: String,
      enum: [
        "draft",
        "awaiting_approval",
        "approved",
        "processing",
        "awaiting_settlement",
        "paid",
        "failed",
        "rejected",
        "cancelled",
      ],
      default: "awaiting_approval",
      index: true,
    },

    // The commissions this payout settles (cdo_commissions._id).
    commissionIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },

    // QBO accounting refs (CDO's own realm).
    qboVendorId: { type: String, default: null },
    qboBillId: { type: String, default: null },
    qboBillPaymentId: { type: String, default: null },
    billCreatedAt: { type: Date, default: null },
    paymentRecordedAt: { type: Date, default: null },

    // Destination commission banking used for this payout — a MASKED snapshot
    // captured at execution time from the canonical wholesale_applications
    // `commission` object (the source of truth). The full account number is
    // NEVER persisted here or logged; only the last4 + routing + name + type
    // are retained for audit / reconciliation. `bankingUpdatedAt` records which
    // version of the practitioner's banking (commission.updatedAt) was used.
    bankSnapshot: {
      accountName: { type: String, default: null },
      routingNumber: { type: String, default: null },
      accountLast4: { type: String, default: null },
      accountType: { type: String, default: null },
      sourcedFromPaymentAch: { type: Boolean, default: false },
      bankingUpdatedAt: { type: Date, default: null },
      capturedAt: { type: Date, default: null },
    },
    // Set when banking validation failed at execution time (missing/invalid
    // fields). Cleared once a valid snapshot is captured. Lets admins filter
    // payouts blocked on banking.
    bankingError: { type: String, default: null },

    // Check payout details — null for ACH payouts; populated by markCheckPayoutPaid
    // once the admin physically issues and records a check.
    checkDetails: { type: checkDetailsSchema, default: null },

    // ── Real-money disbursement + settlement ──
    // The QBO Bill records the LIABILITY at execution; the actual bank→bank
    // transfer is initiated through a payout provider (see app/services/payout)
    // and the QBO BillPayment + `paid` status are only set once the transfer
    // SETTLES (confirmed asynchronously by the settlement poll). ACH settles in
    // 1–3 business days and can be returned (R01 NSF, R02 closed, R03 no account…).
    providerName: { type: String, default: null }, // e.g. "sandbox" | "dwolla"
    providerTransferId: { type: String, default: null }, // provider's transfer id
    providerStatus: {
      type: String,
      enum: ["pending", "settled", "returned", "failed", null],
      default: null,
    },
    transferInitiatedAt: { type: Date, default: null },
    transferAttemptCount: { type: Number, default: 0 }, // increments per (re)try
    settledAt: { type: Date, default: null }, // funds confirmed settled
    settlementLastCheckedAt: { type: Date, default: null }, // last poll
    // ACH return capture (set when a settled-looking transfer is reversed).
    returnCode: { type: String, default: null }, // e.g. "R01"
    returnReason: { type: String, default: null },
    returnedAt: { type: Date, default: null },

    // Approval audit.
    approvedBy: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    rejectedBy: { type: String, default: null },
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: null },

    lastError: { type: String, default: null },
    remarks: { type: [remarkSchema], default: [] },

    periodStart: Date,
    periodEnd: Date,
    reference: String,
    paidAt: Date,
  },
  { collection: "cdo_payouts", timestamps: true, strict: true },
);

// One open payout per practitioner per period — the batch builder uses
// this to stay idempotent. Partial filter so only in-flight payouts are
// constrained (rejected/cancelled/paid rows don't block a fresh run).
cdoPayoutSchema.index(
  { practitionerId: 1, periodEnd: 1 },
  {
    partialFilterExpression: {
      status: { $in: ["draft", "awaiting_approval", "approved", "processing"] },
    },
  },
);

export default mongoose.models.CdoPayout ||
  mongoose.model("CdoPayout", cdoPayoutSchema);
