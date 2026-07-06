// READ-ONLY MIRROR of the `cdo_commissions` collection owned by ns-retail.
//
// The wholesale app only READS this collection (Practitioner Portal —
// commission totals + history). ns-retail is the source of truth and the
// only writer. `strict: false` keeps unknown fields readable.

import mongoose from "mongoose";

const cdoCommissionSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },

    practitionerId: { type: String, index: true },
    practitionerEmail: { type: String, lowercase: true },
    practitionerName: String,

    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "CdoOrder" },
    orderName: String,

    currency: { type: String, default: "USD" },
    amount: { type: Number, default: 0 },
    rate: { type: Number, default: 0 },

    status: {
      type: String,
      enum: ["pending", "approved", "paid", "reversed"],
    },
    payoutStatus: {
      type: String,
      enum: ["pending", "processing", "paid", "failed", "skipped", "paused", "cancelled"],
    },
    payoutFailureReason: String,
    payoutId: { type: mongoose.Schema.Types.ObjectId, ref: "CdoPayout" },

    earnedAt: { type: Date, index: true },
  },
  { collection: "cdo_commissions", timestamps: true, strict: false },
);

cdoCommissionSchema.index({ practitionerId: 1, earnedAt: -1 });
cdoCommissionSchema.index({ orderId: 1 });

export default mongoose.models.CdoCommission ||
  mongoose.model("CdoCommission", cdoCommissionSchema);
