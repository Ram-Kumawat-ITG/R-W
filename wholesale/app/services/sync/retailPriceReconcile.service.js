// Retail-price reconciliation (wholesale variant metafields → retail prices).
//
// WHY THIS EXISTS — Shopify does not deliver a webhook for a VARIANT metafield
// edit. Shopify's position is that a metafield is an attached resource, not part
// of the product, so editing `custom.retail_price` on a wholesale VARIANT fires
// NO `products/update` (product-LEVEL metafield edits do fire it; variant-level
// ones don't, and there is no `metafields/*` topic to subscribe to). The
// consequence reported on 2026-07-31: changing only the Retail price on a
// wholesale variant never reached the retail store, while editing the title (or
// any real product field) synced fine — because only the latter produces a
// webhook. The 2026-07-14 (variant-id pairing) and 2026-07-30 (read metafields
// from the webhook payload) fixes both addressed what happens ONCE a webhook
// arrives; neither could help when none arrives at all.
//
// So this sweep is the guarantee: it periodically compares each wholesale
// variant's `custom.retail_price` / `custom.retail_compare_at_price` against the
// last-known retail price recorded in `sync_id_maps` and pushes any difference
// to the retail store. The webhook path remains the fast path for everything
// else and is untouched.
//
// Deliberately SURGICAL: it writes ONLY `price` + `compare_at_price` on the
// specific variants that drifted, via the same `PUT products/{id}.json`
// mechanism the existing sync already uses (proven in this codebase). It never
// sends titles, images, options, or metafields, so it cannot disturb any other
// synced field, and it never touches a variant whose retail_price metafield is
// unset (that variant keeps whatever price retail already has — same rule as
// resolveVariantPricing).
//
// Idempotent: after a successful push the `sync_id_maps` snapshot equals the
// desired price, so the next tick is a no-op. Safe to run as often as you like.

import IdMap from './idMap.model'
import ProductMap from './productMap.model'
import ShopifyOrder from '../../models/order.server'
import { retailClient } from './retailApi'
import { isSyncEnabled, syncConfig } from './sync.config'
import { parseMoneyMetafield } from './retailPricing'
import { PENDING_RETAIL_ID } from './product.sync'
import { unauthenticated } from '../../shopify.server'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('sync.retail_price_reconcile')

const METAFIELD_NAMESPACE = 'custom'
const PRICE_KEY = 'retail_price'
const COMPARE_AT_KEY = 'retail_compare_at_price'

// Upper bound on the per-variant drift rows returned to a caller (the counters
// are always exact). Keeps the admin response bounded on a first-ever run.
const MAX_REPORTED_CHANGES = 250

// One page of wholesale products with every variant's retail-pricing
// metafields. Aliased metafield fields read both keys per variant in one hop
// (same shape retailPricing.js uses for the single-product query).
const PRODUCTS_PRICING_QUERY = `#graphql
  query WholesaleVariantRetailPricing(
    $first: Int!
    $after: String
    $namespace: String!
    $priceKey: String!
    $compareAtKey: String!
  ) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        variants(first: 100) {
          nodes {
            id
            sku
            retailPrice: metafield(namespace: $namespace, key: $priceKey) {
              value
              type
            }
            retailCompareAt: metafield(namespace: $namespace, key: $compareAtKey) {
              value
              type
            }
          }
        }
      }
    }
  }
`

// Numeric id out of a Shopify GID ("gid://shopify/ProductVariant/123" → "123").
// `sync_id_maps` stores the numeric REST ids, since the sync is REST-based.
export function numericId(gid) {
  const raw = String(gid || '')
  const tail = raw.split('/').pop()
  return tail ? String(tail) : null
}

// Money comparison at cent precision. Either side may be null (metafield unset
// / no compare-at on retail), and null vs a number IS a difference.
// (numericId + moneyEquals are exported so the drift comparison — the crux of
// this feature — is directly testable.)
export function moneyEquals(a, b) {
  const na = a === null || a === undefined || a === '' ? null : Number(a)
  const nb = b === null || b === undefined || b === '' ? null : Number(b)
  if (na === null && nb === null) return true
  if (na === null || nb === null) return false
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return false
  return Math.round(na * 100) === Math.round(nb * 100)
}

// Which wholesale shop to read from. Explicit arg wins, then SHOPIFY_SHOP, then
// whatever shop the existing sync/order data was written under (so a deployment
// that never set the env var still reconciles). Returns null when unknown —
// the caller skips rather than guessing.
export async function resolveWholesaleShop(explicit) {
  if (explicit) return String(explicit)
  if (syncConfig.wholesaleShop) return String(syncConfig.wholesaleShop)
  const mapped = await ProductMap.findOne({ shop: { $ne: null } })
    .sort({ updatedAt: -1 })
    .select('shop')
    .lean()
  if (mapped?.shop) return String(mapped.shop)
  const order = await ShopifyOrder.findOne({ shop: { $ne: null } })
    .sort({ receivedAt: -1 })
    .select('shop')
    .lean()
  return order?.shop ? String(order.shop) : null
}

