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
  { _id: false },
);

const taxSchema = new mongoose.Schema(
  {
    taxIdType: String,
    taxId: String,
    salesPermit: String,
    exemptState: String,
    itemsToResell: String,
    businessActivity: String,
  },
  { _id: false },
);

const paymentSchema = new mongoose.Schema(
  {
    method: String,
    cardholderName: String,
    cardBrand: String,
    cardLast4: String,
    cardNumberHash: String,
    cardExpMonth: Number,
    cardExpYear: Number,
  },
  { _id: false },
);

const signatureSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["drawn", "typed"] },
    value: String,
    signedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const wholesaleApplicationSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },

    firstName: String,
    lastName: String,
    email: { type: String, index: true },
    businessName: String,
    phone: String,
    passwordHash: String,

    billingAddress: addressSchema,
    shippingSameAsBilling: { type: Boolean, default: false },
    shippingAddress: { type: addressSchema, default: null },
    shippingPropertyType: String,
    credentials: { type: mongoose.Schema.Types.Mixed, default: {} },
    referrals: { type: mongoose.Schema.Types.Mixed, default: {} },

    referredBy: { type: mongoose.Schema.Types.Mixed, default: null },

    resellsProducts: { type: Boolean, default: false },
    tax: { type: taxSchema, default: null },

    payment: { type: paymentSchema, default: null },
    signature: { type: signatureSchema, default: null },

    termsAccepted: { type: Boolean, default: false },
    subscribeNews: { type: Boolean, default: false },

    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },
    submittedAt: { type: Date, default: Date.now },
  },
  { collection: "wholesale_applications", timestamps: true, strict: false },
);

export default mongoose.models.WholesaleApplication ||
  mongoose.model("WholesaleApplication", wholesaleApplicationSchema);
