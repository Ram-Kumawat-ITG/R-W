// CDO practitioner payout hold — an admin switch to pause ALL future
// commission payouts for one practitioner. Owned by the CDO Program module.
//
// Practitioners live in the read-only `wholesale_applications` mirror, so
// this practitioner-scoped flag can't be stamped there — it lives in its
// own collection keyed by `practitionerId` (the wholesale application _id,
// the same id the rest of the cdo_* collections use).
//
// When `paused` is true the automated payout pipeline excludes every one
// of the practitioner's commissions (not auto-approved, not batched). The
// hold does not reverse or unwind already-paid/batched payouts; it only
// gates future runs. Mirrors the per-commission pause + the wholesale
// auto-charge pause/resume pattern (who / when / why audit fields).

import mongoose from "mongoose";

const cdoPractitionerHoldSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },

    practitionerId: { type: String, required: true, unique: true },

    paused: { type: Boolean, default: false, index: true },
    pausedAt: { type: Date, default: null },
    pausedBy: { type: String, default: null },
    note: { type: String, default: null },
    resumedAt: { type: Date, default: null },
    resumedBy: { type: String, default: null },

    // Admin override: include this practitioner in the automated payout CRON
    // even though their preferred payout method is "check". When true,
    // buildPayoutBatch skips the check-preference short-circuit and falls
    // through to the standard ACH banking probe. Does not affect the paused
    // flag — a paused practitioner with cronOverride=true is still excluded.
    checkPayoutCronOverride: { type: Boolean, default: false },
    cronOverrideSetBy: { type: String, default: null },
    cronOverrideSetAt: { type: Date, default: null },
    cronOverrideNote: { type: String, default: null },
  },
  { collection: "cdo_practitioner_holds", timestamps: true, strict: true },
);

export default mongoose.models.CdoPractitionerHold ||
  mongoose.model("CdoPractitionerHold", cdoPractitionerHoldSchema);
