// CDO application — the home collection for CDO Program CUSTOMER users.
//
// User-type model:
//   • Practitioners → wholesale_applications  (own + share referral codes)
//   • Customers     → cdo_applications         (Retailer + Patient)  ← this
//
// A customer application may carry a `referral` snapshot that maps the
// customer back to a practitioner (in wholesale_applications) via the
// referral code they applied with — making the customer eligible for the
// discount configured on that code. Customers without a code carry
// `referral: null` and receive no referral discount.
//
// The referral snapshot is captured at submit time (see
// cdo.service.buildReferralSnapshot) so the discount + practitioner link
// the customer signed up under stay fixed even if the practitioner later
// edits or archives the code.
//
// `strict: false` so we tolerate extra fields written by the registration
// flow / future schema growth without dropping them.

import mongoose from "mongoose";

const addressSchema = new mongoose.Schema(
  {
    line1: String,
    line2: String,
    city: String,
    state: String,
    zip: String,
    country: String,
    type: String,
  },
  { _id: false, strict: false },
);

// Immutable snapshot of the practitioner + discount a customer applied
// under. Mirrors the resolved shape from cdo.service.validateReferralCode.
const referralSchema = new mongoose.Schema(
  {
    code: { type: String, uppercase: true, trim: true },
    codeId: String,
    practitionerId: String,
    practitionerSource: {
      type: String,
      enum: ["wholesale", "cdo"],
      default: "wholesale",
    },
    practitionerName: String,
    practitionerEmail: { type: String, lowercase: true },
    discountPercent: { type: Number, default: 0 }, // fraction, e.g. 0.15
    commissionRate: { type: Number, default: null },
    linkedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const cdoApplicationSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },

    // Which kind of customer this application is for.
    applicantType: {
      type: String,
      enum: ["retailer", "patient"],
      required: true,
      index: true,
    },

    firstName: String,
    lastName: String,
    email: { type: String, index: true },
    businessName: String, // retailer applications
    phone: String,
    passwordHash: String,

    billingAddress: { type: addressSchema, default: null },
    shippingAddress: { type: addressSchema, default: null },

    // Referral mapping → practitioner. null when the customer applied
    // with no (valid) referral code. Indexed on practitionerId so we can
    // list a practitioner's referred customers.
    referral: { type: referralSchema, default: null },

    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },
    submittedAt: { type: Date, default: Date.now },
    reviewedAt: { type: Date, default: null },

    customerId: { type: String, index: true },
  },
  { collection: "cdo_applications", timestamps: true, strict: false },
);

// Reverse lookup: a practitioner's referred customers.
cdoApplicationSchema.index({ "referral.practitionerId": 1 });

export default mongoose.models.CdoApplication ||
  mongoose.model("CdoApplication", cdoApplicationSchema);
