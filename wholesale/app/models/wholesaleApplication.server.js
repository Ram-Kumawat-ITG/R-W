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

// `card`:
//   { cardholderName, cardBrand, cardLast4, paymentToken }
// `ach`:
//   { achAccountName, achRoutingNumber, achAccountLast4, achAccountType,
//     nmi_billing_id }   ← NMI customer-vault id created for the ACH
//                          payment method at registration submit. This is
//                          the identifier the CRON billing pass uses when
//                          paymentMethod === 'ach'. Distinct from the
//                          top-level `nmiCustomerVaultId` (which holds the
//                          card vault id). Snake-case to match the
//                          domain-spec naming.
const paymentSchema = new mongoose.Schema(
  {
    method: String,
    card: { type: mongoose.Schema.Types.Mixed, default: null },
    ach: { type: mongoose.Schema.Types.Mixed, default: null },
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

// Audit trail of payment-preference changes. One entry per change event
// (customer self-service via /api/update-profile, or an admin via
// /api/admin/customers/:id/payment-method). Each entry records the
// previous + new method, how many open invoices were realigned, the ids
// of those invoices, when, and who performed the change. Written by
// services/invoice/paymentPreference.applyPaymentPreferenceToOpenInvoices.
const paymentMethodHistorySchema = new mongoose.Schema(
  {
    previousMethod: String, // card | check | ach (normalized) | null
    newMethod: String, // card | check | ach (normalized)
    invoiceCount: { type: Number, default: 0 }, // open invoices realigned
    affectedInvoiceIds: { type: [String], default: [] },
    changedAt: { type: Date, default: Date.now },
    performedBy: String, // customer email or admin email
    source: { type: String, enum: ["customer", "admin"], required: true },
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
    paymentMethodHistory: { type: [paymentMethodHistorySchema], default: [] },
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
    reviewedAt: { type: Date, default: null },

    customerId: { type: String, index: true },
    nmiCustomerVaultId: { type: String, default: null },
    customerInviteSentAt: { type: Date, default: null },
    shopifyCreateFailed: { type: Boolean, default: false, index: true },
    shopifyCreateError: { type: String, default: null },

    // CDO Phase 1 — set when a practitioner referral code is auto-generated
    // at the end of a successful registration. Used as the idempotency key
    // to skip re-generation on retried submits and as the pointer to the
    // cdo_practitioner_codes row.
    cdoPractitionerCodeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CdoPractitionerCode",
      default: null,
      index: true,
    },
    cdoPractitionerCode: { type: String, default: null },
  },
  { collection: "wholesale_applications", timestamps: true, strict: false },
);

export default mongoose.models.WholesaleApplication ||
  mongoose.model("WholesaleApplication", wholesaleApplicationSchema);
