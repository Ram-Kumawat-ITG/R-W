/* eslint-env node */
// One-off / re-runnable recovery sweep for practitioners whose Shopify
// customer creation failed during the bulk migration
// (`wholesale_applications.shopifyCreateFailed === true`).
//
// Re-running the full importer does NOT retry these — their Mongo docs
// already exist, so `WholesaleApplication.create` just skips them. This
// script re-attempts ONLY the Shopify side, using the same find-or-adopt /
// create logic the importer uses, now that the throttle + phone + empty-
// address bugs are fixed (see the 2026-07-27 changelog).
//
// For each failed doc it: resolves the practitioner's existing Shopify
// customer by email (adopt: update tags + note, preserve order history) or
// creates a new one for approved practitioners; then clears
// shopifyCreateFailed / shopifyCreateError and stores customerId.
//
// Usage (runs via vite-node so the app's ESM + extensionless imports resolve):
//   npm run retry:shopify-customers -- --dry-run          # preview, no writes
//   npm run retry:shopify-customers                       # apply
//   npm run retry:shopify-customers -- --limit=50         # cap the batch
//
// Rate limiting is handled two ways: executeGraphQL classifies THROTTLED as
// a TransientError, and every Shopify call is wrapped in retry() with long
// backoff; plus a small inter-row delay paces the sweep.

import { readFileSync } from 'fs'

// Load .env into process.env BEFORE importing anything that reads it at
// module-init (mongo.service throws if MONGODB_URI is unset). App modules are
// dynamically imported afterwards so this runs first.
try {
  const txt = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/)
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  }
} catch (e) {
  console.error('[retry-shopify] .env load failed:', e.message)
}

const dryRun = process.argv.includes('--dry-run')
const limitArg = process.argv.find((a) => a.startsWith('--limit='))
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0

const { default: connectDB } = await import('../app/services/APIService/mongo.service.js')
const { default: WholesaleApplication } = await import('../app/models/wholesaleApplication.server.js')
const {
  createCustomer,
  findCustomerByEmail,
  updateCustomerTagsAndNote,
  ShopifyUserError,
} = await import('../app/services/shopify/shopify.service.js')
const { getUnauthenticatedAdmin } = await import('../app/services/shopify/shopify.apis.server.js')
const { buildShopifyNote } = await import('../app/services/shopify/shopify.utils.js')
const { retry } = await import('../app/utils/retry.utils.js')

const RETRY_OPTS = { attempts: 8, baseMs: 1500, maxMs: 30000, factor: 2 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await connectDB()

  const query = { shopifyCreateFailed: true }
  const cursor = WholesaleApplication.find(query).sort({ _id: 1 })
  const docs = limit > 0 ? await cursor.limit(limit) : await cursor
  console.log(`[retry-shopify] ${docs.length} failed docs to process${dryRun ? ' (DRY RUN)' : ''}`)

  // Cache one admin client per shop.
  const adminByShop = new Map()
  async function adminFor(shop) {
    if (!shop) return null
    if (adminByShop.has(shop)) return adminByShop.get(shop)
    try {
      const { admin } = await getUnauthenticatedAdmin(shop)
      adminByShop.set(shop, admin)
      return admin
    } catch (e) {
      console.error(`[retry-shopify] no admin session for shop ${shop}: ${e.message}`)
      adminByShop.set(shop, null)
      return null
    }
  }

  let adopted = 0
  let created = 0
  let skipped = 0
  let stillFailed = 0
  const errorHistogram = new Map()

  for (const doc of docs) {
    const email = doc.email
    const status = doc.status
    try {
      if (status !== 'approved' && status !== 'blocked') {
        skipped++
        continue
      }
      const admin = await adminFor(doc.shop)
      if (!admin) throw new Error(`admin client unavailable for shop ${doc.shop}`)

      const payload = doc.toObject()
      const note = buildShopifyNote(payload)

      // Resolve existing Shopify customer first (adopt, preserve history).
      let customerId = null
      const found = await retry(() => findCustomerByEmail(admin, email), RETRY_OPTS)
      customerId = found?.id || null

      if (customerId) {
        const addTags = status === 'blocked' ? ['Blocked', 'practitioner'] : ['Approved', 'practitioner']
        const removeTags = status === 'blocked' ? ['Approved'] : ['Blocked']
        if (!dryRun) {
          await retry(() => updateCustomerTagsAndNote(admin, { customerId, addTags, removeTags, note }), RETRY_OPTS)
        }
        adopted++
      } else if (status === 'approved') {
        if (!dryRun) {
          customerId = await retry(
            () => createCustomer(admin, { application: payload, note, tags: ['Approved', 'practitioner'], subscribeNews: Boolean(payload.subscribeNews) }),
            RETRY_OPTS,
          )
        }
        created++
      } else {
        // blocked + no existing customer → nothing to block.
        skipped++
        continue
      }

      if (!dryRun) {
        doc.customerId = customerId
        doc.shopifyCreateFailed = false
        doc.shopifyCreateError = null
        await doc.save()
      }
      console.log(`  ✓ ${email} → ${customerId || '(dry-run)'} ${found ? '[adopted]' : '[created]'}`)
    } catch (err) {
      stillFailed++
      const msg = err instanceof ShopifyUserError ? err.userErrors.map((e) => e.message).join('; ') : err?.message || String(err)
      errorHistogram.set(msg, (errorHistogram.get(msg) || 0) + 1)
      if (!dryRun) {
        try {
          doc.shopifyCreateError = msg
          await doc.save()
        } catch { /* ignore */ }
      }
      console.error(`  ✗ ${email}: ${msg}`)
    }
    // Gentle pacing so we don't hammer the cost bucket even when calls succeed.
    await sleep(250)
  }

  console.log('\n[retry-shopify] DONE')
  console.log({ adopted, created, skipped, stillFailed, total: docs.length })
  if (errorHistogram.size) {
    console.log('\nRemaining error breakdown:')
    for (const [msg, count] of [...errorHistogram.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(5)}  ${msg}`)
    }
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('[retry-shopify] fatal:', err)
  process.exit(1)
})
