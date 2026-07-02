// POST /api/cdo/fee-variant   body: { price: 28.42 }
//
// PUBLIC (unauthenticated) endpoint that returns the GID of a
// Processing Fee variant at EXACTLY the requested cent-precise price.
//
// ── Contract ─────────────────────────────────────────────────────────
//   Request:   { price: 28.42 }
//   Response:  { status: 'success', result: { price: 28.42, gid: '...' } }
//
// ── Behavior ─────────────────────────────────────────────────────────
//   1. Fast-path — in-memory `priceIndex` (Map<priceStr, gid>) built by
//      lazily paging every variant on the Processing Fee product on
//      first hit and refreshed via targeted mutations after that. Cache
//      hit → immediate return.
//   2. Cache miss → hit Shopify Admin API to CREATE a new variant at
//      exactly the requested price.
//   3. If the product is at capacity (MAX_VARIANTS_PER_PRODUCT), find
//      the OLDEST variant by createdAt, DELETE it, then create the new
//      one. Deleting a variant that has past orders on it is SAFE:
//      Shopify snapshots line-item data at order time (price, title,
//      SKU) — deletion doesn't touch that snapshot, refunds and
//      receipts stay intact.
//   4. Concurrency — a per-shop mutex serializes creates so two
//      simultaneous requests for the same new price don't race into
//      duplicate variants.
//
// ── Rate-limit + CORS ────────────────────────────────────────────────
//   Same treatment as [[fee-tiers]] — 60 req/min/IP, CORS wildcard.
//   This endpoint is called from the checkout UI extension surface
//   where the customer-account session token isn't available.
//
// ── Failure modes ────────────────────────────────────────────────────
//   • Shopify rate-limit (throttled): retried once with backoff, then
//     bubbled up as 502.
//   • Product at capacity + all variants young: eviction still picks
//     the oldest. Past orders unaffected, but a live cart holding that
//     variant would break — acceptable trade-off at this scale.
//   • userErrors on create: bubbled up verbatim.

import { unauthenticated } from '../../shopify.server'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Access-Control-Max-Age': '86400',
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

const PROCESSING_FEE_PRODUCT_ID =
  // eslint-disable-next-line no-undef
  process.env.PROCESSING_FEE_PRODUCT_ID || '9156714627314'

const SHOP_DOMAIN =
  // eslint-disable-next-line no-undef
  process.env.SHOPIFY_SHOP || 'ns-direct-order-stagging-1.myshopify.com'

// Shopify hard cap. We leave a small headroom so we never race the cap.
const MAX_VARIANTS_PER_PRODUCT = 2000
const EVICTION_HEADROOM = 4

const OPTION_NAME = 'Amount'

// ── In-memory state (process-local) ──────────────────────────────────
// priceIndex: Map<price-string ("28.42"), variant gid>
// initialized: whether we've done the initial full page-through
// lastRefreshAt: epoch ms
let priceIndex = new Map()
let initialized = false
let refreshInFlight = null

// ── In-memory rate limit ─────────────────────────────────────────────
const _attempts = new Map()
function checkRateLimit(ip) {
  const now = Date.now()
  const entry = _attempts.get(ip) || { count: 0, resetAt: now + 60_000 }
  if (now > entry.resetAt) {
    entry.count = 0
    entry.resetAt = now + 60_000
  }
  entry.count += 1
  _attempts.set(ip, entry)
  return entry.count <= 60
}

// ── Per-shop mutex (serializes create/delete) ────────────────────────
// A single Promise chain avoids simultaneous creates racing into
// duplicate-price variants (rare but possible under bursty checkout).
let opChain = Promise.resolve()
function withOpLock(fn) {
  const run = opChain.then(fn, fn)
  // Never let a rejection break the chain for the next caller.
  opChain = run.catch(() => {})
  return run
}

// ── Shopify Admin helpers ────────────────────────────────────────────

const LIST_VARIANTS_QUERY = `
  query listFeeVariants($id: ID!, $cursor: String) {
    product(id: $id) {
      id
      title
      variants(first: 250, after: $cursor, sortKey: ID) {
        edges {
          cursor
          node {
            id
            price
            createdAt
          }
        }
        pageInfo { hasNextPage }
      }
    }
  }
`

