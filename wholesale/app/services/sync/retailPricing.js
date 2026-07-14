// Retail-price metafield reader for the wholesale→retail product sync.
//
// Wholesale merchants set a JSON metafield `custom.retail_pricing` on each
// product to specify the RETAIL prices (which differ from wholesale, typically
// ~2×). When we sync a product to the retail store, we read this metafield and
// apply the prices to the outbound retail payload — replacing the previous
// behavior where retail products were created with $0 prices and a merchant
// had to set them by hand on the retail side.
//
// Expected metafield JSON shape (see SHIPPING_LOGIC.md / product-sync doubts):
//
//   {
//     "price": "25.99",              // optional top-level default
//     "compareAtPrice": "29.99",     // optional top-level default
//     "variants": [                  // optional per-variant list, keyed by SKU
//       { "sku": "SKU-A", "price": "25.99", "compareAtPrice": "29.99" },
//       ...
//     ]
//   }
//
// Application rule (per confirmed decisions D2 + D4):
//   - If `variants[]` is populated → variant must be explicitly listed by SKU
//     to receive a price. Unlisted variants sync WITHOUT price (warn log).
//     Top-level `price` is NOT used as a fallback in this mode.
//   - If `variants[]` is empty/absent → top-level `price` applies to ALL
//     variants uniformly (simple-product mode).
//
// Non-breaking guarantees:
//   - Missing metafield → returns null → caller preserves existing behavior
//     (retail product created without prices, as it did before this change).
//   - Session lookup failure, GraphQL error, JSON parse error, empty JSON →
//     all return null with a warn log.
//
// This module is called from `product.sync.js` (syncProductCreate +
// syncProductUpdate) and is otherwise self-contained.

import { unauthenticated } from '../../shopify.server'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('sync.retail_pricing')

const METAFIELD_NAMESPACE = 'custom'
const METAFIELD_KEY = 'retail_pricing'

// Fetches the `custom.retail_pricing` metafield for the given wholesale
// product and returns a normalized structure for `buildRetailPayload`.
//
// Return value:
//   {
//     price: "25.99" | null,
//     compareAtPrice: "29.99" | null,
//     variantsBySku: Map<sku, { price, compareAtPrice }>,
//   }
// OR `null` on any failure/missing (fall back to no-price sync).
export async function fetchRetailPricingMetafield({ shop, productId }) {
  if (!shop || !productId) {
    log.warn('skip.missing_args', { shop, productId })
    return null
  }

  const productGid = `gid://shopify/Product/${productId}`

  let admin
  try {
    const authed = await unauthenticated.admin(shop)
    admin = authed.admin
  } catch (err) {
    log.warn('session_lookup_failed', {
      shop,
      productId,
      err: err?.message || String(err),
    })
    return null
  }

  const query = `#graphql
    query RetailPricingForProduct($id: ID!, $namespace: String!, $key: String!) {
      product(id: $id) {
        id
        metafield(namespace: $namespace, key: $key) {
          value
          type
        }
      }
    }
  `

  let body
  try {
    const res = await admin.graphql(query, {
      variables: {
        id: productGid,
        namespace: METAFIELD_NAMESPACE,
        key: METAFIELD_KEY,
      },
    })
    body = await res.json()
  } catch (err) {
    log.warn('graphql_call_failed', {
      shop,
      productId,
      err: err?.message || String(err),
    })
    return null
  }

  if (Array.isArray(body?.errors) && body.errors.length) {
    log.warn('graphql_errors', {
      productId,
      errors: JSON.stringify(body.errors).slice(0, 400),
    })
    return null
  }

  const metafield = body?.data?.product?.metafield
  if (!metafield?.value) {
    log.info('metafield_missing', { productId })
    return null
  }

  let parsed
  try {
    parsed = JSON.parse(metafield.value)
  } catch (err) {
    log.warn('metafield_parse_failed', {
      productId,
      err: err?.message,
      raw: String(metafield.value).slice(0, 200),
    })
    return null
  }

  return normalizePricing(parsed, productId)
}

// Turn a parsed metafield JSON into the normalized structure the payload
// builder consumes. Returns null if the JSON has no usable pricing.
function normalizePricing(parsed, productId) {
  if (!parsed || typeof parsed !== 'object') {
    log.warn('metafield_not_object', { productId })
    return null
  }

  const topLevelPrice = normalizeMoneyString(parsed.price)
  const topLevelCompareAt = normalizeMoneyString(parsed.compareAtPrice)

  const variantsBySku = new Map()
  if (Array.isArray(parsed.variants)) {
    for (const v of parsed.variants) {
      const sku = String(v?.sku || '').trim()
      if (!sku) continue
      const price = normalizeMoneyString(v?.price)
      const compareAtPrice = normalizeMoneyString(v?.compareAtPrice)
      // Only accept entries that have at least a price
      if (!price) continue
      variantsBySku.set(sku, { price, compareAtPrice })
    }
  }

  // Nothing usable → treat as if metafield were absent
  if (!topLevelPrice && variantsBySku.size === 0) {
    log.warn('metafield_empty_or_invalid', { productId })
    return null
  }

  return {
    price: topLevelPrice,
    compareAtPrice: topLevelCompareAt,
    variantsBySku,
  }
}

// Normalize a money value from the metafield JSON to a Shopify-friendly string
// like "25.99". Accepts numbers (25.99) or strings ("25.99"). Returns null for
// invalid/empty values so callers can treat null as "no price for this field".
function normalizeMoneyString(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw.toFixed(2)
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return null
    const n = Number(trimmed)
    if (!Number.isFinite(n)) return null
    return n.toFixed(2)
  }
  return null
}

// Resolve the retail price for a single wholesale variant, given the
// normalized metafield payload. Returns { price, compareAtPrice } or null.
//
// Rule (per confirmed decisions D2 + D4):
//   1. If the metafield has a non-empty `variants` list, variant is matched
//      strictly by SKU. Unmatched variants → null (no price + warn), NOT the
//      top-level price.
//   2. If the metafield has NO `variants` list (or an empty one), the
//      top-level `price` is applied to all variants uniformly.
//
// This is exported so the payload builder can call it per-variant.
export function resolveVariantPricing(variant, retailPricing) {
  if (!retailPricing) return null
  const sku = String(variant?.sku || '').trim()
  const hasVariantsList = retailPricing.variantsBySku?.size > 0

  if (hasVariantsList) {
    if (sku && retailPricing.variantsBySku.has(sku)) {
      const match = retailPricing.variantsBySku.get(sku)
      return {
        price: match.price,
        compareAtPrice: match.compareAtPrice ?? null,
      }
    }
    log.warn('variant.no_metafield_match', {
      variantSku: sku || '(no SKU)',
      variantId: variant?.id,
    })
    return null
  }

  // No variants list → top-level applies to all
  if (retailPricing.price) {
    return {
      price: retailPricing.price,
      compareAtPrice: retailPricing.compareAtPrice ?? null,
    }
  }

  return null
}
