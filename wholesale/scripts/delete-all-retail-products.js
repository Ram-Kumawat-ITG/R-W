/* eslint-env node */
// One-off catalog reset: deletes EVERY product from the RETAIL Shopify
// store, ahead of a fresh product-catalog import. Sibling of
// delete-all-wholesale-products.js — see that file for the overall design.
//
// The retail store has no stored app session in this workspace; it is
// reached the same way cdo.service.js reaches it — a direct Admin GraphQL
// call with the static RETAIL_ADMIN_ACCESS_TOKEN. That makes this script
// fully self-contained: no MongoDB, no app imports, no side effects beyond
// the Shopify product deletions themselves.
//
// Deleting a product via productDelete removes the product together with all
// of its variants, media/images, and options — Shopify cascades those.
//
// Safety rails:
//   - Targets ONLY the retail store: shop comes exclusively from
//     RETAIL_SHOP_DOMAIN (no default), and the script hard-refuses any
//     domain containing "wholesale".
//   - A live run requires the explicit --confirm flag; --dry-run lists what
//     would be deleted and changes nothing.
//
// NOTE: retail products are linked to wholesale products via the product
// sync's `sync_id_maps` collection (retailId ↔ wholesale variant). Deleting
// the retail catalog orphans those mappings — expected for a full reset,
// since the fresh import will rebuild them.
//
// Usage:
//   npm run delete:retail-products -- --dry-run    # count + list, no changes
//   npm run delete:retail-products -- --confirm    # actually delete everything

const TAG = '[delete:retail-products]'

const SHOP = (process.env.RETAIL_SHOP_DOMAIN || '').trim().toLowerCase()
const TOKEN = (process.env.RETAIL_ADMIN_ACCESS_TOKEN || '').trim()
const API_VERSION = process.env.RETAIL_API_VERSION || '2025-10'

const dryRun = process.argv.includes('--dry-run')
const confirmed = process.argv.includes('--confirm')

const PAGE_SIZE = 50
const MAX_CALL_ATTEMPTS = 5
const PACING_MS = 150 // polite spacing between deletes; throttle handling does the rest

const QUERY_PRODUCTS_COUNT = `#graphql
  query { productsCount { count } }`

const QUERY_PRODUCTS_PAGE = `#graphql
  query ProductsPage($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id title }
    }
  }`

const MUTATION_PRODUCT_DELETE = `#graphql
  mutation DeleteProduct($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors { field message }
    }
  }`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// How long to wait after a THROTTLED response. Prefer the exact refill time
// from the response's throttleStatus; fall back to exponential backoff.
function throttleDelayMs(json, attempt) {
  const cost = json?.extensions?.cost
  const status = cost?.throttleStatus
  if (status?.restoreRate > 0) {
    const deficit = (cost.requestedQueryCost || 10) - (status.currentlyAvailable || 0)
    if (deficit > 0) return Math.ceil((deficit / status.restoreRate) * 1000) + 250
  }
  return Math.min(1000 * 2 ** attempt, 10_000)
}

