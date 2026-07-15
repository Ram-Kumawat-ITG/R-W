import mongoose from 'mongoose'

// ── Shopify variant ↔ QBO Item mapping (`qbo_product_maps`) ───────────────
//
// One document per Shopify PRODUCT VARIANT (QBO has no parent-product concept
// — each sellable variant is its own Item). Maintained by the Shopify → QBO
// product sync (services/qbo/qboProductSync.service.js), driven off the
// products/create + products/update webhooks (and the admin backfill).
//
// This is the durable mapping that ties together the four identifiers the
// invoice/inventory/reporting pipelines need — Shopify product id, Shopify
// variant id, SKU, and QBO Item id — keyed on the STABLE variant id (not
// SKU) so a SKU rename never orphans the mapping. It supplements (does not
// replace) the SKU-keyed `qbo_item_maps` cache the invoice path still uses
// as its just-in-time fallback.
//
// Retention: a Shopify product delete/archive NEVER deletes the QBO Item and
// NEVER deletes this row — it only flips `shopifyDeleted` for audit. QBO
// product records are kept for historical reporting/accounting/analytics.

const qboProductMapSchema = new mongoose.Schema(
  {
    shop: { type: String, default: null, index: true },
    // Shopify identifiers (stored as plain numeric-string legacy ids).
    shopifyProductId: { type: String, required: true, index: true },
    shopifyVariantId: { type: String, required: true },
    sku: { type: String, default: null },
    // Snapshots for reporting / the invoice-time fallback + admin visibility.
    productTitle: { type: String, default: null },
    variantTitle: { type: String, default: null },
    vendor: { type: String, default: null },
    shopifyPrice: { type: Number, default: null },

    // QBO Item.
    qboItemId: { type: String, default: null },
    qboItemName: { type: String, default: null },
    qboSyncToken: { type: String, default: null },

    // Shopify lifecycle mirror. `shopifyStatus` = active|draft|archived from
    // the last product webhook; `shopifyDeleted` set true on products/delete.
    // Neither ever triggers a QBO-side delete/deactivate (retention).
    shopifyStatus: { type: String, default: null },
    shopifyDeleted: { type: Boolean, default: false },

    // Sync-state audit — powers logging, retry, and the reconciliation sweep.
    syncStatus: {
      type: String,
      enum: ['pending', 'synced', 'error', 'skipped'],
      default: 'pending',
    },
    lastSyncedAt: { type: Date, default: null },
    lastSyncError: { type: String, default: null },
    syncAttemptCount: { type: Number, default: 0 },
    lastAction: { type: String, default: null }, // created | updated | unchanged | skipped
  },
  { collection: 'qbo_product_maps', timestamps: true },
)

// Idempotency: one row per variant. Two overlapping webhook deliveries can't
// create duplicate rows; the upsert keys on this.
qboProductMapSchema.index({ shopifyVariantId: 1 }, { unique: true })
qboProductMapSchema.index({ sku: 1 })
qboProductMapSchema.index({ qboItemId: 1 })
qboProductMapSchema.index({ syncStatus: 1 })

export default mongoose.models.QboProductMap ||
  mongoose.model('QboProductMap', qboProductMapSchema)
