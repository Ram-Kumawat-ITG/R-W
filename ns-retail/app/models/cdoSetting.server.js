// CDO Program configuration — a single settings document per shop.
// `singletonKey` carries a unique index so the upsert can only ever
// maintain one config row. Owned by the CDO Program module.

import mongoose from "mongoose";

const cdoSettingSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },
    singletonKey: { type: String, default: "cdo-program", unique: true },

    programName: { type: String, default: "CDO Program" },
    defaultCommissionRate: { type: Number, default: 0.1 },
    currency: { type: String, default: "USD" },

    payoutSchedule: {
      type: String,
      enum: ["weekly", "biweekly", "monthly"],
      default: "monthly",
    },
    minimumPayoutAmount: { type: Number, default: 50 },
    autoApproveCommissions: { type: Boolean, default: false },
    cookieWindowDays: { type: Number, default: 30 },
  },
  { collection: "cdo_settings", timestamps: true, strict: true },
);

export default mongoose.models.CdoSetting ||
  mongoose.model("CdoSetting", cdoSettingSchema);
