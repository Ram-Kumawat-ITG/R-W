// scripts/create-fee-variants.js  (wholesale)
//
// Bulk-creates 1000 Processing Fee variants at $0.10 increments from $0.10
// to $100.00 — used by extensions/checkout-ui/src/Checkout.jsx's tier-picker
// logic (quantity always = 1, price varies by which variant is picked).
//
// ── Prerequisites (one-time, manual in Shopify Admin) ──────────────────
//   1. Create a product titled exactly "Processing Fee"
//      (leave option name empty for now — the mutation will populate it)
//   2. Configure the product:
//        Track inventory: OFF
//        Requires shipping: OFF   (digital — keeps out of carrier callback)
//        Charge tax on this product: OFF
//        Sales channels: UNCHECK ALL (hide from storefront catalog)
//   3. Copy the product's GID (Admin URL → look at product ID)
//        Format: gid://shopify/Product/<numeric_id>
//
// ── Usage ──────────────────────────────────────────────────────────────
//   SHOPIFY_SHOP=ns-wholesale-stagging-1.myshopify.com \
//   SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_xxx \
//   node scripts/create-fee-variants.js gid://shopify/Product/<id>
//
// The Admin access token needs `write_products` scope. In dev you can grab
// it from the `shopify.app.toml` custom-app credentials or an app-install
// session token stored in Mongo (services/APIService/mongo.service.js).
//
// ── Output ─────────────────────────────────────────────────────────────
//   • Creates variants in batches of 100 (Shopify mutation limit)
//   • Rate-limit friendly (500ms pause between batches → 5s total)
//   • Writes fee-tiers.json with [{ price, gid }, ...] sorted ascending
//   • Prints the array to stdout for direct paste into Checkout.jsx
//
// ── Idempotency ────────────────────────────────────────────────────────
//   Re-running is safe: Shopify rejects duplicate option-value combinations
//   with a userError but doesn't crash the script. Existing variants stay
//   as-is; only missing ones get created. Read existing variants once at
//   start to build the "already exists" set.
//
// ── Range coverage ─────────────────────────────────────────────────────
//   $0.10 → $100.00 in $0.10 steps = 1000 variants.
//   Covers 3% fee on cart totals up to ~$3,333.
//   For wholesale orders > $3,333, increase the range OR use combination
//   line items in Checkout.jsx.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SHOP = process.env.SHOPIFY_SHOP
const TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
const PRODUCT_ID = process.argv[2]

if (!SHOP || !TOKEN || !PRODUCT_ID) {
  console.error(
    'Usage:\n  SHOPIFY_SHOP=<shop>.myshopify.com \\\n  SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_xxx \\\n  node scripts/create-fee-variants.js gid://shopify/Product/<id>',
  )
  process.exit(1)
}

const API_VERSION = '2026-01'
const ENDPOINT = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`
const OPTION_NAME = 'Amount'
const BATCH_SIZE = 100
const BATCH_PAUSE_MS = 500

async function gql(query, variables) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  })
  const data = await res.json()
  if (data.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(data.errors, null, 2)}`)
  }
  return data.data
}

// Read the existing variants on the product so we don't attempt to
// duplicate any prices that were already created (idempotent re-run).
async function fetchProductMeta(productId) {
  const query = `
    query fetchProduct($id: ID!) {
      product(id: $id) {
        id
        title
        options { id name position values }
      }
    }
  `
  const data = await gql(query, { id: productId })
  if (!data.product) {
    throw new Error(`Product ${productId} not found. Verify the GID.`)
  }
  return data.product
}

// Idempotent option-creation. If the product doesn't already have an
// option named `OPTION_NAME`, add it. Shopify requires at least one
// value on option creation, so we seed it with a "$0.00" placeholder
// (never referenced by any real variant — safe throwaway).
async function ensureOption(productId, product) {
  const hasOption = (product.options || []).some((o) => o.name === OPTION_NAME)
  if (hasOption) {
    console.log(`[create-fee-variants] option "${OPTION_NAME}" already exists`)
    return
  }
  console.log(
    `[create-fee-variants] option "${OPTION_NAME}" missing — creating…`,
  )
  const mutation = `
    mutation createOption($productId: ID!, $options: [OptionCreateInput!]!) {
      productOptionsCreate(productId: $productId, options: $options) {
        product { id options { id name values } }
        userErrors { field message code }
      }
    }
  `
  const data = await gql(mutation, {
    productId,
    options: [
      {
        name: OPTION_NAME,
        values: [{ name: '$0.00' }],
      },
    ],
  })
  const errs = data.productOptionsCreate.userErrors || []
  if (errs.length > 0) {
    throw new Error(
      `productOptionsCreate failed: ${JSON.stringify(errs, null, 2)}`,
    )
  }
  console.log(`[create-fee-variants] ✅ option "${OPTION_NAME}" created`)
}

