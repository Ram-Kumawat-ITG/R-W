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
        "failed",
        "cancelled",
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
