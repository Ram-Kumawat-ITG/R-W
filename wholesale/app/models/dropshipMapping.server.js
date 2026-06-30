// Drop-ship mapping — one row per retail Shopify order that triggered the
// auto-drop-ship pipeline (retail order → parallel wholesale order →
// wholesale invoice → retail QBO bill → weekly batch pay).
//
// Every step of the pipeline writes its outcome here so we have a single
// source of truth for "what stage is this order at" and for cascading
// cancellation later (when the patient's retail order is cancelled, we
// look up the mapping and reverse the chain).
//
// Idempotency: unique index on `retailOrderId` so re-delivered retail
// webhooks (Shopify's at-least-once retries) don't create duplicate
// drop-ship orders.

import mongoose from 'mongoose'

const dropshipMappingSchema = new mongoose.Schema(
  {
    // ── Identifiers ───────────────────────────────────────────────────
    shop: { type: String, index: true }, // wholesale shop domain

    // Retail order side (the trigger)
    retailShop: { type: String, index: true }, // retail shop domain
    retailOrderId: { type: String, required: true }, // Shopify id (number as string) on retail
    retailOrderName: { type: String }, // e.g. "#R-1001"
    retailOrderGid: { type: String }, // gid://shopify/Order/...

    // Wholesale order side (created by Phase B)
    wholesaleOrderId: { type: String, default: null }, // numeric id, populated after creation
    wholesaleOrderName: { type: String, default: null }, // e.g. "#1234"
    wholesaleOrderGid: { type: String, default: null },
    wholesaleDraftOrderId: { type: String, default: null }, // we create via DraftOrder then complete it
    wholesaleInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null },

    // Retail QBO side (Phase D)
    retailQboBillId: { type: String, default: null },

    // ── Amounts (locked at creation, for traceability) ────────────────
    // Sum of retail BASE prices × qty (before patient discount/shipping/tax)
    retailBaseSubtotal: { type: Number, default: 0 },
    // Sum of the WHOLESALE product prices × qty (sync_id_maps.wholesalePrice;
    // falls back to ½ of retail when a variant's snapshot isn't populated) —
    // what wholesale invoices retail for. Informational/audit only; the
    // invoiced amount is the QBO invoice total built from the order lines.
    wholesaleSubtotal: { type: Number, default: 0 },
    currency: { type: String, default: 'USD' },

    // ── Lifecycle ─────────────────────────────────────────────────────
    // Drives idempotency + downstream cascade. Each step in the pipeline
    // transitions this forward. Reversed values are for cancellation.
    status: {
      type: String,
      enum: [
        'received', // retail order received, nothing else done yet
        'wholesale_order_created', // wholesale Shopify order exists
        'wholesale_invoice_created', // wholesale invoice exists (existing pipeline picks it up via orders/create)
        'retail_bill_created', // retail QBO bill exists
        'paid', // weekly batch closed the bill
        'cancelled', // retail order cancelled → chain reversed
        'error', // pipeline failed; see `lastError`
      ],
      default: 'received',
      index: true,
    },
    lastError: { type: String, default: null }, // last error message if status === 'error'
    lastErrorAt: { type: Date, default: null },

    // ── Audit ─────────────────────────────────────────────────────────
    cancelledAt: { type: Date, default: null },
    cancelledReason: { type: String, default: null },
    paidAt: { type: Date, default: null }, // when the weekly batch closed it

    // ── Retail fulfillment sync (Wholesale → Retail status mirror) ──────
    // When the wholesale drop-ship order is fulfilled / shipped / delivered /
    // cancelled, we POST that status to the ns-retail app so it mirrors it
    // onto the linked retail Shopify order. This block is the status-tracking
    // + dedup record for that push: `lastSignature` is a content hash of the
    // last successfully-synced fulfillment state, so a re-delivered webhook or
    // a repeated Order-Details live-pull never re-POSTs an unchanged update
    // (duplicate / conflict prevention). See services/sync/fulfillmentSync.
    retailFulfillmentSync: {
      lastSignature: { type: String, default: null }, // hash of last synced state
      lastEvent: { type: String, default: null }, // 'fulfillment' | 'cancelled'
      lastStatus: { type: String, default: null }, // 'ok' | 'error'
      lastSyncedAt: { type: Date, default: null }, // last attempt (success OR failure)
      lastError: { type: String, default: null },
      lastErrorAt: { type: Date, default: null },
      attempts: { type: Number, default: 0 }, // total push attempts
    },
  },
  { collection: 'dropship_mappings', timestamps: true, strict: true },
)

// Idempotency anchor — one mapping per retail order. Combined with shop so
// dev / staging / prod can co-exist if pointed at the same Mongo.
dropshipMappingSchema.index(
  { shop: 1, retailOrderId: 1 },
  { unique: true },
)

// Useful for the weekly batch job: find all paid-ready bills.
dropshipMappingSchema.index({ status: 1, createdAt: 1 })

export default mongoose.models.DropshipMapping ||
  mongoose.model('DropshipMapping', dropshipMappingSchema)
