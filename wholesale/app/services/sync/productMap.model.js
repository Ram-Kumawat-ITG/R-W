import mongoose from 'mongoose'

// ── Comprehensive wholesale product mirror (`sync_product_maps`) ──────────
//
// One document per WHOLESALE Shopify product, maintained by the product
// lifecycle webhooks (products/create, products/update, products/delete)
// plus the admin backfill endpoint. This is the single source of truth for
// cross-store product data and future integrations (QBO product sync,
// inventory management, reporting, analytics, order processing).
//
// Relationship to `sync_id_maps` (idMap.model.js): that collection stays the
// operational id-translation table the inventory/order sync reads on its hot
// paths (narrow rows, claim-first create guard). THIS collection is the rich
// snapshot layered on top — it embeds the retail ids resolved FROM the id
// map at write time, but never replaces it.
//
// Deletion semantics: a products/delete webhook REMOVES the document (per
// the mapping contract — the mirror always reflects what exists on the
// wholesale store right now).

const productMapVariantSchema = new mongoose.Schema(
  {
    wholesaleVariantId: { type: String, required: true },
    // Retail Shopify variant id — resolved from sync_id_maps at write time.
    // Null when the variant hasn't been synced to retail (yet).
    retailVariantId: { type: String, default: null },
    title: { type: String, default: null },
    sku: { type: String, default: null },
    barcode: { type: String, default: null },
    position: { type: Number, default: null },
    option1: { type: String, default: null },
    option2: { type: String, default: null },
    option3: { type: String, default: null },
    // Wholesale prices (Number for direct arithmetic; null when absent).
    price: { type: Number, default: null },
    compareAtPrice: { type: Number, default: null },
    // Unit cost is NOT included in Shopify's product webhook payload (it
    // lives on the InventoryItem resource). Kept as a schema field so a
    // future enrichment pass (e.g. the QBO product sync's backfill) can
    // populate it without a schema change; null until then.
    costPerItem: { type: Number, default: null },
    taxable: { type: Boolean, default: null },
    inventoryQuantity: { type: Number, default: null },
    // Wholesale inventory_item_id + its retail twin (from sync_id_maps).
    inventoryItemId: { type: String, default: null },
    retailInventoryItemId: { type: String, default: null },
    inventoryPolicy: { type: String, default: null },
    inventoryManagement: { type: String, default: null },
    requiresShipping: { type: Boolean, default: null },
    // Weight — Shopify carries grams (canonical) plus weight + weight_unit.
    // Physical dimensions have no core Shopify field (metafields only), so
    // weight is the full extent of what the webhook can provide.
    grams: { type: Number, default: null },
    weight: { type: Number, default: null },
    weightUnit: { type: String, default: null },
    shopifyCreatedAt: { type: Date, default: null },
    shopifyUpdatedAt: { type: Date, default: null },
  },
  { _id: false },
)

const productMapSchema = new mongoose.Schema(
  {
    shop: { type: String, default: null },
    wholesaleProductId: { type: String, required: true },
    // Retail Shopify product id — resolved from sync_id_maps at write time.
    // Null while unsynced or while a claim-first create is still in flight.
    retailProductId: { type: String, default: null },
    adminGraphqlApiId: { type: String, default: null },
    title: { type: String, default: null },
    handle: { type: String, default: null },
    bodyHtml: { type: String, default: null },
    vendor: { type: String, default: null },
    productType: { type: String, default: null },
    status: { type: String, default: null }, // active | draft | archived
    // Normalized to an array (webhook payload sends a comma-joined string).
    tags: { type: [String], default: [] },
    publishedAt: { type: Date, default: null },
    publishedScope: { type: String, default: null },
    templateSuffix: { type: String, default: null },
    options: {
      type: [
        new mongoose.Schema(
          {
            name: { type: String, default: null },
            position: { type: Number, default: null },
            values: { type: [String], default: [] },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    images: {
      type: [
        new mongoose.Schema(
          {
            wholesaleImageId: { type: String, default: null },
            src: { type: String, default: null },
            alt: { type: String, default: null },
            position: { type: Number, default: null },
            width: { type: Number, default: null },
            height: { type: Number, default: null },
            // Wholesale variant ids this image is assigned to.
            variantIds: { type: [String], default: [] },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    variants: { type: [productMapVariantSchema], default: [] },
    // Derived convenience fields for reporting/analytics queries.
    variantCount: { type: Number, default: 0 },
    totalInventoryQuantity: { type: Number, default: null },
    // Product-level Shopify timestamps (from the webhook payload).
    shopifyCreatedAt: { type: Date, default: null },
    shopifyUpdatedAt: { type: Date, default: null },
    // Which lifecycle event last wrote this document + when.
    lastEvent: {
      type: String,
      enum: ['create', 'update', 'backfill'],
      default: 'update',
    },
    lastSyncedAt: { type: Date, default: null },
  },
  { collection: 'sync_product_maps', timestamps: true },
)

productMapSchema.index({ wholesaleProductId: 1 }, { unique: true })
productMapSchema.index({ retailProductId: 1 })
productMapSchema.index({ 'variants.sku': 1 })
productMapSchema.index({ 'variants.wholesaleVariantId': 1 })
productMapSchema.index({ vendor: 1 })
productMapSchema.index({ status: 1 })

export default mongoose.models.SyncProductMap ||
  mongoose.model('SyncProductMap', productMapSchema)
