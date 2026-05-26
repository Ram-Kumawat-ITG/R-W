import IdMap from './idMap.model'
import { retailClient } from './retailApi'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('sync.product')

// Build the payload for a retail product create/update from the
// wholesale webhook payload (Shopify REST format).
function buildRetailPayload(p) {
  return {
    product: {
      title: p.title,
      body_html: p.body_html,
      vendor: p.vendor,
      product_type: p.product_type,
      tags: p.tags,
      status: p.status,
      options: p.options?.map((o) => ({ name: o.name, values: o.values })),
      variants: p.variants?.map((v) => ({
        option1: v.option1,
        option2: v.option2,
        option3: v.option3,
        price: v.price,
        compare_at_price: v.compare_at_price,
        sku: v.sku,
        taxable: v.taxable,
        barcode: v.barcode,
        inventory_management: 'shopify',
        inventory_policy: v.inventory_policy,
      })),
      images: p.images
        ?.filter((i) => i.src)
        .map((i) => ({ src: i.src, alt: i.alt || null })),
    },
  }
}

// Store variant + inventory item mappings after a create or update.
async function upsertVariantMappings(wholesaleVariants, retailVariants) {
  for (let i = 0; i < wholesaleVariants.length && i < retailVariants.length; i++) {
    const wv = wholesaleVariants[i]
    const rv = retailVariants[i]
    await IdMap.updateOne(
      { entityType: 'productVariant', wholesaleId: String(wv.id) },
      { $set: { entityType: 'productVariant', wholesaleId: String(wv.id), retailId: String(rv.id) } },
      { upsert: true },
    )
    await IdMap.updateOne(
      { entityType: 'inventoryItem', wholesaleId: String(wv.inventory_item_id) },
      {
        $set: {
          entityType: 'inventoryItem',
          wholesaleId: String(wv.inventory_item_id),
          retailId: String(rv.inventory_item_id),
        },
      },
      { upsert: true },
    )
  }
}

export async function syncProductCreate(wholesaleProduct) {
  const wholesaleId = String(wholesaleProduct.id)

  const existing = await IdMap.findOne({ entityType: 'product', wholesaleId })
  if (existing) {
    log.info('product_create.already_mapped', { wholesaleId, retailId: existing.retailId })
    return syncProductUpdate(wholesaleProduct)
  }

  const data = await retailClient.post('products.json', buildRetailPayload(wholesaleProduct))
  const retailProduct = data?.product
  if (!retailProduct?.id) {
    throw new Error(`syncProductCreate: no retail product id returned for wholesale ${wholesaleId}`)
  }

  await IdMap.create({ entityType: 'product', wholesaleId, retailId: String(retailProduct.id) })
  await upsertVariantMappings(wholesaleProduct.variants || [], retailProduct.variants || [])

  log.info('product_create.done', { wholesaleId, retailId: String(retailProduct.id) })
  return retailProduct
}

export async function syncProductUpdate(wholesaleProduct) {
  const wholesaleId = String(wholesaleProduct.id)

  const mapping = await IdMap.findOne({ entityType: 'product', wholesaleId })
  if (!mapping) {
    log.warn('product_update.no_mapping', { wholesaleId })
    return
  }

  const retailId = mapping.retailId
  await retailClient.put(`products/${retailId}.json`, buildRetailPayload(wholesaleProduct))

  // Re-fetch to get current retail variant IDs (variants may be added/removed)
  const retailData = await retailClient.get(`products/${retailId}.json`)
  await upsertVariantMappings(
    wholesaleProduct.variants || [],
    retailData?.product?.variants || [],
  )

  log.info('product_update.done', { wholesaleId, retailId })
}

export async function syncProductDelete(wholesaleProductId) {
  const wholesaleId = String(wholesaleProductId)

  const mapping = await IdMap.findOne({ entityType: 'product', wholesaleId })
  if (!mapping) {
    log.warn('product_delete.no_mapping', { wholesaleId })
    return
  }

  try {
    await retailClient.delete(`products/${mapping.retailId}.json`)
  } catch (err) {
    if (!err.message?.includes('404')) throw err
    log.warn('product_delete.retail_already_gone', { wholesaleId, retailId: mapping.retailId })
  }

  await IdMap.deleteOne({ entityType: 'product', wholesaleId })
  log.info('product_delete.done', { wholesaleId, retailId: mapping.retailId })
}
