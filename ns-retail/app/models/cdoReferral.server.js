// CDO referral — a prospect referred by a practitioner, tracked from
// first touch through conversion. Owned by the CDO Program module.
// Schema + indexes only.

import mongoose from "mongoose";

const cdoReferralSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },

    practitionerId: { type: String, index: true },
    practitionerEmail: { type: String, lowercase: true, index: true },
    practitionerName: String,

    referralCode: { type: String, index: true },
    referredEmail: { type: String, lowercase: true },
    referredName: String,

    status: {
      type: String,
      enum: ["pending", "converted", "expired"],
      default: "pending",
      index: true,
    },

    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "CdoOrder" },
    referredAt: { type: Date, index: true },
    convertedAt: Date,
  },
  { collection: "cdo_referrals", timestamps: true, strict: true },
);

export default mongoose.models.CdoReferral ||
  mongoose.model("CdoReferral", cdoReferralSchema);
