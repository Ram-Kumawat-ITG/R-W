// READ-ONLY MIRROR of the `cdo_orders` collection owned by ns-retail.
//
// The wholesale app only READS this collection (Practitioner Portal
// dashboard). ns-retail is the source of truth and the only writer.
// `strict: false` so any field ns-retail adds is still readable here
// without a schema bump. Do NOT write to this model from the wholesale app.
//
// MAINTENANCE: if you start depending on a new field, add it below for
// clarity, but reads will work regardless. Keep ns-retail authoritative.

import mongoose from "mongoose";

const cdoOrderSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },
    shopifyOrderId: String,
    orderName: String,
    orderNumber: String,

    practitionerId: { type: String, index: true },
    practitionerEmail: String,
    practitionerName: String,
    referralCode: String,

    attributed: Boolean,
    attribution: mongoose.Schema.Types.Mixed,
    referral: mongoose.Schema.Types.Mixed,

    customer: mongoose.Schema.Types.Mixed,
    customerEmail: String,
    customerName: String,

    amount: Number,
    commissionAmount: Number,
    currency: String,
    pricing: mongoose.Schema.Types.Mixed,
    lineItems: [mongoose.Schema.Types.Mixed],

    financialStatus: String,
    fulfillmentStatus: String,
    status: String,

    placedAt: Date,
  },
  { collection: "cdo_orders", timestamps: true, strict: false },
);

export default mongoose.models.CdoOrder ||
  mongoose.model("CdoOrder", cdoOrderSchema);
