// Read-only mirror of the wholesale workspace's `invoices` collection.
// ns-retail reads it ONLY to reconcile the retail vendor bill: when the
// WHOLESALE dropship invoice for an order is paid, the retail side records a
// matching QBO BillPayment (see services/retailQbo/retailBillReconcile).
//
// The canonical schema is owned by wholesale/ (see
// wholesale/app/models/invoice.server.js). `strict: false` lets us read
// documents with fields not declared here, and we NEVER write this collection
// from ns-retail (single-owner discipline).

import mongoose from "mongoose";

const wholesaleInvoiceSchema = new mongoose.Schema(
  {
    shop: String,
    // The WHOLESALE Shopify order id (numeric string from the REST webhook
    // payload) — joins to dropship_mappings.wholesaleOrderId.
    shopifyOrderId: String,
    customerEmail: String,
    isDropship: Boolean,
    qboInvoiceId: String,
    // pending | partially_paid | paid | awaiting_settlement | failed | cancelled
    paymentStatus: String,
    amountDue: Number,
    amountPaid: Number,
    currency: String,
    // Cumulative QBO payment sync state on the wholesale side.
    qboPaymentRecorded: Boolean,
    qboRecordedTotal: Number,
    qboPaymentIds: { type: [String], default: [] },
  },
  { collection: "invoices", strict: false, timestamps: true },
);

// Reuse a distinct model name so we never collide with anything the retail app
// might define for its own invoices.
export default mongoose.models.WholesaleInvoice ||
  mongoose.model("WholesaleInvoice", wholesaleInvoiceSchema);
