// Variant-level retail-pricing reader for the wholesale→retail product sync.
//
// The wholesale merchant sets two `money` metafields on EACH variant of a
// wholesale product to specify the RETAIL prices (typically ~2× wholesale):
//
//   custom.retail_price              (money — required to apply pricing)
//   custom.retail_compare_at_price   (money — optional strike-through)
//
// The definitions are created once via Shopify admin → Settings → Custom
// data → Variants → Add definition (owner: PRODUCTVARIANT, type: money).
// After that, every variant edit page shows two money input fields — the
// merchant types prices directly, no JSON.
//
// Previous behaviour (deprecated 2026-07-17): product-level
// `custom.retail_pricing` JSON metafield. Client-unfriendly (typos broke
// sync). Superseded by these per-variant money metafields.
//
// This module is called from `product.sync.js` (syncProductCreate +
// syncProductUpdate) and is otherwise self-contained.

import { unauthenticated } from '../../shopify.server'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('sync.retail_pricing')

const METAFIELD_NAMESPACE = 'custom'
const PRICE_KEY = 'retail_price'
const COMPARE_AT_KEY = 'retail_compare_at_price'

// GraphQL: fetch all variants of a wholesale product with both retail
// pricing metafields in a single call. Aliased fields let us read two
// different metafields on the same variant node in one round-trip.
const VARIANT_PRICING_QUERY = `#graphql
  query VariantRetailPricing($productGid: ID!, $namespace: String!, $priceKey: String!, $compareAtKey: String!) {
    product(id: $productGid) {
      id
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
`

// Fetches variant-level retail pricing for every variant of a wholesale
// product. Returns Map<sku, { price, compareAtPrice }> — SKU-keyed because
// SKU is the stable cross-store identifier used by the rest of the sync.
//
// Return value:
//   Map<sku, { price: "25.99" | null, compareAtPrice: "29.99" | null }>
// Variants missing the required `retail_price` metafield are OMITTED from
// the map — `resolveVariantPricing` treats "no entry" as "no pricing"
// (variant syncs without a price; matches pre-metafield behavior).
//
// Never throws — any failure (session lookup, GraphQL error, malformed
// data) returns an empty Map with a warn log so the sync proceeds
// gracefully instead of blowing up on webhook.
export async function fetchVariantRetailPricingBySku({ shop, productId }) {
  const empty = new Map()

  if (!shop || !productId) {
    log.warn('skip.missing_args', { shop, productId })
    return empty
  }

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
    return empty
  }

  const productGid = `gid://shopify/Product/${productId}`

  let body
  try {
    const res = await admin.graphql(VARIANT_PRICING_QUERY, {
      variables: {
        productGid,
        namespace: METAFIELD_NAMESPACE,
        priceKey: PRICE_KEY,
        compareAtKey: COMPARE_AT_KEY,
      },
    })
    body = await res.json()
  } catch (err) {
    log.warn('graphql_call_failed', {
      shop,
      productId,
      err: err?.message || String(err),
    })
    return empty
  }

  if (Array.isArray(body?.errors) && body.errors.length) {
    log.warn('graphql_errors', {
      productId,
      errors: JSON.stringify(body.errors).slice(0, 400),
    })
    return empty
  }

  const variants = body?.data?.product?.variants?.nodes || []
  const result = new Map()
  for (const v of variants) {
    const sku = String(v?.sku || '').trim()
    if (!sku) {
      // No SKU → we can't key the map. Log and skip. The rest of the sync
      // already warns on empty-SKU variants, so this doesn't add signal.
      continue
    }

    const price = parseMoneyMetafield(v?.retailPrice, {
      productId,
      sku,
      key: PRICE_KEY,
    })
    if (!price) continue // no retail price → variant syncs without price

    const compareAtPrice = parseMoneyMetafield(v?.retailCompareAt, {
      productId,
      sku,
      key: COMPARE_AT_KEY,
    })

    result.set(sku, { price, compareAtPrice: compareAtPrice ?? null })
  }

  log.info('fetched', {
    productId,
    variantsWithPricing: result.size,
    variantsTotal: variants.length,
  })
  return result
}

// Parse Shopify's money-metafield value into a plain string like "25.99".
// Shopify stores `money` metafields as a JSON blob: {"amount":"25.99","currency_code":"USD"}
// We keep only `amount` because the retail sync writes to Shopify REST which
// infers currency from the destination shop settings.
function parseMoneyMetafield(mf, ctx) {
  if (!mf || !mf.value) return null
  const raw = String(mf.value).trim()
  if (!raw) return null

  // The most common shape: JSON with `amount` field.
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.amount != null) {
      return normalizeMoneyString(parsed.amount)
    }
  } catch {
    // Fall through — some shops may store plain decimals if the definition
    // was created with a different type or edited outside the money UI.
  }

  // Defensive fallback: raw decimal string (e.g. "25.99").
  const asDecimal = normalizeMoneyString(raw)
  if (asDecimal) return asDecimal

  log.warn('money_parse_failed', { ...ctx, raw: raw.slice(0, 100) })
  return null
}

function normalizeMoneyString(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw.toFixed(2)
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return null
    const n = Number(trimmed)
    if (!Number.isFinite(n) || n < 0) return null
    return n.toFixed(2)
  }
  return null
}

// Resolve the retail price for a single wholesale variant, given the
// SKU-keyed pricing map from `fetchVariantRetailPricingBySku`. Returns
// { price, compareAtPrice } or null when no metafield is set on that
// variant.
//
// Rules (2026-07-17 — variant-level metafields):
//   - Variant SKU must appear in the map. No product-wide fallback: each
//     variant either has its own `custom.retail_price` set or syncs
//     without a price (matches the pre-metafield legacy behavior).
//   - `compareAtPrice` may be null even when `price` is set — a variant
//     with retail price but no strike-through is fine.
export function resolveVariantPricing(variant, pricingBySku) {
  if (!pricingBySku || pricingBySku.size === 0) return null

  const sku = String(variant?.sku || '').trim()
  if (!sku) {
    log.warn('variant.no_sku_cannot_price', { variantId: variant?.id })
    return null
  }

  const match = pricingBySku.get(sku)
  if (!match) {
    // Not an error — merchant may not have set retail price on this
    // variant yet. Log at info so ops can see the "missing" list.
    log.info('variant.no_retail_price_set', {
      variantId: variant?.id,
      sku,
    })
    return null
  }

  return {
    price: match.price,
    compareAtPrice: match.compareAtPrice ?? null,
    source: 'variant_metafield',
  }
}
