import ProductMap from './productMap.model'
import IdMap from './idMap.model'
import { PENDING_RETAIL_ID } from './product.sync'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('sync.product_map')

// ── Product-map maintenance (sync_product_maps) ───────────────────────────
//
// Keeps the comprehensive per-product mirror document in lock-step with the
// wholesale store's product lifecycle. Both functions are BEST-EFFORT and
// never throw — map maintenance must never break (or be broken by) the
// retail product sync it runs alongside. Call sites:
//
//   webhooks.products.create.jsx  → upsertProductMap(payload, { event: 'create' })
//   webhooks.products.update.jsx  → upsertProductMap(payload, { event: 'update' })
//   webhooks.products.delete.jsx  → deleteProductMap(payload.id)
//   api/admin/sync-backfill.js    → upsertProductMap(product, { event: 'backfill' })
//
// The routes chain these AFTER the retail sync settles (success or failure),
// so the retail ids resolved from sync_id_maps are as fresh as they can be —
// and a retail-sync failure still leaves an up-to-date wholesale snapshot.

// Shopify serializes prices as strings ("9.99"); "" / null / undefined must
// map to null, not 0 (Number("") === 0 would fabricate a price).
function toNumber(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function toDate(raw) {
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

// Webhook payloads send tags as a comma-joined string; backfill/GraphQL
// callers may hand us an array already. Normalize to a clean array.
function normalizeTags(raw) {
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean)
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
  }
  return []
}

// Resolve retail ids for the product + its variants + their inventory items
// from sync_id_maps in three indexed $in queries (no per-variant round trips).
async function resolveRetailIds(wholesaleProductId, variants) {
  const variantIds = variants.map((v) => String(v.id)).filter(Boolean)
  const inventoryItemIds = variants
    .map((v) => (v.inventory_item_id != null ? String(v.inventory_item_id) : null))
    .filter(Boolean)

  const [productRow, variantRows, inventoryRows] = await Promise.all([
    IdMap.findOne({ entityType: 'product', wholesaleId: wholesaleProductId }).lean(),
    variantIds.length
      ? IdMap.find({ entityType: 'productVariant', wholesaleId: { $in: variantIds } }).lean()
      : [],
    inventoryItemIds.length
      ? IdMap.find({ entityType: 'inventoryItem', wholesaleId: { $in: inventoryItemIds } }).lean()
      : [],
  ])

  const retailProductId =
    productRow && productRow.retailId !== PENDING_RETAIL_ID ? productRow.retailId : null
  const retailVariantIdByWholesaleId = new Map(
    (variantRows || []).map((r) => [r.wholesaleId, r.retailId]),
  )
  const retailInventoryItemIdByWholesaleId = new Map(
    (inventoryRows || []).map((r) => [r.wholesaleId, r.retailId]),
  )

  return { retailProductId, retailVariantIdByWholesaleId, retailInventoryItemIdByWholesaleId }
}

// Create or refresh the sync_product_maps document for one wholesale product.
// `product` is the Shopify REST-shaped product (webhook payload, or the
// backfill's gqlToRestProduct output). Never throws.
export async function upsertProductMap(product, { shop = null, event = 'update' } = {}) {
  try {
    if (!product?.id) return null
    const wholesaleProductId = String(product.id)
    const variants = product.variants || []

    const { retailProductId, retailVariantIdByWholesaleId, retailInventoryItemIdByWholesaleId } =
      await resolveRetailIds(wholesaleProductId, variants)

    const mappedVariants = variants.map((v) => {
      const wholesaleVariantId = String(v.id)
      const inventoryItemId = v.inventory_item_id != null ? String(v.inventory_item_id) : null
      return {
        wholesaleVariantId,
        retailVariantId: retailVariantIdByWholesaleId.get(wholesaleVariantId) ?? null,
        title: v.title ?? null,
        sku: v.sku || null,
        barcode: v.barcode || null,
        position: v.position ?? null,
        option1: v.option1 ?? null,
        option2: v.option2 ?? null,
        option3: v.option3 ?? null,
        price: toNumber(v.price),
        compareAtPrice: toNumber(v.compare_at_price),
        // Not present in product webhook payloads (InventoryItem-level field);
        // preserved as null for future enrichment. See productMap.model.js.
        costPerItem: toNumber(v.cost),
        taxable: v.taxable ?? null,
        inventoryQuantity: v.inventory_quantity ?? null,
        inventoryItemId,
        retailInventoryItemId: inventoryItemId
          ? (retailInventoryItemIdByWholesaleId.get(inventoryItemId) ?? null)
          : null,
        inventoryPolicy: v.inventory_policy ?? null,
        inventoryManagement: v.inventory_management ?? null,
        requiresShipping: v.requires_shipping ?? null,
        grams: v.grams ?? null,
        weight: toNumber(v.weight),
        weightUnit: v.weight_unit ?? null,
        shopifyCreatedAt: toDate(v.created_at),
        shopifyUpdatedAt: toDate(v.updated_at),
      }
    })

    const quantities = mappedVariants
      .map((v) => v.inventoryQuantity)
      .filter((q) => q != null)
    const totalInventoryQuantity = quantities.length
      ? quantities.reduce((sum, q) => sum + q, 0)
      : null

    const doc = {
      wholesaleProductId,
      retailProductId,
      adminGraphqlApiId: product.admin_graphql_api_id ?? null,
      title: product.title ?? null,
      handle: product.handle ?? null,
      bodyHtml: product.body_html ?? null,
      vendor: product.vendor ?? null,
      productType: product.product_type ?? null,
      status: product.status ?? null,
      tags: normalizeTags(product.tags),
      publishedAt: toDate(product.published_at),
      publishedScope: product.published_scope ?? null,
      templateSuffix: product.template_suffix ?? null,
      options: (product.options || []).map((o) => ({
        name: o.name ?? null,
        position: o.position ?? null,
        values: o.values || [],
      })),
      images: (product.images || []).map((i) => ({
        wholesaleImageId: i.id != null ? String(i.id) : null,
        src: i.src ?? null,
        alt: i.alt ?? null,
        position: i.position ?? null,
        width: i.width ?? null,
        height: i.height ?? null,
        variantIds: (i.variant_ids || []).map((id) => String(id)),
      })),
      variants: mappedVariants,
      variantCount: mappedVariants.length,
      totalInventoryQuantity,
      shopifyCreatedAt: toDate(product.created_at),
      shopifyUpdatedAt: toDate(product.updated_at),
      lastEvent: event,
      lastSyncedAt: new Date(),
    }
    // Only stamp `shop` when the caller provided it, so a shop-less legacy
    // caller can't blank out a previously-recorded value.
    if (shop) doc.shop = shop

    await ProductMap.updateOne(
      { wholesaleProductId },
      { $set: doc },
      { upsert: true },
    )
    log.info('upsert.done', {
      wholesaleProductId,
      retailProductId,
      event,
      variantCount: mappedVariants.length,
    })
    return doc
  } catch (err) {
    log.error('upsert.failed', { productId: product?.id, err })
    return null
  }
}

// Remove the mirror document when the wholesale product is deleted. Never
// throws. The products/delete payload only carries { id }.
export async function deleteProductMap(wholesaleProductId) {
  try {
    const id = String(wholesaleProductId)
    const res = await ProductMap.deleteOne({ wholesaleProductId: id })
    log.info('delete.done', { wholesaleProductId: id, deleted: res?.deletedCount ?? 0 })
    return res?.deletedCount ?? 0
  } catch (err) {
    log.error('delete.failed', { wholesaleProductId, err })
    return 0
  }
}
