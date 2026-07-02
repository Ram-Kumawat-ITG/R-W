// READ-ONLY mirror of the ns-retail `cdo_orders` collection.
//
// ns-retail OWNS and WRITES this collection (the retail order + its retail QBO
// invoice and Vendor Bill state). The wholesale app only READS it — to surface
// the linked retail **Vendor Bill** (A/P — the dropship cost the retail company
// owes Natural Solution Wholesale) on the Admin Orders page. We NEVER write
// here (single-owner discipline; this mirrors how ns-retail read-only-mirrors
// the wholesale `invoices` + `dropship_mappings` collections).
//
// `strict: false` so we don't have to replicate ns-retail's full schema — only
// the fields we read are declared. Both apps share one MongoDB
// (`natural-solutions`), so this resolves against the same documents.
//
// Join path (see app.admin-orders._index.jsx loader):
//   wholesale ShopifyOrder.shopifyOrderId === dropship_mappings.wholesaleOrderId
//   dropship_mappings.retailOrderGid      === cdo_orders.shopifyOrderId   (a GID)

import mongoose from 'mongoose'

const retailCdoOrderSchema = new mongoose.Schema(
  {
    shopifyOrderId: { type: String, index: true }, // gid://shopify/Order/<id>
    orderName: String,
    // Subset of the ns-retail `retailQbo` block — the Vendor Bill (A/P) fields.
    retailQbo: {
      qboBillId: String,
      qboBillDocNumber: String,
      qboBillTotal: Number,
      billUrl: String, // deep link to the bill in QBO
      billSyncStatus: String, // pending | creating | created | error
      billPaymentStatus: String, // unpaid | paid
      billReconcileStatus: String, // pending | reconciling | paid | error
    },
  },
  { collection: 'cdo_orders', strict: false },
)

export default mongoose.models.RetailCdoOrder ||
  mongoose.model('RetailCdoOrder', retailCdoOrderSchema)
