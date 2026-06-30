// CDO commission-config audit ledger — one append-only row per change to a
// vendor's commission rate (set or remove). Owned by the CDO Program module;
// schema + indexes only. Powers the "Recent changes" history on the Commission
// Configuration settings tab and provides a forward-only audit trail (the live
// config lives on cdo_settings.vendorCommissions; orders snapshot the version).

import mongoose from "mongoose";

const cdoCommissionConfigHistorySchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },

    vendor: { type: String, required: true, index: true },
    action: { type: String, enum: ["set", "remove"], required: true },

    // Fractions (0.10 = 10%). previousPercent is null when the vendor had no
    // prior config; newPercent is null on a "remove".
    previousPercent: { type: Number, default: null },
    newPercent: { type: Number, default: null },

    // The cdo_settings.commissionConfigVersion AFTER this change.
    version: { type: Number, default: null },

    changedBy: { type: String, default: "system" }, // admin email or "system"
    changedAt: { type: Date, default: Date.now, index: true },
  },
  { collection: "cdo_commission_config_history", timestamps: false, strict: true },
);

cdoCommissionConfigHistorySchema.index({ shop: 1, changedAt: -1 });

export default mongoose.models.CdoCommissionConfigHistory ||
  mongoose.model(
    "CdoCommissionConfigHistory",
    cdoCommissionConfigHistorySchema,
  );
