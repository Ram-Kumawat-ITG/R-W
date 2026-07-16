// Shopify → QBO product (Products & Services) sync.
//
// For each Shopify product lifecycle event this creates/updates one QBO Item
// per variant and maintains the qbo_product_maps mapping (Shopify product id
// + variant id + SKU ↔ QBO Item id). One-way, Shopify → QBO, always. QBO is
// never the source of truth and nothing is written back to Shopify.
//
// Retention policy (per requirement): products are NEVER deleted or
// deactivated in QBO — not on Shopify archive, not on Shopify delete. QBO
// product records are retained for historical reporting/accounting/analytics.
//
// Reliability:
//   • Config-gated (qboConfig.productSyncEnabled) so it ships without
//     impacting existing behavior.
//   • Transport-level transient retry + QBO requestid idempotency are already
//     provided by qbo.apis.js — nothing charges/writes twice.
//   • Per-variant sync state (syncStatus/lastSyncError/syncAttemptCount) is
//     persisted on qbo_product_maps so failures are visible and retryable via
//     retryFailedQboProductSyncs() (reconciliation) without re-hitting Shopify.
//   • Best-effort at the product level: one variant's failure is recorded and
//     never blocks the others; the function resolves with a summary and only
//     throws never (callers are fire-and-forget webhooks).

import { upsertQboItem, reconcileQboItemInventory } from './qbo.service'
import { qboConfig } from './qbo.config'
import QboProductMap from '../../models/qboProductMap.server'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('qbo.product_sync')

export function isQboProductSyncEnabled() {
  return Boolean(qboConfig.productSyncEnabled)
}

// Compose the QBO Item NAME so each variant is distinguishable (QBO has no
// variant concept — one Item per variant). Standard shape: "Product - Variant".
// Special-cases: a single-variant product's "Default Title" (or a variant
// title identical to the product) → just the product name; a variant title
// that already contains the product name (e.g. the merchant named the option
// "AI - B12 Folate A") → use it verbatim to avoid "Product - Product A". The
// SKU is NOT part of the name here — upsertQboItem/sanitizeItemName append it
// for QBO's unique-name guarantee, and it also has its own Sku column.
function buildItemName(productTitle, variantTitle) {
  const p = String(productTitle || '').trim()
  const v = String(variantTitle || '').trim()
  if (!v || v.toLowerCase() === 'default title' || v === p) return p
  if (p && v.toLowerCase().includes(p.toLowerCase())) return v
  return p ? `${p} - ${v}` : v
}

// Compose the QBO Item Description from the product + variant titles.
function buildDescription(product, variant) {
  const parts = [product?.title, variant?.title].map((s) => (s ? String(s).trim() : '')).filter(Boolean)
  // Variant title is often "Default Title" for single-variant products — drop it.
  const cleaned = parts.filter((p) => p.toLowerCase() !== 'default title')
  return cleaned.join(' — ') || null
}

