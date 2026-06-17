// Read-only mirror of the wholesale workspace's `dropship_mappings` collection
// — the chain that links a retail Shopify order to its parallel wholesale
// order + invoice. ns-retail reads it to map a retail order (cdo_orders) to
// the WHOLESALE dropship invoice so the retail vendor bill can be reconciled
// once that invoice is paid (see services/retailQbo/retailBillReconcile).
//
// The canonical schema is owned by wholesale/ (see
// wholesale/app/models/dropshipMapping.server.js). `strict: false` tolerates
// schema drift; ns-retail NEVER writes this collection (single-owner).

import mongoose from "mongoose";

const dropshipMappingSchema = new mongoose.Schema(
  {
    shop: String, // wholesale shop domain
    retailShop: String,
    retailOrderId: String, // retail Shopify numeric id (string)
    retailOrderName: String,
    retailOrderGid: String, // gid://shopify/Order/<retailId> — joins to cdo_orders.shopifyOrderId
    wholesaleOrderId: String, // wholesale Shopify numeric id — joins to invoices.shopifyOrderId
    wholesaleOrderName: String,
    wholesaleOrderGid: String,
    wholesaleInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "WholesaleInvoice", default: null },
    retailQboBillId: String,
    wholesaleSubtotal: Number,
    currency: String,
    status: String,
  },
  { collection: "dropship_mappings", strict: false, timestamps: true },
);

export default mongoose.models.DropshipMapping ||
  mongoose.model("DropshipMapping", dropshipMappingSchema);
