import { authenticate } from '../../shopify.server'
import connectDB from '../../services/APIService/mongo.service'
import { sendResponse } from '../../services/APIService/api.service'
import { isSyncEnabled } from '../../services/sync/sync.config'
import { syncProductCreate } from '../../services/sync/product.sync'
import IdMap from '../../services/sync/idMap.model'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('api.admin.sync_backfill')

// Simple products query — no nested inventory levels (keeps cost well under 1000)
const PRODUCTS_QUERY = `
  query getProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      edges {
        node {
          legacyResourceId
          title
          descriptionHtml
          vendor
          productType
          tags
          status
          options { name values }
          variants(first: 100) {
            edges {
              node {
                legacyResourceId
                sku
                price
                compareAtPrice
                selectedOptions { name value }
                taxable
                barcode
                inventoryPolicy
                inventoryQuantity
                inventoryItem { legacyResourceId }
              }
            }
          }
          images(first: 20) {
            edges {
              node { url altText }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

// Separate query to fetch inventory levels in batches via nodes(ids:[])
const INVENTORY_LEVELS_QUERY = `
  query getInventoryLevels($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on InventoryItem {
        legacyResourceId
        inventoryLevels(first: 5) {
          nodes {
            quantities(names: ["available"]) { name quantity }
          }
        }
      }
    }
  }
`

function gqlToRestProduct(node) {
  const variants = (node.variants?.edges || []).map((e) => {
    const v = e.node
    const opts = v.selectedOptions || []
    return {
      id: parseInt(v.legacyResourceId),
      option1: opts[0]?.value ?? null,
      option2: opts[1]?.value ?? null,
      option3: opts[2]?.value ?? null,
      price: v.price,
      compare_at_price: v.compareAtPrice ?? null,
      sku: v.sku ?? '',
      taxable: v.taxable ?? true,
      barcode: v.barcode ?? null,
      inventory_policy: v.inventoryPolicy?.toLowerCase() ?? 'deny',
      inventory_item_id: parseInt(v.inventoryItem?.legacyResourceId),
      inventory_quantity: v.inventoryQuantity ?? null,
    }
  })

  return {
    id: parseInt(node.legacyResourceId),
    title: node.title,
    body_html: node.descriptionHtml ?? '',
    vendor: node.vendor ?? '',
    product_type: node.productType ?? '',
    tags: Array.isArray(node.tags) ? node.tags.join(', ') : (node.tags ?? ''),
    status: node.status?.toLowerCase() ?? 'active',
    options: node.options ?? [],
    variants,
    images: (node.images?.edges || []).map((e) => ({
      src: e.node.url,
      alt: e.node.altText ?? null,
    })),
  }
}

// After all products are synced, fetch current inventory levels from Shopify
// in batches of 50 and save them to MongoDB inventoryItem rows.
async function snapshotAllInventoryLevels(admin) {
  const allMaps = await IdMap.find({ entityType: 'inventoryItem' }).lean()
  if (allMaps.length === 0) return 0

  const BATCH = 50
  let updated = 0

  for (let i = 0; i < allMaps.length; i += BATCH) {
    const batch = allMaps.slice(i, i + BATCH)
    const gids = batch.map((m) => `gid://shopify/InventoryItem/${m.wholesaleId}`)

    const res = await admin.graphql(INVENTORY_LEVELS_QUERY, { variables: { ids: gids } })
    const json = await res.json()

    for (const node of json?.data?.nodes || []) {
      if (!node?.legacyResourceId) continue
      const available =
        node.inventoryLevels?.nodes?.[0]?.quantities?.find((q) => q.name === 'available')
          ?.quantity ?? null
      if (available === null) continue

      await IdMap.updateOne(
        { entityType: 'inventoryItem', wholesaleId: String(node.legacyResourceId) },
        { $set: { available } },
      )
      updated++
    }
  }

  return updated
}

// POST /api/admin/sync/backfill
//
// One-time endpoint to sync all existing wholesale products to retail and
// populate the sync_id_maps collection. Safe to run multiple times —
// syncProductCreate is idempotent (skips products that already have a mapping).
export async function action({ request }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  const { admin, session } = await authenticate.admin(request)
  const shop = session.shop

  if (!isSyncEnabled()) {
    return sendResponse(503, 'error', 'Sync not configured — set RETAIL_SHOP_DOMAIN and RETAIL_ADMIN_ACCESS_TOKEN', null)
  }

  await connectDB()

  // Phase 1 — Fetch all products and sync to retail
  const allProducts = []
  let hasNextPage = true
  let after = null

  while (hasNextPage) {
    const res = await admin.graphql(PRODUCTS_QUERY, { variables: { first: 50, after } })
    const json = await res.json()
    const productsData = json?.data?.products

    if (!productsData) {
      log.error('backfill.graphql_no_data', { shop, json })
      return sendResponse(502, 'error', 'GraphQL returned no products data', { json })
    }

    for (const edge of productsData.edges || []) {
      allProducts.push(gqlToRestProduct(edge.node))
    }

    hasNextPage = productsData.pageInfo?.hasNextPage ?? false
    after = productsData.pageInfo?.endCursor ?? null
  }

  log.info('backfill.start', { shop, totalProducts: allProducts.length })

  const results = { synced: 0, skipped: 0, failed: 0, inventorySnapshotted: 0, errors: [] }

  for (const product of allProducts) {
    try {
      await syncProductCreate(product)
      results.synced++
      log.info('backfill.product_synced', { wholesaleId: product.id, title: product.title })
    } catch (err) {
      results.failed++
      results.errors.push({ productId: product.id, title: product.title, error: err.message })
      log.error('backfill.product_failed', { wholesaleId: product.id, title: product.title, err })
    }
  }

  // Phase 2 — Snapshot current inventory levels into MongoDB (separate batched queries)
  try {
    results.inventorySnapshotted = await snapshotAllInventoryLevels(admin)
    log.info('backfill.inventory_snapshot_done', { shop, inventorySnapshotted: results.inventorySnapshotted })
  } catch (err) {
    log.error('backfill.inventory_snapshot_failed', { shop, err })
  }

  log.info('backfill.done', { shop, ...results })
  return sendResponse(200, 'success', `Backfill complete: ${results.synced} synced, ${results.inventorySnapshotted} inventory levels saved, ${results.failed} failed`, results)
}

export async function loader() {
  return sendResponse(405, 'error', 'Method not allowed', null)
}
