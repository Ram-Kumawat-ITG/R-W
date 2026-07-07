// READ-ONLY MIRROR of the `cdo_orders` collection owned by ns-retail.
//
// The wholesale app only READS this collection (Practitioner Portal —
// revenue/commission/referral-code aggregations). ns-retail is the source
// of truth and the only writer. `strict: false` keeps unknown fields
// readable — only the fields the portal's aggregations actually touch are
// declared below. Do not write to this collection from wholesale.
//
// Distinct from the existing `retailCdoOrder.server.js`, which is a much
// narrower mirror of the same collection scoped to the Admin Orders
// Vendor-Bill display — kept separate so the two unrelated consumers don't
// share a schema that has to satisfy both.

import mongoose from "mongoose";

const cdoOrderSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },

    practitionerId: { type: String, index: true },
    practitionerEmail: { type: String, lowercase: true },
    practitionerName: String,

    shopifyOrderId: String,
    orderName: String,

    customerEmail: { type: String, lowercase: true },
    customerName: String,

    currency: { type: String, default: "USD" },
    amount: { type: Number, default: 0 },
    commissionAmount: { type: Number, default: 0 },
    pricing: {
      subtotal: { type: Number, default: 0 },
      totalDiscounts: { type: Number, default: 0 },
      totalTax: { type: Number, default: 0 },
      totalShipping: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },

    referral: mongoose.Schema.Types.Mixed,
    referralCode: String,

    status: String,
    placedAt: { type: Date, index: true },
  },
  { collection: "cdo_orders", timestamps: true, strict: false },
);

cdoOrderSchema.index({ practitionerId: 1, placedAt: -1 });
cdoOrderSchema.index({ shop: 1, shopifyOrderId: 1 });

export default mongoose.models.CdoOrder ||
  mongoose.model("CdoOrder", cdoOrderSchema);
