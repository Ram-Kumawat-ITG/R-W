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
  },
  { collection: 'sync_id_maps', timestamps: true },
)

idMapSchema.index({ entityType: 1, wholesaleId: 1 }, { unique: true })
idMapSchema.index({ entityType: 1, retailId: 1 })

export default mongoose.models.SyncIdMap ||
  mongoose.model('SyncIdMap', idMapSchema)