// Read every wholesale product + variant retail-pricing metafield, one page at
// a time. Returns [{ productId, title, variants: [{ variantId, sku, price,
// compareAtPrice }] }] — only variants that HAVE a retail_price are included.
async function fetchWholesalePricing(admin, { pageSize = 50, maxPages = 200 } = {}) {
  const products = []
  let after = null
  let pages = 0

  for (;;) {
    const res = await admin.graphql(PRODUCTS_PRICING_QUERY, {
      variables: {
        first: pageSize,
        after,
        namespace: METAFIELD_NAMESPACE,
        priceKey: PRICE_KEY,
        compareAtKey: COMPARE_AT_KEY,
      },
    })
    const body = await res.json()
    if (Array.isArray(body?.errors) && body.errors.length) {
      throw new Error(`GraphQL errors: ${JSON.stringify(body.errors).slice(0, 400)}`)
    }
    const conn = body?.data?.products
    for (const p of conn?.nodes || []) {
      const productId = numericId(p.id)
      if (!productId) continue
      const variants = []
      for (const v of p.variants?.nodes || []) {
        const variantId = numericId(v.id)
        if (!variantId) continue
        const sku = String(v?.sku || '').trim()
        const price = parseMoneyMetafield(v?.retailPrice, {
          productId,
          sku,
          key: PRICE_KEY,
        })
        // No retail_price set → not managed by this feature; leave retail alone.
        if (!price) continue
        const compareAtPrice = parseMoneyMetafield(v?.retailCompareAt, {
          productId,
          sku,
          key: COMPARE_AT_KEY,
        })
        variants.push({ variantId, sku, price, compareAtPrice: compareAtPrice ?? null })
      }
      if (variants.length > 0) products.push({ productId, title: p.title, variants })
    }
    pages += 1
    if (!conn?.pageInfo?.hasNextPage || pages >= maxPages) break
    after = conn.pageInfo.endCursor
  }

  return products
}

// Compare one wholesale product's desired retail pricing against the mapped
// retail variants' last-known prices, and push the drifted ones.
async function reconcileProduct(product, { dryRun }) {
  // `details` carries one row per drifted variant so callers (the admin
  // "Sync prices now" page, the CLI dry run) can show WHAT changed rather than
  // just a count.
  const result = { checked: 0, drifted: 0, updated: 0, skipped: 0, error: null, details: [] }

  const productMapping = await IdMap.findOne({
    entityType: 'product',
    wholesaleId: product.productId,
  })
    .select('retailId')
    .lean()

  if (!productMapping?.retailId) {
    // Not synced to retail yet — the create path will carry the price.
    result.skipped += product.variants.length
    return result
  }
  if (productMapping.retailId === PENDING_RETAIL_ID) {
    log.info('product.create_in_flight', { wholesaleProductId: product.productId })
    result.skipped += product.variants.length
    return result
  }

  const changes = []
  for (const v of product.variants) {
    result.checked += 1
    const variantMapping = await IdMap.findOne({
      entityType: 'productVariant',
      wholesaleId: v.variantId,
    })
      .select('retailId retailPrice retailCompareAtPrice')
      .lean()

    if (!variantMapping?.retailId) {
      // Variant exists on wholesale but was never paired to a retail variant
      // (e.g. added without a SKU). The webhook path owns creating it.
      result.skipped += 1
      continue
    }

    const priceSame = moneyEquals(v.price, variantMapping.retailPrice)
    const compareSame = moneyEquals(v.compareAtPrice, variantMapping.retailCompareAtPrice)
    if (priceSame && compareSame) continue

    result.drifted += 1
    changes.push({
      id: Number(variantMapping.retailId),
      wholesaleVariantId: v.variantId,
      sku: v.sku,
      price: v.price,
      compare_at_price: v.compareAtPrice,
      from: { price: variantMapping.retailPrice, compareAt: variantMapping.retailCompareAtPrice },
    })
  }

  if (changes.length === 0) return result

  for (const c of changes) {
    log.info('variant.drift_detected', {
      wholesaleProductId: product.productId,
      sku: c.sku,
      retailVariantId: String(c.id),
      fromPrice: c.from.price,
      toPrice: c.price,
      fromCompareAt: c.from.compareAt,
      toCompareAt: c.compare_at_price,
    })
    result.details.push({
      productTitle: product.title || null,
      wholesaleProductId: product.productId,
      sku: c.sku || null,
      retailVariantId: String(c.id),
      fromPrice: c.from.price,
      toPrice: c.price,
      fromCompareAt: c.from.compareAt,
      toCompareAt: c.compare_at_price,
      applied: false, // flipped below once the PUT succeeds
    })
  }

  if (dryRun) return result

  // ONE PUT per product carrying only the drifted variants, and on each of
  // those only `id` + `price` + `compare_at_price`. Shopify updates those
  // fields in place and leaves every other variant/product field untouched.
  let response
  try {
    response = await retailClient.put(`products/${productMapping.retailId}.json`, {
      product: {
        id: Number(productMapping.retailId),
        variants: changes.map((c) => ({
          id: c.id,
          price: c.price,
          compare_at_price: c.compare_at_price,
        })),
      },
    })
  } catch (err) {
    result.error = err?.message || String(err)
    log.error('product.push_failed', {
      wholesaleProductId: product.productId,
      retailProductId: productMapping.retailId,
      err: result.error,
    })
    return result
  }

  // Re-snapshot from what retail actually stored, so the next tick compares
  // against reality rather than what we intended to write.
  const returnedById = new Map(
    (response?.product?.variants || []).map((rv) => [String(rv.id), rv]),
  )
  for (const c of changes) {
    const rv = returnedById.get(String(c.id))
    const storedPrice = rv?.price !== undefined ? rv.price : c.price
    const storedCompareAt =
      rv?.compare_at_price !== undefined ? rv.compare_at_price : c.compare_at_price
    await IdMap.updateOne(
      { entityType: 'productVariant', wholesaleId: c.wholesaleVariantId },
      {
        $set: {
          retailPrice: storedPrice === null || storedPrice === '' ? null : Number(storedPrice),
          retailCompareAtPrice:
            storedCompareAt === null || storedCompareAt === '' ? null : Number(storedCompareAt),
        },
      },
    ).catch((err) =>
      log.warn('variant.snapshot_write_failed', {
        wholesaleVariantId: c.wholesaleVariantId,
        err: err?.message || String(err),
      }),
    )
    result.updated += 1
  }

  for (const d of result.details) d.applied = true

  log.info('product.pushed', {
    wholesaleProductId: product.productId,
    retailProductId: productMapping.retailId,
    variantsUpdated: result.updated,
  })
  return result
}

