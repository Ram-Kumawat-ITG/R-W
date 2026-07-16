/* eslint-env node */
// One-off catalog reset: deletes EVERY product from the WHOLESALE Shopify
// store, ahead of a fresh product-catalog import.
//
// Deleting a product via productDelete removes the product together with all
// of its variants, media/images, and options — Shopify cascades those; no
// separate cleanup calls are needed.
//
// Safety rails:
//   - Targets ONLY the wholesale store: shop resolves from SHOPIFY_SHOP (or
//     the wholesale staging default — same resolution as api/cdo/fee-variant.js)
//     and the script hard-refuses to run against RETAIL_SHOP_DOMAIN or any
//     domain that doesn't contain "wholesale".
//   - A live run requires the explicit --confirm flag; --dry-run lists what
//     would be deleted and changes nothing.
//   - Standalone: uses the app's stored offline session read-only (via
//     unauthenticated.admin) — it never touches the DB collections, QBO, NMI,
//     the scheduler, or any app functionality.
//
// Rate limits: each response's throttle status is inspected; a THROTTLED
// error waits exactly long enough for the cost bucket to refill (fallback:
// exponential backoff), and transient network/5xx errors retry up to 5 times.
//
// Usage:
//   npm run delete:wholesale-products -- --dry-run    # count + list, no changes
//   npm run delete:wholesale-products -- --confirm    # actually delete everything

import {
  getUnauthenticatedAdmin,
  executeGraphQL,
} from '../app/services/shopify/shopify.apis.server'

const TAG = '[delete:wholesale-products]'

const SHOP = (process.env.SHOPIFY_SHOP || 'ns-wholesale-stagging-1.myshopify.com')
  .trim()
  .toLowerCase()
const RETAIL_SHOP = (process.env.RETAIL_SHOP_DOMAIN || '').trim().toLowerCase()

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

// Execute one GraphQL call with retries for throttling (waits for the cost
// bucket) and transient network/5xx errors (exponential backoff). Top-level
// GraphQL errors other than THROTTLED are thrown to the caller.
async function callWithRetry(admin, operation, variables) {
  for (let attempt = 0; ; attempt++) {
    let json
    try {
      json = await executeGraphQL(admin, operation, variables)
    } catch (err) {
      if (attempt + 1 >= MAX_CALL_ATTEMPTS) throw err
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

async function fetchProductsPage(admin, after = null) {
  const json = await callWithRetry(admin, QUERY_PRODUCTS_PAGE, {
    first: PAGE_SIZE,
    after,
  })
  return json?.data?.products || { pageInfo: { hasNextPage: false }, nodes: [] }
}

async function main() {
  // ---- Safety guards: this script may only ever touch the wholesale store.
  if (!SHOP) {
    console.error(`${TAG} ABORT — no shop domain resolved.`)
    process.exit(1)
  }
  if (RETAIL_SHOP && SHOP === RETAIL_SHOP) {
    console.error(
      `${TAG} ABORT — resolved shop "${SHOP}" is the RETAIL store (RETAIL_SHOP_DOMAIN). ` +
        `This script only ever targets the wholesale store.`,
    )
    process.exit(1)
  }
  if (!SHOP.includes('wholesale')) {
    console.error(
      `${TAG} ABORT — resolved shop "${SHOP}" does not look like the wholesale store ` +
        `(domain must contain "wholesale"). Set SHOPIFY_SHOP to the wholesale domain.`,
    )
    process.exit(1)
  }
  if (!dryRun && !confirmed) {
    console.error(
      `${TAG} Refusing to run without an explicit flag.\n` +
        `  Preview:  npm run delete:wholesale-products -- --dry-run\n` +
        `  Execute:  npm run delete:wholesale-products -- --confirm`,
    )
    process.exit(1)
  }

  console.log(`${TAG} target store: ${SHOP} ${dryRun ? '(DRY RUN — no changes)' : '(LIVE DELETE)'}`)

  const { admin } = await getUnauthenticatedAdmin(SHOP)

  const countJson = await callWithRetry(admin, QUERY_PRODUCTS_COUNT)
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
      const page = await fetchProductsPage(admin, after)
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
    const page = await fetchProductsPage(admin)
    const candidates = page.nodes.filter((p) => !failedIds.has(p.id))

    if (page.nodes.length === 0) break // store is empty
    if (candidates.length === 0) {
      // Only permanently-failed products remain — stop instead of looping forever.
      console.warn(`${TAG} only failed products remain (${failedIds.size}) — stopping.`)
      break
    }

    for (const product of candidates) {
      try {
        const json = await callWithRetry(admin, MUTATION_PRODUCT_DELETE, {
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