// Sync one variant → QBO Item + persist its qbo_product_maps row. Never
// throws; returns { status, action, sku } for the summary.
async function syncVariant({ shop, product, variant }) {
  const shopifyProductId = String(product.id)
  const shopifyVariantId = String(variant.id)
  const sku = variant?.sku ? String(variant.sku).trim() : ''
  const productTitle = product?.title ?? null
  const variantTitle = variant?.title ?? null
  const vendor = product?.vendor ?? null
  const shopifyPrice =
    variant?.price === null || variant?.price === undefined || variant?.price === ''
      ? null
      : Number(variant.price)
  const inventoryItemId = variant?.inventory_item_id != null ? String(variant.inventory_item_id) : null
  const qtyOnHand = variant?.inventory_quantity ?? null

  // Base snapshot written on every path (even skip/error) so the mapping row
  // always reflects the current Shopify identifiers.
  const baseSet = {
    shopifyProductId,
    shopifyVariantId,
    inventoryItemId,
    sku: sku || null,
    productTitle,
    variantTitle,
    vendor,
    shopifyPrice: Number.isFinite(shopifyPrice) ? shopifyPrice : null,
    shopifyStatus: product?.status ?? null,
    shopifyDeleted: false,
  }
  if (shop) baseSet.shop = shop

  // No SKU → can't identify a QBO Item (its SKU column is Item.Sku). Skip
  // proactive sync (invoice-time fallback still uses the default item), but
  // record the mapping row so the variant is visible/reconcilable.
  if (!sku) {
    log.warn('variant.skip_no_sku', { shopifyProductId, shopifyVariantId })
    await QboProductMap.updateOne(
      { shopifyVariantId },
      { $set: { ...baseSet, syncStatus: 'skipped', lastAction: 'skipped', lastSyncError: 'no SKU' } },
      { upsert: true },
    )
    return { status: 'skipped', action: 'skipped', sku: null }
  }

  try {
    const result = await upsertQboItem({
      sku,
      name: buildItemName(productTitle, variantTitle),
      description: buildDescription(product, variant),
      price: shopifyPrice,
      // Initial QBO on-hand quantity (Inventory items only) — seeded from the
      // Shopify variant's current stock at first create; on an EXISTING item
      // upsertQboItem reconciles QtyOnHand to this via an InventoryAdjustment.
      qtyOnHand: qtyOnHand ?? 0,
    })
    await QboProductMap.updateOne(
      { shopifyVariantId },
      {
        $set: {
          ...baseSet,
          qboItemId: result.qboItemId,
          qboItemName: result.qboItemName,
          qboSyncToken: result.qboSyncToken,
          lastSyncedQty: qtyOnHand,
          syncStatus: 'synced',
          lastSyncedAt: new Date(),
          lastSyncError: null,
          lastAction: result.action,
        },
        $inc: { syncAttemptCount: 1 },
      },
      { upsert: true },
    )
    log.info('variant.synced', {
      shopifyVariantId, sku, qboItemId: result.qboItemId, action: result.action,
      qtyReconciled: result.qtyReconciled || null,
    })
    return { status: 'synced', action: result.action, sku }
  } catch (err) {
    const message = err?.message || String(err)
    log.error('variant.failed', { shopifyProductId, shopifyVariantId, sku, err: message })
    await QboProductMap.updateOne(
      { shopifyVariantId },
      {
        $set: { ...baseSet, syncStatus: 'error', lastSyncError: message, lastAction: 'error' },
        $inc: { syncAttemptCount: 1 },
      },
      { upsert: true },
    ).catch((e) => log.error('variant.state_write_failed', { shopifyVariantId, err: e?.message || String(e) }))
    return { status: 'error', action: 'error', sku, error: message }
  }
}

// Sync every variant of a Shopify product (REST-shaped payload) to QBO.
// `event` is 'create' | 'update' | 'backfill' — informational (create and
// update are the same upsert here). Never throws.
export async function syncProductToQbo(product, { shop = null, event = 'update' } = {}) {
  if (!isQboProductSyncEnabled()) {
    log.info('disabled', { productId: product?.id })
    return { skipped: true, reason: 'disabled' }
  }
  if (!product?.id) return { skipped: true, reason: 'no_product_id' }

  const variants = product.variants || []
  const summary = { productId: String(product.id), event, total: variants.length, synced: 0, updated: 0, skipped: 0, errored: 0 }

  for (const variant of variants) {
    const r = await syncVariant({ shop, product, variant })
    if (r.status === 'error') summary.errored++
    else if (r.status === 'skipped') summary.skipped++
    else {
      summary.synced++
      if (r.action === 'updated') summary.updated++
    }
  }

  log.info('product.done', summary)
  return summary
}

