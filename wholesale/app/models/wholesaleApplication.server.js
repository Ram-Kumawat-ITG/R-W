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

// IRS Form W-9 — only the fields not already on the parent doc.
// Name + business name + address + TIN (SSN/EIN) live elsewhere; the
// W-9 PDF rendering pipeline reads from both this sub-doc and the
// parent. `signature` mirrors the top-level `signature` shape; it
// represents the separate IRS perjury certification (NOT the same as
// the terms-acceptance signature). `submittedAt` is when the W-9 form
// itself was signed, which is the date that needs to appear on the
// PDF copy filed with the IRS.
const w9Schema = new mongoose.Schema(
  {
    legalName: String,
    taxClassification: {
      type: String,
      enum: [
        "individual",
        "c_corp",
        "s_corp",
        "partnership",
        "trust_estate",
        "llc",
        "other",
      ],
    },
    llcClassification: { type: String, enum: ["C", "S", "P", null] },
    otherClassification: String,
    exemptPayeeCode: String,
    fatcaCode: String,
    signature: { type: signatureSchema, default: null },
    submittedAt: { type: Date, default: null },
  },
  { _id: false },
);

// Commission payout — separate from `payment` (which is HOW the
// practitioner pays us). This is HOW WE PAY THEM commissions.
//
// Two payout methods (selected at signup, captured in `payoutMethod`):
//   - 'ach'   — direct deposit to a bank account (bankAccount* fields)
//   - 'check' — paper check mailed to an address (check.* fields)
//
// Sensitive ACH fields (account number) are AES-256-GCM encrypted at
// rest via utils/crypto.utils.js — only the last 4 digits ever appear
// in plaintext. Check fields are PII but not sensitive enough to
// encrypt (name + mailing address — same level as shippingAddress).
//
// Existing rows pre-dating the `payoutMethod` field implicitly default
// to 'ach' because every legacy row carries bank fields and no check
// fields. The default below makes this explicit on new writes.
const commissionCheckSchema = new mongoose.Schema(
  {
    // Name printed on the check ("Pay to the order of …"). Falls back to
    // `${firstName} ${lastName}` on the application doc when blank.
    payableTo: String,
    // When true, mail the check to the application's billingAddress.
    // When false, use the embedded mailingAddress below.
    //
    // Why billing (not shipping): checks are financial documents and
    // commonly travel with invoice mail / accountant routing — same
    // pattern as 1099 distribution. Shipping address is for product
    // parcels and may be a clinic/warehouse, not finance.
    useBillingAddress: { type: Boolean, default: true },
    mailingAddress: { type: addressSchema, default: null },
  },
  { _id: false },
);

const commissionSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    // Payout method chosen at signup. `null` only on truly-legacy rows
    // (pre-2026-06-29 schema) — code paths default these to 'ach' for
    // back-compat since every legacy row has bank fields populated.
    payoutMethod: {
      type: String,
      enum: ['ach', 'check'],
      default: 'ach',
    },
    // ── ACH bank fields (used when payoutMethod === 'ach') ─────────
    bankAccountName: String,
    bankRoutingNumber: String,
    // Legacy plaintext field — kept for back-compat with rows written
    // before the encryption migration. New writes ONLY populate
    // bankAccountEncrypted (AES-256-GCM, see utils/crypto.utils.js).
    bankAccountNumber: String,
    bankAccountEncrypted: String,
    bankAccountLast4: String,
    bankAccountType: String,
    // True when the practitioner ticked "use same as payment ACH" — kept
    // for audit so we know whether to keep the two accounts in sync if
    // the payment ACH later changes.
    sourcedFromPaymentAch: { type: Boolean, default: false },

    // ── Check fields (used when payoutMethod === 'check') ──────────
    check: { type: commissionCheckSchema, default: null },

    updatedAt: { type: Date, default: Date.now },
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

    // Commission payout bank account (Step 3 — collapsed by default).
    // null when the practitioner opted out at signup; admin can add
    // later via /api/admin/customers/:id/commission-bank.
    commission: { type: commissionSchema, default: null },

    // IRS Form W-9 (Step 4 — required). null until submitted.
    w9: { type: w9Schema, default: null },

    termsAccepted: { type: Boolean, default: false },
    subscribeNews: { type: Boolean, default: false },

    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "blocked"],
      default: "pending",
      index: true,
    },
    submittedAt: { type: Date, default: Date.now },
    reviewedAt: { type: Date, default: null },
    blockedAt: { type: Date, default: null },

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

    // Mirror of this practitioner on the retail Shopify store. Set by
    // services/retailSync/practitioner.service.js when the wholesale
    // customers/create webhook fires for an Approved practitioner. Used
    // for subsequent update/delete syncs — looking up by email each time
    // would be slower and brittle. Full GID: gid://shopify/Customer/<id>.
    retailShopifyCustomerId: { type: String, default: null, index: true },
  },
  { collection: "wholesale_applications", timestamps: true, strict: false },
);

export default mongoose.models.WholesaleApplication ||
  mongoose.model("WholesaleApplication", wholesaleApplicationSchema);
