// CDO payout — a disbursement of accrued commissions to a practitioner.
// Owned by the CDO Program module. Schema + indexes only.

import mongoose from "mongoose";

const cdoPayoutSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },

    practitionerId: { type: String, index: true },
    practitionerEmail: { type: String, lowercase: true, index: true },
    practitionerName: String,

    currency: { type: String, default: "USD" },
    amount: { type: Number, default: 0 },

    method: {
      type: String,
      enum: ["bank", "paypal", "check", "manual"],
      default: "manual",
    },

    status: {
      type: String,
      enum: ["pending", "processing", "paid", "failed"],
      default: "pending",
      index: true,
    },

    periodStart: Date,
    periodEnd: Date,
    reference: String,
    paidAt: Date,
  },
  { collection: "cdo_payouts", timestamps: true, strict: true },
);

export default mongoose.models.CdoPayout ||
  mongoose.model("CdoPayout", cdoPayoutSchema);
