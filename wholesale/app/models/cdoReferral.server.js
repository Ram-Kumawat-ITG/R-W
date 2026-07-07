// READ-ONLY MIRROR of the `cdo_referrals` collection owned by ns-retail.
//
// The wholesale app only READS this collection (Practitioner Portal —
// referred-patient list + patient counts). ns-retail is the source of
// truth and the only writer. `strict: false` keeps unknown fields readable.

import mongoose from "mongoose";

const cdoReferralSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },

    practitionerId: { type: String, index: true },
    practitionerEmail: { type: String, lowercase: true },
    practitionerName: String,

    referralCode: { type: String, index: true },
    referredEmail: { type: String, lowercase: true },
    referredName: String,

    status: {
      type: String,
      enum: ["pending", "converted", "expired"],
    },

    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "CdoOrder" },
    referredAt: { type: Date, index: true },
    convertedAt: Date,
  },
  { collection: "cdo_referrals", timestamps: true, strict: false },
);

export default mongoose.models.CdoReferral ||
  mongoose.model("CdoReferral", cdoReferralSchema);
