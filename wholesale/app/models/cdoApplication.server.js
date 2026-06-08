// READ-ONLY MIRROR of the `cdo_applications` collection owned by ns-retail.
//
// The wholesale app only READS this collection (Practitioner Portal —
// referred patient registration details). ns-retail is the source of
// truth and the only writer. `strict: false` keeps unknown fields readable.

import mongoose from "mongoose";

const cdoApplicationSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },

    applicantType: String, // e.g. 'patient'
    firstName: String,
    lastName: String,
    email: { type: String, index: true },

    billingAddress: mongoose.Schema.Types.Mixed,
    shippingAddress: mongoose.Schema.Types.Mixed,

    // referral.practitionerId is the tenant key for portal scoping
    referral: mongoose.Schema.Types.Mixed,

    status: String,
    customerId: String,
    submittedAt: Date,
    reviewedAt: Date,
  },
  { collection: "cdo_applications", timestamps: true, strict: false },
);

cdoApplicationSchema.index({ "referral.practitionerId": 1 });

export default mongoose.models.CdoApplication ||
  mongoose.model("CdoApplication", cdoApplicationSchema);
