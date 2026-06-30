import mongoose from 'mongoose'

// Maps wholesale Shopify entity IDs to retail Shopify entity IDs.
// Entries are created by the product sync service and used by the
// inventory sync to route cross-store adjustments.
const idMapSchema = new mongoose.Schema(
  {
    entityType: {
      type: String,
      enum: ['product', 'productVariant', 'inventoryItem', 'location'],
      required: true,
    },
    wholesaleId: { type: String, required: true },
    retailId: { type: String, required: true },
    // Only on productVariant rows: the wholesale inventory_item_id for that variant.
    // Used by deductWholesaleInventoryForOrder to bridge variant → inventoryItem lookup.
    wholesaleInventoryItemId: { type: String, default: null },
    // Last-known wholesale available quantity — used by inventory_levels/update
    // handler to distinguish restocks (delta > 0) from order deductions.
    available: { type: Number, default: null },
    // Last-known retail available quantity — same role as `available` but
    // for the retail store side. Used by the reverse-direction sync (retail
    // inventory_levels/update webhook) to detect retail restocks and mirror
    // them back to wholesale. Both fields are kept in lock-step by each
    // sync handler so the next webhook sees delta=0 and skips, preventing
    // infinite mirror loops.
    retailAvailable: { type: Number, default: null },
    // ── Price snapshots (productVariant rows only) ─────────────────────
    // Last-known per-variant prices captured at sync time. Stored on each
    // `productVariant` row so downstream services (drop-ship orchestration,
    // commission math, price-divergence audits) can compare the two stores'
    // pricing without hitting Shopify again. Currency is the variant's
    // shop-level currency (USD here).
    //
    //   wholesalePrice         — Shopify variant.price (regular) on wholesale
    //   retailPrice            — Shopify variant.price (regular) on retail
    //   wholesaleCompareAtPrice — Shopify variant.compare_at_price (sale-from) on wholesale, optional
    //   retailCompareAtPrice    — Shopify variant.compare_at_price (sale-from) on retail, optional
    //
    // All four are Number for direct compare/arithmetic; null when the source
    // variant doesn't carry a value. Updated on every create + update sync.
    wholesalePrice: { type: Number, default: null },
    retailPrice: { type: Number, default: null },
    wholesaleCompareAtPrice: { type: Number, default: null },
    retailCompareAtPrice: { type: Number, default: null },
  },
  { collection: 'sync_id_maps', timestamps: true },
)

idMapSchema.index({ entityType: 1, wholesaleId: 1 }, { unique: true })
idMapSchema.index({ entityType: 1, retailId: 1 })

export default mongoose.models.SyncIdMap ||
  mongoose.model('SyncIdMap', idMapSchema)
