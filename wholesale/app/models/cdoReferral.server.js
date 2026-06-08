// READ-ONLY MIRROR of the `cdo_referrals` collection owned by ns-retail.
//
// The wholesale app only READS this collection (Practitioner Portal —
// referred customers/patients). ns-retail is the source of truth and the
// only writer. `strict: false` keeps unknown ns-retail fields readable.

import mongoose from "mongoose";

const cdoReferralSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },

    practitionerId: { type: String, index: true },
    practitionerEmail: String,
    practitionerName: String,

    referralCode: String,
    referredEmail: { type: String, index: true },
    referredName: String,

    status: { type: String, index: true }, // e.g. 'converted'
    orderId: mongoose.Schema.Types.ObjectId,

    referredAt: Date,
    convertedAt: Date,
  },
  { collection: "cdo_referrals", timestamps: true, strict: false },
);

export default mongoose.models.CdoReferral ||
  mongoose.model("CdoReferral", cdoReferralSchema);