async function fetchExistingVariants(productId) {
  const query = `
    query fetchVariants($id: ID!, $cursor: String) {
      product(id: $id) {
        id
        title
        variants(first: 250, after: $cursor) {
          edges {
            cursor
            node { id price selectedOptions { name value } }
          }
          pageInfo { hasNextPage }
        }
      }
    }
  `
  const all = []
  let cursor = null
  for (;;) {
    const data = await gql(query, { id: productId, cursor })
    if (!data.product) {
      throw new Error(`Product ${productId} not found. Verify the GID.`)
    }
    const edges = data.product.variants.edges
    for (const e of edges) {
      all.push({ id: e.node.id, price: parseFloat(e.node.price) })
    }
    if (!data.product.variants.pageInfo.hasNextPage) break
    cursor = edges[edges.length - 1].cursor
  }
  return all
}

const CREATE_MUTATION = `
  mutation createBatch($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(
      productId: $productId
      variants: $variants
      strategy: REMOVE_STANDALONE_VARIANT
    ) {
      productVariants {
        id
        price
        selectedOptions { name value }
      }
      userErrors { field message code }
    }
  }
`

async function main() {
  console.log(`\n[create-fee-variants] shop=${SHOP} product=${PRODUCT_ID}`)

  // 1. Ensure the "Amount" option exists on the product (create if missing).
  console.log('[create-fee-variants] fetching product meta…')
  const product = await fetchProductMeta(PRODUCT_ID)
  console.log(
    `[create-fee-variants] product "${product.title}" · options=[${(product.options || []).map((o) => o.name).join(', ') || 'none'}]`,
  )
  await ensureOption(PRODUCT_ID, product)

  // 2. Fetch existing variants so we skip duplicates
  console.log('[create-fee-variants] fetching existing variants…')
  const existing = await fetchExistingVariants(PRODUCT_ID)
  const existingPrices = new Set(existing.map((v) => v.price.toFixed(2)))
  console.log(`[create-fee-variants] ${existing.length} variants already on product`)

  // 2. Generate the target price list: $0.10 → $100.00 in $0.10 steps
  const allPrices = []
  for (let cents = 10; cents <= 10000; cents += 10) {
    allPrices.push((cents / 100).toFixed(2))
  }

  // 3. Filter to those NOT yet created
  const toCreate = allPrices.filter((p) => !existingPrices.has(p))
  console.log(
    `[create-fee-variants] ${toCreate.length} new variants to create (${allPrices.length - toCreate.length} already exist)`,
  )

  if (toCreate.length === 0) {
    console.log('[create-fee-variants] nothing to create — assembling output from existing variants.')
  }

  // 4. Batch create
  const created = []
  for (let i = 0; i < toCreate.length; i += BATCH_SIZE) {
    const batch = toCreate.slice(i, i + BATCH_SIZE)
    const variants = batch.map((p) => ({
      optionValues: [{ optionName: OPTION_NAME, name: `$${p}` }],
      price: p,
      inventoryPolicy: 'CONTINUE',
      inventoryItem: { tracked: false, requiresShipping: false },
      taxable: false,
    }))

    const batchNum = Math.floor(i / BATCH_SIZE) + 1
    const totalBatches = Math.ceil(toCreate.length / BATCH_SIZE)
    console.log(
      `[create-fee-variants] batch ${batchNum}/${totalBatches} — creating ${batch.length} variants ($${batch[0]} → $${batch[batch.length - 1]})`,
    )

    const data = await gql(CREATE_MUTATION, { productId: PRODUCT_ID, variants })
    const payload = data.productVariantsBulkCreate

    if (payload.userErrors && payload.userErrors.length > 0) {
      console.warn(
        `[create-fee-variants] batch ${batchNum} userErrors:`,
        JSON.stringify(payload.userErrors, null, 2),
      )
    }
    for (const v of payload.productVariants || []) {
      created.push({ price: parseFloat(v.price), gid: v.id })
    }

    if (i + BATCH_SIZE < toCreate.length) {
      await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS))
    }
  }

  // 5. Re-fetch ALL variants (existing + newly created) so the output
  //    is authoritative even on re-runs.
  console.log('\n[create-fee-variants] re-fetching authoritative variant list…')
  const final = await fetchExistingVariants(PRODUCT_ID)
  const tiers = final
    .filter((v) => allPrices.includes(v.price.toFixed(2)))
    .map((v) => ({ price: v.price, gid: v.id }))
    .sort((a, b) => a.price - b.price)

  // 6. Write JSON output
  const outputPath = path.resolve(__dirname, '..', 'fee-tiers.json')
  fs.writeFileSync(outputPath, JSON.stringify(tiers, null, 2))

  console.log(
    `\n✅ ${tiers.length} tier variants ready (${created.length} newly created this run)`,
  )
  console.log(`   Output: ${outputPath}`)
  console.log(
    `\nNext: paste the FEE_TIERS array below into extensions/checkout-ui/src/Checkout.jsx, then run \`shopify app deploy\`.\n`,
  )
  console.log('const FEE_TIERS = ' + JSON.stringify(tiers, null, 2))
}

main().catch((err) => {
  console.error('[create-fee-variants] failed:', err?.message || err)
  process.exit(1)
})
