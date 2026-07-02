// Read-only mirror of the wholesale workspace's `shopify_orders` collection.
// ns-retail reads it ONLY to drive the pull-based fulfillment reconciler
// (services/sync/wholesaleFulfillmentReconcile): when a drop-ship WHOLESALE
// order is fulfilled, ns-retail — which owns the retail Shopify Admin token and
// shares this MongoDB — fulfills the linked retail order directly, without
// depending on the wholesale→ns-retail HTTP push being reachable at that moment.
//
// The canonical schema is owned by wholesale/ (see
// wholesale/app/models/order.server.js, registered there as `ShopifyOrder`).
// `strict: false` tolerates the many fields we don't declare; ns-retail NEVER
// writes this collection (single-owner discipline).

import mongoose from "mongoose";

const wholesaleOrderSchema = new mongoose.Schema(
  {
    shop: String, // wholesale shop domain
    // Wholesale Shopify numeric order id (string) — joins to
    // dropship_mappings.wholesaleOrderId.
    shopifyOrderId: String,
    shopifyOrderName: String,
    processingStatus: String,
    // "fulfilled" | "partial" | "unfulfilled" (lower-cased Shopify status).
    fulfillmentStatus: String,
    shippedAt: Date,
    deliveredAt: Date,
    cancelledAt: Date,
    cancelReason: String,
    // Per-shipment fulfillment records (carrier + tracking + status). Loose
    // array — sub-fields read in the reconciler: fulfillmentId, trackingNumber,
    // trackingCompany, trackingUrl, shopifyTrackingUrl, shipmentStatus, status,
    // fulfilledAt, deliveredAt.
    fulfillments: { type: Array, default: undefined },
  },
  { collection: "shopify_orders", strict: false, timestamps: true },
);

// Distinct model name so it never collides with anything the retail app
// defines for its own orders (cdo_orders uses CdoOrder).
export default mongoose.models.WholesaleOrder ||
  mongoose.model("WholesaleOrder", wholesaleOrderSchema);
