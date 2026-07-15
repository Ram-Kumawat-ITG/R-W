import mongoose from "mongoose";

// ── Retail Shopify variant ↔ Retail QBO Item mapping (`retail_qbo_product_maps`) ──
//
// One document per RETAIL Shopify product VARIANT (QBO has no parent-product
// concept — each sellable variant is its own Item). Maintained by the retail
// Shopify → retail QBO product sync (services/retailQbo/retailQboProductSync
// .service.js), driven off the RETAIL store's products/create + products/update
// webhooks.
//
// Deliberately a DISTINCT collection from wholesale's `qbo_product_maps` (both
// apps share the same MongoDB) so the retail QBO mapping stays cleanly
// separated and only ever reflects the RETAIL Shopify store — per the
// "Retail QBO synchronized with the Retail Shopify store only" requirement.
//
// Ties together the four identifiers the invoice/inventory/reporting pipelines
// need — Shopify product id, variant id, SKU, and QBO Item id — keyed on the
// STABLE variant id (not SKU) so a SKU rename never orphans the mapping.
//
// Retention: a Shopify product delete/archive NEVER deletes the QBO Item or
// this row — only flips `shopifyDeleted`. QBO product records are kept for
// historical reporting/accounting/analytics.

const retailQboProductMapSchema = new mongoose.Schema(
  {
    shop: { type: String, default: null, index: true },
    shopifyProductId: { type: String, required: true, index: true },
    shopifyVariantId: { type: String, required: true },
    sku: { type: String, default: null },
    productTitle: { type: String, default: null },
    variantTitle: { type: String, default: null },
    vendor: { type: String, default: null },
    shopifyPrice: { type: Number, default: null },

    qboItemId: { type: String, default: null },
    qboItemName: { type: String, default: null },
    qboSyncToken: { type: String, default: null },

    shopifyStatus: { type: String, default: null },
    shopifyDeleted: { type: Boolean, default: false },

    syncStatus: {
      type: String,
      enum: ["pending", "synced", "error", "skipped"],
      default: "pending",
    },
    lastSyncedAt: { type: Date, default: null },
    lastSyncError: { type: String, default: null },
    syncAttemptCount: { type: Number, default: 0 },
    lastAction: { type: String, default: null },
  },
  { collection: "retail_qbo_product_maps", timestamps: true },
);

retailQboProductMapSchema.index({ shopifyVariantId: 1 }, { unique: true });
retailQboProductMapSchema.index({ sku: 1 });
retailQboProductMapSchema.index({ qboItemId: 1 });
retailQboProductMapSchema.index({ syncStatus: 1 });

export default mongoose.models.RetailQboProductMap ||
  mongoose.model("RetailQboProductMap", retailQboProductMapSchema);