// Sweep every wholesale product's retail-pricing metafields and push drift to
// retail. Never throws — returns a summary so the caller (CRON tick / script /
// admin action) can log it.
//
// Options:
//   shop       — wholesale shop domain (defaults via resolveWholesaleShop)
//   dryRun     — detect + log drift, write nothing
//   productIds — restrict to specific wholesale product ids (numeric strings)
export async function reconcileRetailPrices({ shop, dryRun = false, productIds = null } = {}) {
  const summary = {
    productsScanned: 0,
    productsWithDrift: 0,
    variantsChecked: 0,
    variantsDrifted: 0,
    variantsUpdated: 0,
    variantsSkipped: 0,
    errors: 0,
    dryRun: Boolean(dryRun),
    // Per-variant drift rows for the UI / CLI. Capped so a first run over a
    // large catalog can't build an unbounded response payload; the counters
    // above always reflect the true totals.
    changes: [],
    changesTruncated: false,
  }

  if (!isSyncEnabled()) {
    log.info('skip.sync_disabled')
    return { ...summary, skipped: true, reason: 'sync_disabled' }
  }

  const resolvedShop = await resolveWholesaleShop(shop)
  if (!resolvedShop) {
    log.warn('skip.no_shop')
    return { ...summary, skipped: true, reason: 'no_shop' }
  }

  let admin
  try {
    const authed = await unauthenticated.admin(resolvedShop)
    admin = authed.admin
  } catch (err) {
    log.warn('skip.session_lookup_failed', {
      shop: resolvedShop,
      err: err?.message || String(err),
    })
    return { ...summary, skipped: true, reason: 'no_session' }
  }

  let products
  try {
    products = await fetchWholesalePricing(admin)
  } catch (err) {
    log.error('fetch_failed', { shop: resolvedShop, err: err?.message || String(err) })
    return { ...summary, skipped: true, reason: 'fetch_failed', error: err?.message || String(err) }
  }

  const wanted = productIds ? new Set(productIds.map(String)) : null
  for (const product of products) {
    if (wanted && !wanted.has(product.productId)) continue
    summary.productsScanned += 1
    const r = await reconcileProduct(product, { dryRun })
    summary.variantsChecked += r.checked
    summary.variantsDrifted += r.drifted
    summary.variantsUpdated += r.updated
    summary.variantsSkipped += r.skipped
    if (r.drifted > 0) summary.productsWithDrift += 1
    if (r.error) summary.errors += 1
    for (const d of r.details || []) {
      if (summary.changes.length < MAX_REPORTED_CHANGES) summary.changes.push(d)
      else summary.changesTruncated = true
    }
  }

  log.info('done', { shop: resolvedShop, ...summary })
  return summary
}
