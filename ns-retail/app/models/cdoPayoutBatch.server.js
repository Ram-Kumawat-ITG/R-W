// CDO payout batch — one durable record per execution of the automated
// commission-payout pipeline (process-commission-payouts CRON, or a manual
// reprocess). Owned by the CDO Program module.
//
// A batch snapshots WHICH commissions a run processed and their per-commission
// outcome, so every automated run is traceable + reconcilable after the fact.
// It does NOT introduce a new money path — payouts are still settled by
// cdo.service.executeApprovedPayout (QBO Bill + BillPayment), guarded by the
// payoutId reservation + the partial-unique cdo_payouts index. The batch is
// the audit layer on top.
//
// Lifecycle:  running → completed | completed_with_errors | failed

import mongoose from "mongoose";

// Per-commission outcome within this batch run. `attempt` is the cumulative
// payout attempt number for the commission (carried from cdo_commissions),
// `txnRef` is the external (QBO) settlement reference.
const batchItemSchema = new mongoose.Schema(
  {
    commissionId: { type: mongoose.Schema.Types.ObjectId, ref: "CdoCommission" },
    practitionerId: String,
    practitionerEmail: { type: String, lowercase: true },
    orderName: String,
    amount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["processing", "paid", "failed", "skipped", "cancelled"],
      default: "processing",
    },
    attempt: { type: Number, default: 1 },
    failureReason: { type: String, default: null },
    txnRef: { type: String, default: null }, // QBO BillPayment / Bill id
    payoutId: { type: mongoose.Schema.Types.ObjectId, ref: "CdoPayout" },
    payoutDate: { type: Date, default: null },
  },
  { _id: false },
);

const cdoPayoutBatchSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },

    // Human-readable batch id, e.g. CDOB-20260604T0837-a1b2.
    reference: { type: String, index: true },

    mode: {
      type: String,
      enum: ["cron", "manual_reprocess"],
      default: "cron",
      index: true,
    },
    trigger: String, // the Agenda tick label ("dev" / "monthly" / "reprocess")

    executionTime: { type: Date, index: true },
    startedAt: Date,
    completedAt: Date,

    status: {
      type: String,
      enum: ["running", "completed", "completed_with_errors", "failed"],
      default: "running",
      index: true,
    },

    totalCommissions: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },
    successCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    skippedCount: { type: Number, default: 0 },

    // cdo_payouts created/processed by this run.
    payoutIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },

    // Per-practitioner rollup — ONE entry per practitioner paid in this run
    // (one aggregated payout per practitioner, not per commission). Makes
    // "who was paid + how much + how many commissions" reconcilable straight
    // off the batch. Mirrors the cdo_payouts the batch created/processed.
    practitionerPayouts: {
      type: [
        new mongoose.Schema(
          {
            practitionerId: String,
            practitionerName: String,
            practitionerEmail: { type: String, lowercase: true },
            payoutId: { type: mongoose.Schema.Types.ObjectId, ref: "CdoPayout" },
            commissionCount: { type: Number, default: 0 },
            totalAmount: { type: Number, default: 0 },
            status: String, // the cdo_payouts status (paid / failed / approved / …)
            txnRef: { type: String, default: null }, // QBO BillPayment / Bill id
          },
          { _id: false },
        ),
      ],
      default: [],
    },

    items: { type: [batchItemSchema], default: [] },

    // Whole-run failure (e.g. DB error) — distinct from per-payout failures
    // which land on individual items.
    error: { type: String, default: null },
  },
  { collection: "cdo_payout_batches", timestamps: true, strict: true },
);

cdoPayoutBatchSchema.index({ shop: 1, createdAt: -1 });
// Cross-batch history for a single commission ("every attempt on X").
cdoPayoutBatchSchema.index({ "items.commissionId": 1 });

export default mongoose.models.CdoPayoutBatch ||
  mongoose.model("CdoPayoutBatch", cdoPayoutBatchSchema);
