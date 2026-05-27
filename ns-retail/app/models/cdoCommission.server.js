// CDO commission — an amount earned by a practitioner on an attributed
// order. Owned by the CDO Program module. Schema + indexes only.

import mongoose from "mongoose";

const cdoCommissionSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },

    practitionerId: { type: String, index: true },
    practitionerEmail: { type: String, lowercase: true, index: true },
    practitionerName: String,

    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "CdoOrder" },
    orderName: String,

    currency: { type: String, default: "USD" },
    amount: { type: Number, default: 0 },
    rate: { type: Number, default: 0 },

    status: {
      type: String,
      enum: ["pending", "approved", "paid", "reversed"],
      default: "pending",
      index: true,
    },

    payoutId: { type: mongoose.Schema.Types.ObjectId, ref: "CdoPayout" },
    earnedAt: { type: Date, index: true },
  },
  { collection: "cdo_commissions", timestamps: true, strict: true },
);

export default mongoose.models.CdoCommission ||
  mongoose.model("CdoCommission", cdoCommissionSchema);
