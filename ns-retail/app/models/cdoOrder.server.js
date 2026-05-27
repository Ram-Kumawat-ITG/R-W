// CDO referral order — a Shopify order attributed to a CDO practitioner.
// Owned by the CDO Program module; populated by the (yet-to-be-built)
// referral-attribution pipeline. Schema + indexes only.

import mongoose from "mongoose";

const cdoOrderSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },

    practitionerId: { type: String, index: true },
    practitionerEmail: { type: String, lowercase: true, index: true },
    practitionerName: String,

    shopifyOrderId: { type: String, index: true },
    orderName: String,
    orderNumber: String,

    customerEmail: { type: String, lowercase: true },
    customerName: String,

    currency: { type: String, default: "USD" },
    amount: { type: Number, default: 0 },
    commissionAmount: { type: Number, default: 0 },

    referralId: { type: mongoose.Schema.Types.ObjectId, ref: "CdoReferral" },
    referralCode: String,

    status: {
      type: String,
      enum: ["pending", "approved", "paid", "cancelled"],
      default: "pending",
      index: true,
    },

    placedAt: { type: Date, index: true },
  },
  { collection: "cdo_orders", timestamps: true, strict: true },
);

export default mongoose.models.CdoOrder ||
  mongoose.model("CdoOrder", cdoOrderSchema);
