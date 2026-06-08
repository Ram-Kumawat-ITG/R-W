// READ-ONLY MIRROR of the `cdo_commissions` collection owned by ns-retail.
//
// The wholesale app only READS this collection (Practitioner Portal).
// ns-retail is the source of truth and the only writer. `strict: false`
// keeps unknown ns-retail fields readable. Do NOT write from wholesale.

import mongoose from "mongoose";

const cdoCommissionSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },

    practitionerId: { type: String, index: true },
    practitionerEmail: String,
    practitionerName: String,

    orderId: mongoose.Schema.Types.ObjectId,
    orderName: String,

    amount: Number,
    rate: Number,
    currency: String,

    // earned-state of the commission: 'pending' | 'paid'
    status: { type: String, index: true },
    // payout-state once batched: 'paid' | 'failed' | 'paused'
    payoutStatus: { type: String, index: true },
    payoutId: mongoose.Schema.Types.ObjectId,
    lastBatchId: mongoose.Schema.Types.ObjectId,
    payoutFailureReason: String,

    paused: Boolean,
    earnedAt: Date,
  },
  { collection: "cdo_commissions", timestamps: true, strict: false },
);

export default mongoose.models.CdoCommission ||
  mongoose.model("CdoCommission", cdoCommissionSchema);
