// CDO order — a Shopify order synchronized into the CDO Program.
//
// Owned by the CDO Program module and populated by the order-ingestion
// pipeline (webhooks.orders.create → cdo.service.ingestShopifyOrder).
//
// EVERY Shopify order is stored here with a complete snapshot (order info,
// customer, line items + quantities, pricing / discounts / taxes /
// shipping, payment, status + fulfillment). When the buyer used a
// practitioner referral code, the order is ATTRIBUTED — `attributed:true`,
// the practitioner* fields + `referral` snapshot are populated, a
// `commissionAmount` is computed, and linked `cdo_referrals` /
// `cdo_commissions` / `cdo_transactions` records are created by the
// pipeline. Orders with no (valid) code carry `attributed:false`,
// `practitionerId:null`, and `commissionAmount:0`.
//
// IMPORTANT: the CDO dashboard + practitioner aggregations treat
// `cdo_orders` as the program's REFERRAL revenue ledger, so every
// program-wide order aggregation scopes to `{ attributed: true }`. Don't
// sum the whole collection for "referral revenue".
//
// `strict: false` so the snapshot tolerates extra payload fields without
// dropping them as Shopify's order shape evolves.

import mongoose from "mongoose";

// Reused for billing + shipping address snapshots. Mirrors the address
// shape on cdo_applications.
const addressSchema = new mongoose.Schema(
  {
    name: String,
    line1: String,
    line2: String,
    city: String,
    province: String,
    zip: String,
    country: String,
    phone: String,
  },
  { _id: false, strict: false },
);

const lineItemSchema = new mongoose.Schema(
  {
    productId: String,
    variantId: String,
    sku: String,
    title: String,
    variantTitle: String,
    quantity: { type: Number, default: 0 },
    price: { type: Number, default: 0 },
    totalDiscount: { type: Number, default: 0 },
  },
  { _id: false },
);

// Immutable snapshot of the practitioner + discount the order was placed
// under. Same shape as cdo_applications.referral.
const referralSchema = new mongoose.Schema(
  {
    code: String,
    codeId: String,
    practitionerId: String,
    practitionerSource: {
      type: String,
      enum: ["wholesale", "cdo"],
      default: "wholesale",
    },
    practitionerName: String,
    practitionerEmail: { type: String, lowercase: true },
    discountPercent: { type: Number, default: 0 },
    commissionRate: { type: Number, default: null },
    linkedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const cdoOrderSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },

    // Whether this order resolved to an eligible practitioner referral
    // code. Program-wide order aggregations filter on this.
    attributed: { type: Boolean, default: false, index: true },

    practitionerId: { type: String, index: true },
    practitionerEmail: { type: String, lowercase: true, index: true },
    practitionerName: String,

    // ── Order identity ───────────────────────────────────────────────
    shopifyOrderId: { type: String, index: true }, // gid://shopify/Order/<id>
    orderName: String, // e.g. "#1001"
    orderNumber: String,

    // ── Customer ─────────────────────────────────────────────────────
    customerEmail: { type: String, lowercase: true },
    customerName: String,
    customer: {
      shopifyCustomerId: String, // gid
      firstName: String,
      lastName: String,
      email: { type: String, lowercase: true },
      phone: String,
    },

    // ── Products + quantities ────────────────────────────────────────
    lineItems: { type: [lineItemSchema], default: [] },

    // ── Money ────────────────────────────────────────────────────────
    currency: { type: String, default: "USD" },
    // `amount` = order gross total (total_price). Kept as the canonical
    // revenue figure read by the dashboards + payout flow.
    amount: { type: Number, default: 0 },
    // Commission accrued to the practitioner on this order (0 when not
    // attributed). Computed from the order subtotal × commissionRate.
    commissionAmount: { type: Number, default: 0 },
    pricing: {
      subtotal: { type: Number, default: 0 },
      totalDiscounts: { type: Number, default: 0 },
      totalTax: { type: Number, default: 0 },
      totalShipping: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },
    discountCodes: {
      type: [{ code: String, type: { type: String }, amount: Number }],
      default: [],
    },
    taxLines: {
      type: [{ title: String, rate: Number, price: Number }],
      default: [],
    },
    shippingLines: {
      type: [{ title: String, price: Number }],
      default: [],
    },

    // ── Addresses ────────────────────────────────────────────────────
    billingAddress: { type: addressSchema, default: null },
    shippingAddress: { type: addressSchema, default: null },

    // ── Payment + status ─────────────────────────────────────────────
    payment: {
      gateways: { type: [String], default: [] },
      financialStatus: String,
    },
    financialStatus: String, // paid, pending, refunded, …
    fulfillmentStatus: String, // fulfilled, partial, null, …

    // ── Referral attribution ─────────────────────────────────────────
    referral: { type: referralSchema, default: null },
    referralId: { type: mongoose.Schema.Types.ObjectId, ref: "CdoReferral" },
    referralCode: String,
    // Audit of HOW attribution was established: the customer's existing
    // cdo_applications mapping ("cdo_application"), or — for first-touch —
    // a cart/order attribute, a discount code on the order, or a
    // `CODE:`/`REFERRAL:` tag on the customer.
    attribution: {
      source: {
        type: String,
        enum: [
          "cdo_application",
          "note_attribute",
          "discount_code",
          "customer_tag",
          null,
        ],
        default: null,
      },
      code: String,
      matchedAt: Date,
    },

    status: {
      type: String,
      enum: ["pending", "approved", "paid", "cancelled"],
      default: "pending",
      index: true,
    },

    placedAt: { type: Date, index: true },
  },
  { collection: "cdo_orders", timestamps: true, strict: false },
);

// Idempotency: one document per Shopify order per shop. Lets the pipeline
// upsert safely against Shopify's at-least-once webhook delivery + replays.
cdoOrderSchema.index({ shop: 1, shopifyOrderId: 1 }, { unique: true });

export default mongoose.models.CdoOrder ||
  mongoose.model("CdoOrder", cdoOrderSchema);
