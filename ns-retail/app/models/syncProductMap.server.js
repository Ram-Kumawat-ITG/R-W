// Read-only mirror of the wholesale workspace's `sync_product_maps` collection.
// The wholesale product sync owns + writes it (see
// wholesale/app/services/sync/productMap.model.js); ns-retail reads it ONLY to
// price the retail QBO Vendor Bill at the actual WHOLESALE product price, so
// the bill (A/P) matches the wholesale dropship invoice (A/R) for the same
// order — both sides resolve BY SKU from this same collection.
//
// Why this collection and not `sync_id_maps` (which this replaces here):
//   1. SKU is durable. `sync_id_maps` keys on the RETAIL Shopify variant id,
//      which is reassigned whenever the retail catalog is deleted + reimported
//      — silently orphaning every row. SKU survives that.
//   2. It stays accurate when the retail mirror breaks. The wholesale product
//      webhooks chain `upsertProductMap` AFTER the retail sync settles —
//      success OR failure — so this snapshot reflects the wholesale catalog
//      even while retail-side syncing is failing.
//
// NOTE: do NOT read `variants[].retailVariantId` from here. That field is
// itself resolved from `sync_id_maps` at write time, so it inherits exactly
// the staleness described above. Resolve by `variants[].sku`.
//
// `strict: false` lets us read documents with fields not declared here, and we
// NEVER write this collection from ns-retail (single-owner discipline).

import mongoose from "mongoose";

const syncProductMapVariantSchema = new mongoose.Schema(
  {
    // Wholesale Shopify variant id (numeric string).
    wholesaleVariantId: String,
    // The durable join key — matches a cdo_orders line item's `sku`.
    sku: String,
    // Wholesale Shopify variant price (regular). Number; null when absent.
    price: Number,
  },
  { _id: false, strict: false },
);

const syncProductMapSchema = new mongoose.Schema(
  {
    wholesaleProductId: String,
    title: String,
    vendor: String,
    status: String,
    variants: { type: [syncProductMapVariantSchema], default: [] },
  },
  { collection: "sync_product_maps", strict: false, timestamps: true },
);

// Distinct model name so we never collide with anything the retail app might
// define for its own product maps.
export default mongoose.models.SyncProductMap ||
  mongoose.model("SyncProductMap", syncProductMapSchema);