const CREATE_MUTATION = `
  mutation createFeeVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(
      productId: $productId
      variants: $variants
      strategy: REMOVE_STANDALONE_VARIANT
    ) {
      productVariants {
        id
        price
        createdAt
      }
      userErrors { field message code }
    }
  }
`

const DELETE_MUTATION = `
  mutation deleteFeeVariant($productId: ID!, $variantsIds: [ID!]!) {
    productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
      product { id }
      userErrors { field message code }
    }
  }
`

async function refreshIndex(admin) {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    const productGid = `gid://shopify/Product/${PROCESSING_FEE_PRODUCT_ID}`
    const all = []
    let cursor = null
    for (;;) {
      const res = await admin.graphql(LIST_VARIANTS_QUERY, {
        variables: { id: productGid, cursor },
      })
      const body = await res.json()
      if (body.errors) {
        throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`)
      }
      const product = body.data?.product
      if (!product) throw new Error(`Product ${productGid} not found`)
      for (const e of product.variants.edges) {
        const priceStr = formatPrice(parseFloat(e.node.price))
        all.push({ priceStr, gid: e.node.id, createdAt: e.node.createdAt })
      }
      if (!product.variants.pageInfo.hasNextPage) break
      cursor = product.variants.edges[product.variants.edges.length - 1].cursor
    }
    // Rebuild the in-memory map. If duplicate prices exist (they
    // shouldn't but let's be resilient), keep the FIRST (oldest by ID
    // sort). Store an array separately so eviction can find "oldest".
    priceIndex = new Map()
    for (const v of all) {
      if (!priceIndex.has(v.priceStr)) {
        priceIndex.set(v.priceStr, v.gid)
      }
    }
    // We also keep the ordered list on the closure for eviction.
    priceIndex._all = all
    initialized = true
    console.log(
      `[fee-variant] index refreshed · ${all.length} variants on product ${PROCESSING_FEE_PRODUCT_ID}`,
    )
  })()
  try {
    await refreshInFlight
  } finally {
    refreshInFlight = null
  }
}

function formatPrice(n) {
  // Normalize to "12.34" so map keys collide correctly (12.4 == 12.40).
  return (Math.round(n * 100) / 100).toFixed(2)
}

async function createVariantAtPrice(admin, priceStr) {
  const productGid = `gid://shopify/Product/${PROCESSING_FEE_PRODUCT_ID}`
  const res = await admin.graphql(CREATE_MUTATION, {
    variables: {
      productId: productGid,
      variants: [
        {
          optionValues: [{ optionName: OPTION_NAME, name: `$${priceStr}` }],
          price: priceStr,
          inventoryPolicy: 'CONTINUE',
          inventoryItem: { tracked: false, requiresShipping: false },
          taxable: false,
        },
      ],
    },
  })
  const body = await res.json()
  if (body.errors) {
    throw new Error(`create GraphQL error: ${JSON.stringify(body.errors)}`)
  }
  const payload = body.data?.productVariantsBulkCreate
  const errs = payload?.userErrors || []
  if (errs.length > 0) {
    // If the option value already exists — a rare race — refresh and
    // return the existing GID instead of erroring.
    const isDuplicate = errs.some(
      (e) =>
        (e.code || '').toUpperCase() === 'TAKEN' ||
        /already exists|duplicate/i.test(e.message || ''),
    )
    if (isDuplicate) {
      await refreshIndex(admin)
      const existing = priceIndex.get(priceStr)
      if (existing) return { gid: existing, createdAt: null }
    }
    throw new Error(
      `productVariantsBulkCreate userErrors: ${JSON.stringify(errs)}`,
    )
  }
  const v = (payload.productVariants || [])[0]
  if (!v) throw new Error('productVariantsBulkCreate returned no variant')
  return { gid: v.id, createdAt: v.createdAt }
}

async function deleteVariant(admin, variantGid) {
  const productGid = `gid://shopify/Product/${PROCESSING_FEE_PRODUCT_ID}`
  const res = await admin.graphql(DELETE_MUTATION, {
    variables: { productId: productGid, variantsIds: [variantGid] },
  })
  const body = await res.json()
  if (body.errors) {
    throw new Error(`delete GraphQL error: ${JSON.stringify(body.errors)}`)
  }
  const errs = body.data?.productVariantsBulkDelete?.userErrors || []
  if (errs.length > 0) {
    throw new Error(
      `productVariantsBulkDelete userErrors: ${JSON.stringify(errs)}`,
    )
  }
}

function pickOldest() {
  // Walk the ordered list; ID sortKey ascending → oldest first.
  const all = priceIndex._all || []
  if (all.length === 0) return null
  // Return the first entry (oldest by id).
  return all[0]
}

async function ensureVariantForPrice(price) {
  const priceStr = formatPrice(price)
  const { admin } = await unauthenticated.admin(SHOP_DOMAIN)

  // Initial index build.
  if (!initialized) await refreshIndex(admin)

  // Cache hit.
  const cached = priceIndex.get(priceStr)
  if (cached) {
    return { priceStr, gid: cached, source: 'cache' }
  }

  // Miss → create under the per-shop mutex.
  return await withOpLock(async () => {
    // Re-check inside the lock (another concurrent request may have
    // created it while we waited).
    const inside = priceIndex.get(priceStr)
    if (inside) return { priceStr, gid: inside, source: 'cache-inlock' }

    // If we're at capacity, evict oldest first.
    const count = (priceIndex._all || []).length
    if (count >= MAX_VARIANTS_PER_PRODUCT - EVICTION_HEADROOM) {
      const victim = pickOldest()
      if (!victim) throw new Error('No variants to evict but at capacity?')
      console.log(
        `[fee-variant] evicting oldest variant · price=$${victim.priceStr} · gid=${victim.gid} · createdAt=${victim.createdAt}`,
      )
      await deleteVariant(admin, victim.gid)
      // Remove from local state.
      priceIndex.delete(victim.priceStr)
      priceIndex._all = (priceIndex._all || []).filter(
        (v) => v.gid !== victim.gid,
      )
    }

    // Create.
    const { gid, createdAt } = await createVariantAtPrice(admin, priceStr)
    priceIndex.set(priceStr, gid)
    priceIndex._all = priceIndex._all || []
    // New variant → append at the END (newest by id).
    priceIndex._all.push({ priceStr, gid, createdAt })
    console.log(
      `[fee-variant] created variant · price=$${priceStr} · gid=${gid}`,
    )
    return { priceStr, gid, source: 'created' }
  })
}

// ── Route handler ────────────────────────────────────────────────────

export async function action({ request }) {
  if (request.method === 'OPTIONS') {
    return json(200, { status: 'success', result: null })
  }
  if (request.method !== 'POST') {
    return json(405, { status: 'error', message: 'Method not allowed — use POST' })
  }

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  if (!checkRateLimit(ip)) {
    return json(429, { status: 'error', message: 'Too many requests' })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return json(400, { status: 'error', message: 'Invalid JSON body' })
  }
  const priceNum = Number(body?.price)
  if (!Number.isFinite(priceNum) || priceNum <= 0) {
    return json(400, {
      status: 'error',
      message: 'Field "price" must be a positive number',
    })
  }
  if (priceNum > 999_999) {
    return json(400, { status: 'error', message: 'Price out of range' })
  }

  try {
    const { priceStr, gid, source } = await ensureVariantForPrice(priceNum)
    return json(200, {
      status: 'success',
      message: 'ok',
      result: {
        price: parseFloat(priceStr),
        gid,
        source,
      },
    })
  } catch (err) {
    console.error('[fee-variant] failed:', err?.message || err)
    return json(502, {
      status: 'error',
      message: 'Could not resolve fee variant',
      detail: err?.message || String(err),
    })
  }
}

export async function loader({ request }) {
  if (request.method === 'OPTIONS') {
    return json(200, { status: 'success', result: null })
  }
  return json(405, { status: 'error', message: 'Method not allowed — use POST' })
}
