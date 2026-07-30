// Fetches all `custom` namespace metafields (both product-level AND variant-level)
// from a wholesale Shopify product so the wholesale→retail product sync can
// mirror them onto the retail product/variant records verbatim.
//
// Rationale (2026-07-28): merchants set business-critical metafields on the
// wholesale product (e.g. `custom.pack_category` for shipping classification,
// or any custom field the merchant defines going forward). Without this fetch,
// the sync payload had no `metafields` array — the retail store never
// received those values, and features that read metafields on retail (like
// the carrier-service shipping algorithm) had nothing to work with.
//
// Scope:
//   - Namespace filter: ONLY `custom` (the merchant-owned namespace).
//     App/system namespaces (`shopify`, `app`, `metaobject_reference`,
//     etc.) are deliberately skipped so we don't sync auto-generated
//     internal metafields.
//   - Value pass-through: every metafield's raw string `value` + `type` is
//     preserved verbatim. Shopify's REST API accepts the same string for
//     the write side, so no conversion is needed. This handles every type
//     (single_line_text_field, money, number_decimal, json, list.*, etc.)
//     uniformly.
//   - Non-throwing: any failure (missing session, GraphQL error, network)
//     returns an empty result so the sync degrades gracefully to
//     "no metafields synced" instead of blocking the entire product sync.
//
// Not covered (intentional):
//   - Definition sync (namespace/key/type/pin/choice list). Shopify has no
//     API to copy a definition from one store to another; the merchant
//     must create it on retail separately if they want it to appear as a
//     structured form field in retail admin. Metafield VALUES sync fine
//     without a definition and remain readable via API — which is all
//     that shipping-algorithm-style consumers need.
//   - Deletion sync. If the merchant DELETES a metafield on wholesale,
//     the retail-side value stays until it's overwritten or the retail
//     record is rebuilt. Deferred until it becomes an operational need.

import { unauthenticated } from '../../shopify.server'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('sync.product_metafields')

const METAFIELD_NAMESPACE = 'custom'
const MAX_METAFIELDS_PER_OWNER = 50
const MAX_VARIANTS_PER_PRODUCT = 100

// GraphQL: fetch product-level metafields + every variant's metafields
// in one round-trip. `namespace` is filtered server-side so we only
// transfer merchant-owned data. `metafields(first: N, namespace: …)`
// caps ownership counts (Shopify enforces first ≤ 250; we pick 50 as a
// safety cap consistent with how merchants use the `custom` namespace).
const PRODUCT_METAFIELDS_QUERY = `#graphql
  query ProductAllCustomMetafields(
    $productGid: ID!,
    $namespace: String!,
    $maxProductMetafields: Int!,
    $maxVariants: Int!,
    $maxVariantMetafields: Int!,
  ) {
    product(id: $productGid) {
      id
      metafields(first: $maxProductMetafields, namespace: $namespace) {
        nodes {
          namespace
          key
          value
          type
        }
      }
      variants(first: $maxVariants) {
        nodes {
          id
          sku
          metafields(first: $maxVariantMetafields, namespace: $namespace) {
            nodes {
              namespace
              key
              value
              type
            }
          }
        }
      }
    }
  }
`

// Fetches all custom-namespace metafields for a wholesale product.
//
// Returns:
//   {
//     productMetafields: [{ namespace, key, value, type }],
//     variantMetafieldsBySku: Map<sku, [{ namespace, key, value, type }]>,
//   }
//
// Both arrays are pre-shaped for direct inclusion in Shopify's REST
// product payload's `metafields` field.
export async function fetchAllCustomMetafieldsForProduct({ shop, productId }) {
  const empty = { productMetafields: [], variantMetafieldsBySku: new Map() }

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
    const res = await admin.graphql(PRODUCT_METAFIELDS_QUERY, {
      variables: {
        productGid,
        namespace: METAFIELD_NAMESPACE,
        maxProductMetafields: MAX_METAFIELDS_PER_OWNER,
        maxVariants: MAX_VARIANTS_PER_PRODUCT,
        maxVariantMetafields: MAX_METAFIELDS_PER_OWNER,
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

  const product = body?.data?.product
  if (!product) {
    log.info('product_not_found', { productId })
    return empty
  }

  const productMetafields = (product.metafields?.nodes || []).map(normalize)
  const variantMetafieldsBySku = new Map()

  for (const v of product.variants?.nodes || []) {
    const sku = String(v?.sku || '').trim()
    if (!sku) continue // SKU-less variants can't pair with retail; skip cleanly
    const rows = (v.metafields?.nodes || []).map(normalize)
    if (rows.length > 0) variantMetafieldsBySku.set(sku, rows)
  }

  log.info('fetched', {
    productId,
    productMetafieldCount: productMetafields.length,
    variantsWithMetafields: variantMetafieldsBySku.size,
  })

  return { productMetafields, variantMetafieldsBySku }
}

// Drop the GraphQL-only shape metadata (no __typename, no `id`) so the
// output is exactly what Shopify's REST product-create/update payload
// wants inside `metafields[]`. The raw value + type are preserved.
function normalize(mf) {
  return {
    namespace: mf.namespace,
    key: mf.key,
    value: mf.value,
    type: mf.type,
  }
}
