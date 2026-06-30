// Read-only mirror of the wholesale workspace's `sync_id_maps` collection.
// The wholesale product sync owns + writes it (see
// wholesale/app/services/sync/idMap.model.js); ns-retail reads it ONLY to
// price the retail QBO Vendor Bill at the actual WHOLESALE product price, so
// the bill (A/P) matches the wholesale dropship invoice (A/R) for the same
// order — both sides read the same `wholesalePrice` field.
//
// `strict: false` lets us read documents with fields not declared here, and we
// NEVER write this collection from ns-retail (single-owner discipline).

import mongoose from "mongoose";

const syncIdMapSchema = new mongoose.Schema(
  {
    // 'product' | 'productVariant' | 'inventoryItem' | 'location' — we only
    // query 'productVariant' rows here.
    entityType: String,
    // Wholesale Shopify entity id (numeric string).
    wholesaleId: String,
    // Retail Shopify entity id (numeric string) — joins to a cdo_orders line
    // item's `variantId` for productVariant rows.
    retailId: String,
    // Last-known per-variant wholesale Shopify price (regular), captured at
    // product-sync time. Number; null when the source variant has no value.
    wholesalePrice: Number,
  },
  { collection: "sync_id_maps", strict: false, timestamps: true },
);

// Distinct model name so we never collide with anything the retail app might
// define for its own id maps.
export default mongoose.models.SyncIdMap ||
  mongoose.model("SyncIdMap", syncIdMapSchema);
