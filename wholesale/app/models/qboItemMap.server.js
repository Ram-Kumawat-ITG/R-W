import mongoose from 'mongoose'

// SKU → QBO Item id cache.
//
// QBO sources an invoice's SKU column from the line's referenced Item.Sku
// (there is no per-line SKU field), so to show SKUs we reference a QBO Item
// that carries the product's SKU. This collection caches the resolved
// (sku → qboItemId) mapping so repeat orders of the same product don't
// re-query / re-create the QBO Item. Populated by
// qbo.service.findOrCreateItemBySku. `name` is kept for diagnostics only.
const qboItemMapSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true, unique: true, index: true },
    qboItemId: { type: String, required: true },
    // The Sku of the QBO Item we mapped to — used to validate a cache hit
    // (the resolved item's SKU must equal the key). A missing or mismatched
    // value marks the row stale so findOrCreateItemBySku re-resolves it
    // (self-heals rows written before this validation existed).
    qboSku: String,
    name: String,
  },
  { collection: 'qbo_item_maps', timestamps: true },
)

export default mongoose.models.QboItemMap ||
  mongoose.model('QboItemMap', qboItemMapSchema)
