// CDO transaction — an append-only ledger entry against a practitioner's
// running balance (commission credit, payout debit, manual adjustment,
// reversal). Owned by the CDO Program module. Schema + indexes only.

import mongoose from "mongoose";

const cdoTransactionSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },

    practitionerId: { type: String, index: true },
    practitionerEmail: { type: String, lowercase: true, index: true },
    practitionerName: String,

    type: {
      type: String,
      enum: ["commission", "payout", "adjustment", "reversal"],
      required: true,
      index: true,
    },

    currency: { type: String, default: "USD" },
    amount: { type: Number, default: 0 },
    balanceAfter: Number,

    relatedType: String,
    relatedId: mongoose.Schema.Types.ObjectId,

    description: String,
    occurredAt: { type: Date, index: true },
  },
  { collection: "cdo_transactions", timestamps: true, strict: true },
);

export default mongoose.models.CdoTransaction ||
  mongoose.model("CdoTransaction", cdoTransactionSchema);
