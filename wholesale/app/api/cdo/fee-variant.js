// POST /api/cdo/fee-variant   body: { price: 28.42 }
//
// PUBLIC (unauthenticated) endpoint that returns the GID of a
// Processing Fee variant at EXACTLY the requested cent-precise price.
//
// Mirrors ns-retail/app/api/cdo/fee-variant.js 1:1 — same logic, same
// contract. Each store (retail vs wholesale) has its OWN "Processing
// Fee" product with its OWN variant pool; the env var
// PROCESSING_FEE_PRODUCT_ID selects the right one per environment.
// When you change one of these two files, update the other to match.
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
//      the OLDEST variant by ID (sortKey ID ascending), DELETE it, then
//      create the new one. Deleting a variant that has past orders on
//      it is SAFE: Shopify snapshots line-item data at order time
//      (price, title, SKU) — deletion doesn't touch that snapshot,
//      refunds and receipts stay intact.
//   4. Concurrency — a per-shop mutex serializes creates so two
//      simultaneous requests for the same new price don't race into
//      duplicate variants.
//
// ── Env vars ─────────────────────────────────────────────────────────
//   PROCESSING_FEE_PRODUCT_ID  — numeric Product ID of the wholesale
//                                "Processing Fee" product. Required.
//   SHOPIFY_SHOP               — wholesale shop domain
//                                (default: staging). Required in prod.

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

// The Processing Fee product's numeric ID for the WHOLESALE store.
// Overridable via env for per-environment stores; defaults to the
// wholesale staging store's product.
const PROCESSING_FEE_PRODUCT_ID =
  // eslint-disable-next-line no-undef
  process.env.PROCESSING_FEE_PRODUCT_ID || '8147757826117'

// The wholesale shop against which we query the Admin API.
const SHOP_DOMAIN =
  // eslint-disable-next-line no-undef
  process.env.SHOPIFY_SHOP || 'ns-wholesale-stagging-1.myshopify.com'

const MAX_VARIANTS_PER_PRODUCT = 2000
const EVICTION_HEADROOM = 4
const OPTION_NAME = 'Amount'

// ── In-memory state (process-local) ──────────────────────────────────
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
let opChain = Promise.resolve()
function withOpLock(fn) {
  const run = opChain.then(fn, fn)
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
    priceIndex = new Map()
    for (const v of all) {
      if (!priceIndex.has(v.priceStr)) {
        priceIndex.set(v.priceStr, v.gid)
      }
    }
    priceIndex._all = all
    initialized = true
    console.log(
      `[fee-variant:wholesale] index refreshed · ${all.length} variants on product ${PROCESSING_FEE_PRODUCT_ID}`,
    )
  })()
  try {
    await refreshInFlight
  } finally {
    refreshInFlight = null
  }
}

function formatPrice(n) {
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
  const all = priceIndex._all || []
  if (all.length === 0) return null
  return all[0]
}

async function ensureVariantForPrice(price) {
  const priceStr = formatPrice(price)
  const { admin } = await unauthenticated.admin(SHOP_DOMAIN)

  if (!initialized) await refreshIndex(admin)

  const cached = priceIndex.get(priceStr)
  if (cached) {
    return { priceStr, gid: cached, source: 'cache' }
  }

  return await withOpLock(async () => {
    const inside = priceIndex.get(priceStr)
    if (inside) return { priceStr, gid: inside, source: 'cache-inlock' }

    const count = (priceIndex._all || []).length
    if (count >= MAX_VARIANTS_PER_PRODUCT - EVICTION_HEADROOM) {
      const victim = pickOldest()
      if (!victim) throw new Error('No variants to evict but at capacity?')
      console.log(
        `[fee-variant:wholesale] evicting oldest variant · price=$${victim.priceStr} · gid=${victim.gid} · createdAt=${victim.createdAt}`,
      )
      await deleteVariant(admin, victim.gid)
      priceIndex.delete(victim.priceStr)
      priceIndex._all = (priceIndex._all || []).filter(
        (v) => v.gid !== victim.gid,
      )
    }

    const { gid, createdAt } = await createVariantAtPrice(admin, priceStr)
    priceIndex.set(priceStr, gid)
    priceIndex._all = priceIndex._all || []
    priceIndex._all.push({ priceStr, gid, createdAt })
    console.log(
      `[fee-variant:wholesale] created variant · price=$${priceStr} · gid=${gid}`,
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
    console.error('[fee-variant:wholesale] failed:', err?.message || err)
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
