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

// ── Shipment tracking (populated by fulfillments/create|update webhooks) ──
// `fulfillments[]` is the current state (one row per Shopify fulfillment id,
// upserted in place). `trackingHistory[]` is an append-only audit trail.
const fulfillmentSchema = new mongoose.Schema(
  {
    fulfillmentId: { type: String, required: true },
    trackingNumber: String,
    trackingCompany: String, // carrier (Shopify tracking_company)
    trackingUrl: String,
    shipmentStatus: String, // carrier-driven shipment_status
    status: String, // fulfillment.status (pending/open/success/cancelled)
    fulfilledAt: Date,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const trackingHistorySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    fulfillmentId: String,
    trackingNumber: String,
    trackingCompany: String,
    shipmentStatus: String,
    event: { type: String, enum: ["created", "updated"] },
  },
  { _id: false },
);

// ── Retail QBO invoice (the QBO_RETAIL_* company — A/R "money in") ──
// Distinct from the CDO payouts QBO (Bills). Managed solely by
// services/retailQbo/* — the ingestion pipeline never writes this block.
// `syncLog[]` is an append-only audit of every QBO create/sync attempt.
const retailQboSchema = new mongoose.Schema(
  {
    qboCustomerId: String,
    qboInvoiceId: String,
    qboInvoiceDocNumber: String,
    qboInvoiceTotal: Number,
    qboSyncToken: String,
    invoiceUrl: String,
    qboCreatedAt: Date,
    // pending | creating | created | shipping_synced | error
    qboSyncStatus: { type: String, default: null },
    qboSyncedAt: Date,
    qboSyncError: { type: String, default: null },
    lastAttemptAt: Date,
    // Invoice email delivery (QBO send).
    invoiceSentAt: Date,
    invoiceEmailedTo: String,
    invoiceEmailStatus: String, // QBO EmailStatus (EmailSent / NeedToSend) or "error"
    // Shipment notification (invoice re-send carrying tracking). Deduped on
    // lastNotifiedTracking so the customer is emailed once per tracking change.
    lastShipmentNotifiedAt: Date,
    lastNotifiedTracking: String,
    // ── Payment (mark the invoice Paid in QBO when Shopify is paid) ──
    // A QBO Payment is created against the invoice once the Shopify order is
    // paid, fully applying it so QBO shows the invoice Paid. References are
    // captured so QBO ↔ Shopify reconcile.
    qboPaymentId: String, // QBO Payment entity id
    qboPaymentRefNum: String, // QBO Payment PaymentRefNum (the reference number)
    qboPaymentTotal: Number,
    qboPaymentUrl: String, // deep link to the payment in QBO
    shopifyTransactionId: String, // gid://shopify/OrderTransaction/<id>
    shopifyPaymentGateway: String,
    paymentAppliedAt: Date,
    // pending | creating | paid | error | skipped
    paymentSyncStatus: { type: String, default: null },
    paymentSyncError: { type: String, default: null },
    // QBO invoice settlement state mirrored from QBO: open | paid
    invoiceStatus: { type: String, default: null },
    // ── Vendor Bill (A/P "money out") ──
    // In addition to the customer Invoice (A/R), each dropship order records a
    // QBO Vendor Bill in the SAME retail company against the wholesale supplier
    // ("Natural Solution Wholesale") for what the retail store owes for the
    // dropship — mirroring the wholesale invoice for the same order (per-product
    // lines at the wholesale price factor + shipping). Created UNPAID. Managed
    // solely by services/retailQbo/retailVendorBill.service. This block is the
    // Shopify Order ↔ Retail Invoice ↔ Retail Vendor Bill mapping.
    qboVendorId: String, // QBO Vendor entity id (the wholesale supplier)
    qboBillId: String, // QBO Bill entity id
    qboBillDocNumber: String,
    qboBillTotal: Number,
    qboBillSyncToken: String,
    billUrl: String, // deep link to the bill in QBO
    billCreatedAt: Date,
    // pending | creating | created | error
    billSyncStatus: { type: String, default: null },
    billSyncedAt: Date,
    billSyncError: { type: String, default: null },
    billLastAttemptAt: Date,
    // ── Bill reconciliation (mark the vendor bill PAID when the wholesale
    //    dropship invoice for the same order is paid) ──
    // The reconciler (services/retailQbo/retailBillReconcile.service) watches
    // the shared DB: when the WHOLESALE QBO dropship invoice mapped to this
    // order (via dropship_mappings) settles, it records a Retail QBO
    // BillPayment fully applying to the bill (→ Paid) and captures the full
    // five-way mapping below. References are the Shopify-order ↔ retail-bill ↔
    // wholesale-invoice ↔ wholesale-payment ↔ retail-bill-payment chain.
    wholesaleInvoiceMongoId: String, // wholesale `invoices` _id (for traceability)
    wholesaleQboInvoiceId: String, // QBO Invoice id in the WHOLESALE company
    wholesaleQboPaymentId: String, // QBO Payment id in the WHOLESALE company
    qboBillPaymentId: String, // QBO BillPayment id in THIS (retail) company
    billPaymentUrl: String, // deep link to the bill payment in QBO
    billPaymentTotal: Number,
    billPaymentAppliedAt: Date,
    // Vendor-bill payment state: unpaid | paid
    billPaymentStatus: { type: String, default: null },
    // Reconciliation processing state: pending | reconciling | paid | error
    billReconcileStatus: { type: String, default: null },
    billReconcileError: { type: String, default: null },
    billReconciledAt: Date, // last reconciliation sync date (success OR attempt)
    // Transient in-flight guard so concurrent webhooks don't double-create the
    // invoice (creating), the invoice payment (paymentCreating), the bill
    // (billCreating), or the bill payment (billPaymentCreating).
    creating: { type: Boolean, default: false },
    paymentCreating: { type: Boolean, default: false },
    billCreating: { type: Boolean, default: false },
    billPaymentCreating: { type: Boolean, default: false },
    syncLog: {
      type: [
        new mongoose.Schema(
          {
            at: { type: Date, default: Date.now },
            // invoice_created | invoice_create_failed | shipping_synced |
            // shipping_sync_failed | bill_created | bill_create_failed |
            // bill_payment_created | bill_payment_failed | bill_reconcile_skipped
            event: String,
            ok: Boolean,
            message: String,
          },
          { _id: false },
        ),
      ],
      default: [],
    },
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

    // ── Extra Shopify snapshot (for the Retail Order Details page) ──────
    // Additive — captured at ingest by mapShopifyOrderToDoc. Safe to
    // overwrite on re-ingest (pure snapshot of the order payload).
    tags: { type: [String], default: [] },
    note: { type: String, default: null },
    noteAttributes: {
      type: [{ name: String, value: String }],
      default: [],
    },
    sourceName: { type: String, default: null },
    transactions: {
      type: [
        {
          id: String,
          kind: String,
          status: String,
          gateway: String,
          amount: Number,
          processedAt: Date,
        },
      ],
      default: [],
    },

    // ── Fulfillment + tracking ──────────────────────────────────────────
    // Managed by the fulfillments/* webhooks via services/retailQbo. NOT
    // written by the ingestion pipeline, so they survive order re-ingests.
    fulfillments: { type: [fulfillmentSchema], default: [] },
    trackingHistory: { type: [trackingHistorySchema], default: [] },
    shippedAt: Date,

    // ── Retail QBO invoice ──────────────────────────────────────────────
    // No `default: null` — a scalar-null parent breaks dot-path `$set` of
    // sub-fields (services/retailQbo claims `retailQbo.creating`). Left absent
    // until the retail-invoice flow first writes it (which uses an
    // $ifNull/$mergeObjects pipeline so existing null rows still work).
    retailQbo: { type: retailQboSchema },
  },
  { collection: "cdo_orders", timestamps: true, strict: false },
);

// Idempotency: one document per Shopify order per shop. Lets the pipeline
// upsert safely against Shopify's at-least-once webhook delivery + replays.
cdoOrderSchema.index({ shop: 1, shopifyOrderId: 1 }, { unique: true });

export default mongoose.models.CdoOrder ||
  mongoose.model("CdoOrder", cdoOrderSchema);