// Handle a Shopify inventory_levels/update — reconcile the matching QBO
// Inventory item's on-hand to Shopify's new `available`. Ongoing quantity-sync
// path (products/update doesn't fire on stock-only changes; QBO QtyOnHand can
// only change via InventoryAdjustment). Looked up by inventory_item_id via the
// mapping row. Never throws.
//
// NOTE: `available` is per-LOCATION. Reconciles QBO to that value — correct for
// a single-inventory-location store; a multi-location store would need the
// summed available across locations (future enhancement).
export async function syncInventoryLevelToQbo({ inventoryItemId, available }) {
  if (!isQboProductSyncEnabled()) return { skipped: true, reason: 'disabled' }
  const invId = inventoryItemId != null ? String(inventoryItemId) : null
  const qty = Number(available)
  if (!invId || !Number.isFinite(qty)) return { skipped: true, reason: 'bad_input' }

  const row = await QboProductMap.findOne({ inventoryItemId: invId }).lean()
  if (!row?.qboItemId) {
    log.info('inventory_level.no_mapping', { inventoryItemId: invId })
    return { skipped: true, reason: 'no_mapping' }
  }
  try {
    const res = await reconcileQboItemInventory({ itemId: row.qboItemId, targetQty: qty })
    await QboProductMap.updateOne(
      { shopifyVariantId: row.shopifyVariantId },
      { $set: { lastSyncedQty: qty, lastSyncedAt: new Date(), lastSyncError: null } },
    )
    log.info('inventory_level.synced', { inventoryItemId: invId, qboItemId: row.qboItemId, available: qty, ...res })
    return { ok: true, ...res }
  } catch (err) {
    log.error('inventory_level.failed', { inventoryItemId: invId, err: err?.message || String(err) })
    await QboProductMap.updateOne(
      { shopifyVariantId: row.shopifyVariantId },
      { $set: { lastSyncError: err?.message || String(err) } },
    ).catch(() => {})
    return { error: err?.message || String(err) }
  }
}

// Mark the mapping rows for a deleted Shopify product as shopify-deleted —
// WITHOUT deleting the QBO Item or the mapping row (retention). Never throws.
export async function markQboProductDeleted(shopifyProductId) {
  if (!isQboProductSyncEnabled()) return { skipped: true }
  try {
    const res = await QboProductMap.updateMany(
      { shopifyProductId: String(shopifyProductId) },
      { $set: { shopifyDeleted: true } },
    )
    log.info('product.marked_deleted', {
      shopifyProductId: String(shopifyProductId),
      matched: res?.matchedCount ?? res?.n ?? 0,
    })
    return { matched: res?.matchedCount ?? 0 }
  } catch (err) {
    log.error('product.mark_deleted_failed', { shopifyProductId, err: err?.message || String(err) })
    return { error: err?.message || String(err) }
  }
}

// Reconciliation: retry variants left in 'error' (or 'pending') state. Uses
// the SKU + snapshot already stored on the row, so it does NOT need to
// re-fetch anything from Shopify — a self-contained backstop for missed /
// failed webhook deliveries. Returns a summary. Never throws.
export async function retryFailedQboProductSyncs({ limit = 200 } = {}) {
  if (!isQboProductSyncEnabled()) return { skipped: true, reason: 'disabled' }
  const rows = await QboProductMap.find({ syncStatus: { $in: ['error', 'pending'] }, sku: { $ne: null } })
    .limit(limit)
    .lean()
  const summary = { candidates: rows.length, fixed: 0, stillFailing: 0 }
  for (const row of rows) {
    try {
      const result = await upsertQboItem({
        sku: row.sku,
        name: buildItemName(row.productTitle, row.variantTitle),
        description: [row.productTitle, row.variantTitle]
          .filter((s) => s && s.toLowerCase() !== 'default title')
          .join(' — ') || null,
        price: row.shopifyPrice,
      })
      await QboProductMap.updateOne(
        { shopifyVariantId: row.shopifyVariantId },
        {
          $set: {
            qboItemId: result.qboItemId,
            qboItemName: result.qboItemName,
            qboSyncToken: result.qboSyncToken,
            syncStatus: 'synced',
            lastSyncedAt: new Date(),
            lastSyncError: null,
            lastAction: result.action,
          },
          $inc: { syncAttemptCount: 1 },
        },
      )
      summary.fixed++
    } catch (err) {
      summary.stillFailing++
      await QboProductMap.updateOne(
        { shopifyVariantId: row.shopifyVariantId },
        { $set: { syncStatus: 'error', lastSyncError: err?.message || String(err) }, $inc: { syncAttemptCount: 1 } },
      ).catch(() => {})
    }
  }
  log.info('reconcile.done', summary)
  return summary
}