// Execute one Admin GraphQL call against the retail store with retries for
// throttling (waits for the cost bucket), transient network errors, and 5xx
// responses (exponential backoff). Other GraphQL/HTTP errors are thrown.
async function callWithRetry(operation, variables) {
  const url = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`
  for (let attempt = 0; ; attempt++) {
    let json
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': TOKEN,
        },
        body: JSON.stringify({ query: operation, variables }),
      })
      if (res.status === 429 || res.status >= 500) {
        throw Object.assign(new Error(`HTTP ${res.status}`), { transient: true })
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
      }
      json = await res.json()
    } catch (err) {
      const transient = err.transient || err.name === 'TypeError' || /fetch failed/i.test(err.message)
      if (!transient || attempt + 1 >= MAX_CALL_ATTEMPTS) throw err
      const wait = Math.min(1000 * 2 ** attempt, 10_000)
      console.warn(`${TAG}   transient error (${err.message}) — retrying in ${wait}ms`)
      await sleep(wait)
      continue
    }
    const errors = json?.errors || []
    const throttled = errors.some((e) => e?.extensions?.code === 'THROTTLED')
    if (!throttled) {
      if (errors.length) {
        throw new Error(errors.map((e) => e.message).join('; '))
      }
      return json
    }
    if (attempt + 1 >= MAX_CALL_ATTEMPTS) {
      throw new Error('still rate-limited after max retries')
    }
    const wait = throttleDelayMs(json, attempt)
    console.warn(`${TAG}   rate limited — waiting ${wait}ms for the cost bucket to refill`)
    await sleep(wait)
  }
}

async function fetchProductsPage(after = null) {
  const json = await callWithRetry(QUERY_PRODUCTS_PAGE, { first: PAGE_SIZE, after })
  return json?.data?.products || { pageInfo: { hasNextPage: false }, nodes: [] }
}

async function main() {
  // ---- Safety guards: this script may only ever touch the retail store.
  if (!SHOP) {
    console.error(`${TAG} ABORT — RETAIL_SHOP_DOMAIN is not set in .env.`)
    process.exit(1)
  }
  if (!TOKEN) {
    console.error(`${TAG} ABORT — RETAIL_ADMIN_ACCESS_TOKEN is not set in .env.`)
    process.exit(1)
  }
  if (SHOP.includes('wholesale')) {
    console.error(
      `${TAG} ABORT — RETAIL_SHOP_DOMAIN resolves to "${SHOP}", which looks like the ` +
        `WHOLESALE store. This script only ever targets the retail store ` +
        `(use delete:wholesale-products for wholesale).`,
    )
    process.exit(1)
  }
  if (!dryRun && !confirmed) {
    console.error(
      `${TAG} Refusing to run without an explicit flag.\n` +
        `  Preview:  npm run delete:retail-products -- --dry-run\n` +
        `  Execute:  npm run delete:retail-products -- --confirm`,
    )
    process.exit(1)
  }

  console.log(`${TAG} target store: ${SHOP} ${dryRun ? '(DRY RUN — no changes)' : '(LIVE DELETE)'}`)

  const countJson = await callWithRetry(QUERY_PRODUCTS_COUNT)
  const totalFound = countJson?.data?.productsCount?.count ?? 0
  console.log(`${TAG} products found: ${totalFound}`)
  if (totalFound === 0) {
    console.log(`${TAG} nothing to delete.`)
    process.exit(0)
  }

  // ---- Dry run: paginate with cursors (nothing changes, so cursors stay valid).
  if (dryRun) {
    let listed = 0
    let after = null
    for (;;) {
      const page = await fetchProductsPage(after)
      for (const p of page.nodes) {
        listed += 1
        console.log(`  would delete ${p.id}  "${p.title}"`)
      }
      if (!page.pageInfo.hasNextPage) break
      after = page.pageInfo.endCursor
    }
    console.log(`${TAG} --dry-run — ${listed} product(s) would be deleted. No changes made.`)
    process.exit(0)
  }

  // ---- Live delete. Cursors are invalidated by deletion, so instead of
  // walking pages we repeatedly re-fetch the FIRST page and delete it, until
  // the store is empty. Products that permanently fail are remembered and
  // skipped so the loop can never spin on them.
  let deleted = 0
  let failed = 0
  const failedIds = new Set()

  for (;;) {
    const page = await fetchProductsPage()
    const candidates = page.nodes.filter((p) => !failedIds.has(p.id))

    if (page.nodes.length === 0) break // store is empty
    if (candidates.length === 0) {
      // Only permanently-failed products remain — stop instead of looping forever.
      console.warn(`${TAG} only failed products remain (${failedIds.size}) — stopping.`)
      break
    }

    for (const product of candidates) {
      try {
        const json = await callWithRetry(MUTATION_PRODUCT_DELETE, {
          input: { id: product.id },
        })
        const block = json?.data?.productDelete
        const userErrors = block?.userErrors || []
        if (userErrors.length) {
          failed += 1
          failedIds.add(product.id)
          console.error(
            `  ✗ FAILED ${product.id} "${product.title}": ${userErrors.map((e) => e.message).join('; ')}`,
          )
        } else {
          deleted += 1
          console.log(`  ✓ deleted ${product.id} "${product.title}"  (${deleted}/${totalFound})`)
        }
      } catch (err) {
        failed += 1
        failedIds.add(product.id)
        console.error(`  ✗ FAILED ${product.id} "${product.title}": ${err.message}`)
      }
      await sleep(PACING_MS)
    }
  }

  const skipped = failedIds.size
  console.log(
    `${TAG} done — found ${totalFound}, deleted ${deleted}, ` +
      `skipped ${skipped}, failed ${failed}.`,
  )
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(`${TAG} FAILED:`, err?.message || err)
  process.exit(1)
})
