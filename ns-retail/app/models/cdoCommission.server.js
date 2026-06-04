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

    // Admin pause control — when true the automated payout pipeline skips
    // this commission entirely (not auto-approved, not batched). Mirrors
    // the wholesale Invoice.autoChargePaused pattern; eligibility queries
    // filter `paused: { $ne: true }`. A paused commission still exists +
    // accrues to the ledger; it's just held out of payout until resumed.
    paused: { type: Boolean, default: false, index: true },
    pausedAt: { type: Date, default: null },
    pausedBy: { type: String, default: null },
    pauseNote: { type: String, default: null },
    resumedAt: { type: Date, default: null },
    resumedBy: { type: String, default: null },

    // ── Payout-dimension tracking ────────────────────────────────────
    // Distinct from the accrual `status` above. Reflects where this
    // commission sits in the automated payout pipeline + cumulative retry
    // history. Latest-state rollup; the per-run detail lives on
    // cdo_payout_batches.items[]. Statuses: pending (default, not yet run),
    // processing (selected into an in-flight batch), paid, failed, skipped
    // (eligible but below-minimum / open payout this run), paused
    // (individually held), cancelled (commission reversed).
    payoutStatus: {
      type: String,
      enum: ["pending", "processing", "paid", "failed", "skipped", "paused", "cancelled"],
      default: "pending",
      index: true,
    },
    payoutAttemptCount: { type: Number, default: 0 },
    lastPayoutAttemptAt: { type: Date, default: null },
    payoutDate: { type: Date, default: null },
    payoutFailureReason: { type: String, default: null },
    payoutTxnRef: { type: String, default: null }, // QBO BillPayment / Bill id
    lastBatchId: { type: mongoose.Schema.Types.ObjectId, ref: "CdoPayoutBatch", default: null },

    payoutId: { type: mongoose.Schema.Types.ObjectId, ref: "CdoPayout" },
    earnedAt: { type: Date, index: true },
  },
  { collection: "cdo_commissions", timestamps: true, strict: true },
);

export default mongoose.models.CdoCommission ||
  mongoose.model("CdoCommission", cdoCommissionSchema);
