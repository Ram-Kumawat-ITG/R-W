// READ-ONLY MIRROR of the `cdo_payouts` collection owned by ns-retail.
//
// The wholesale app only READS this collection (Practitioner Portal —
// payout history + commission-breakdown reconciliation). ns-retail is the
// source of truth and the only writer. `strict: false` keeps unknown
// fields readable — banking/QBO/settlement internals are intentionally
// left undeclared since the portal only displays a narrow summary.

import mongoose from "mongoose";

const cdoPayoutSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },
    practitionerId: { type: String, index: true },

    currency: { type: String, default: "USD" },
    amount: { type: Number, default: 0 },

    method: {
      type: String,
      enum: ["ach", "bank", "paypal", "check", "manual"],
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
    },

    commissionIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    qboBillId: String,
    reference: String,
    rejectionReason: String,

    periodStart: Date,
    periodEnd: Date,
    paidAt: Date,
  },
  { collection: "cdo_payouts", timestamps: true, strict: false },
);

cdoPayoutSchema.index({ practitionerId: 1, paidAt: -1 });

export default mongoose.models.CdoPayout ||
  mongoose.model("CdoPayout", cdoPayoutSchema);
