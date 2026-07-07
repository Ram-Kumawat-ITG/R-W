// extensions/processing-fee/src/Checkout.jsx  (ns-retail)
//
// Processing fee — 3% of cart GRAND TOTAL (items + shipping + tax) —
// added at checkout as ONE real cart line item.
//
// ── On-demand exact-price variant model ──────────────────────────────
//
// Instead of picking the "closest tier" from a fixed grid (which lost
// ±$0.025 per order), we resolve the EXACT cent-precise variant we
// need via a backend call — `FullPageApi.getFeeVariant(price)`.
//
// The backend:
//   1. Keeps an in-memory map of price → variant GID on the
//      "Processing Fee" product.
//   2. On cache hit → returns the GID immediately.
//   3. On miss → creates a new variant at that exact price via Admin
//      API and returns the new GID.
//   4. If the product hits Shopify's 2000-variant-per-product cap →
//      evicts the OLDEST variant (safe — past orders snapshot their
//      line-item data at purchase time, so deletion doesn't affect
//      them) and then creates the new one.
//
// Trade-off vs the old tier picker:
//   PRO: exact cent-precise fee — no rounding, ever.
//   PRO: single cart line, quantity always = 1.
//   CON: ~200–600 ms network round-trip on cache miss (~<50 ms on hit).
//   CON: burst of unique fee prices could churn the variant list; LRU
//        keeps it bounded but very-old orders' variant records will
//        eventually be recycled. Orders themselves are unaffected.
//
// ── Two compensation layers (unchanged) ──────────────────────────────
//
// (1) Self-compensation (fee-on-fee):
//     realCartTotal = totalAmount − feeLine.cost.totalAmount
//     Prevents the fee from compounding on itself.
//
// (2) Discount-on-fee compensation (target bump):
//     Detect the discount rate on the fee line and REQUEST a variant
//     at a HIGHER price so post-discount NET = 3% × realCartTotal.
//
// ── Shipping preservation ────────────────────────────────────────────
//
// Cart line ADD / REMOVE causes Shopify to reset the customer's
// delivery-option selection. `updateCartLine` (same line id, new
// merchandiseId) does NOT. So variant switching goes through
// updateCartLine — the customer's shipping method sticks.
//
// The FIRST add is unavoidable but happens right after address entry,
// BEFORE the buyer has picked a shipping method — no visible reset.

// ─────────────────────────────────────────────────────────────────────────
// ⚠️ DISABLED ON GROW PLAN — processing fee moved to carrier service
// ─────────────────────────────────────────────────────────────────────────
//
// Migrated 2026-07-06. Shopify custom-app UI extensions on the core
// checkout steps (information / shipping / payment) are Plus-only per
// Shopify's docs, so this extension NEVER rendered on the Grow-plan
// retail store — even though the bundle deployed successfully and
// network access was granted.
//
// Replacement: the 3% fee is now bundled into every shipping rate via
// the carrier-service callback at `app/api/shipping/rates.js`. Customer
// sees a single shipping line whose price includes the fee, with the
// fee amount + calculation basis disclosed in the rate description
// (e.g. "USPS Ground (incl. handling + 3% processing fee $29.27)").
//
// This file is INTENTIONALLY KEPT in the codebase:
//   • Zero cost on Grow (Shopify silently doesn't render it).
//   • If the store ever upgrades to Shopify Plus, un-disable by
//     restoring the ORIGINAL default export at the bottom of this file
//     (`render(<ProcessingFee />, document.body)`) — the full
//     <ProcessingFee /> component below is preserved intact.
//   • The `/api/cdo/fee-variant` backend endpoint stays live for
//     legacy variant cleanup / future re-enable; no orphaned code.
//
// DO NOT DELETE without confirming rates.js processing-fee logic is
// still active — they're the two halves of the same flow.
// ─────────────────────────────────────────────────────────────────────────

import '@shopify/ui-extensions/preact'
import { render } from 'preact'
import { signal, useSignalEffect } from '@preact/signals'
import FullPageApi from '../../services/FullPageApi.jsx'

// Percentage charged on cart GRAND TOTAL (items + shipping + tax).
const FEE_PERCENT = 3

// Minimum change in target price that triggers a re-fetch + swap.
// Prevents thrashing on sub-cent noise coming from tax rounding.
const SWAP_EPSILON = 0.005

// A locally-remembered set of every fee-variant GID we've seen this
// session. Used to identify "our" cart lines regardless of what price
// each holds (since prices are dynamic per order now).
/** @type {Set<string>} */
const knownFeeGids = new Set()

// Cache: priceStr → gid, so identical fee amounts within the same
// session don't hit the backend a second time.
/** @type {Map<string, string>} */
const localVariantCache = new Map()

// Track the exact price we last provisioned (or are currently
// provisioning) so the effect loop doesn't spam identical requests
// while a fetch is in flight.
/** @type {import('@preact/signals').Signal<string | null>} */
const activeTargetPriceStr = signal(null)

// Serialization mutex for cart mutations.
let isMutating = false

/** @param {number} n */
function formatPrice(n) {
  return (Math.round(n * 100) / 100).toFixed(2)
}

// ── Active default export (no-op on Grow) ─────────────────────────────
// Renders nothing. On Plus stores, replace this with the original body:
//   export default async () => { render(<ProcessingFee />, document.body); }
export default async () => {
  // No-op on Grow. See disable banner above. Fee lives in rates.js now.
}

// ── Original implementation (preserved — DO NOT REMOVE) ───────────────
// The full <ProcessingFee /> component below is the code that ran on the
// checkout UI when the store was on Shopify Plus (or a dev store with
// Plus features). Kept as live code (not commented out) so the linter /
// type-checker still validate it and it stays in build-shape — but
// nothing calls it at runtime because the default export above is a
// no-op. To re-activate on a future Plus upgrade, change the default
// export back to `render(<ProcessingFee />, document.body)` — no other
// edits should be needed. Also revert the fee calculation in
// `app/api/shipping/rates.js` (undo the 2026-07-06 migration) so the
// fee isn't double-charged (once in shipping + once as a cart line).

function ProcessingFee() {
  useSignalEffect(() => {
    const canAdd = shopify.instructions.value?.lines?.canAddCartLine
    const totalAmount = Number(shopify.cost.totalAmount.value?.amount) || 0
    const lines = shopify.lines.value || []

    if (isMutating) {
      // eslint-disable-next-line no-console
      console.log(
        '[processing-fee:retail] ⏸️  skip — mutation cycle already in flight',
      )
      return
    }

    if (!canAdd) {
      // eslint-disable-next-line no-console
      console.log(
        '[processing-fee:retail] ⏸️  skip — canAddCartLine=false',
      )
      return
    }

    if (totalAmount === 0) return

    const feeRate = FEE_PERCENT / 100
    // "Our" lines: any line whose variant GID matches one we've
    // provisioned (seen) this session. Also fall back to any variant
    // whose price is in our local cache — covers the case where the
    // customer previously started a checkout and refreshed.
    const feeLines = lines.filter((l) => {
      const id = l?.merchandise?.id
      return id && knownFeeGids.has(id)
    })
    const existingFeeLine = feeLines[0] || null

    // Layer 1 — self-compensation
    const totalExistingFeeDollars = feeLines.reduce((sum, line) => {
      return sum + (Number(line.cost?.totalAmount?.amount) || 0)
    }, 0)
    const realCartTotal = totalAmount - totalExistingFeeDollars

    // Layer 2 — discount-on-fee detection
    //
    // Reconstruct the pre-discount list price by reversing our local
    // priceStr → gid cache: whichever entry's gid matches the fee
    // line's variant IS that entry's price. (Checkout UI surface
    // doesn't expose `merchandise.price`.)
    let discountRateOnFee = 0
    let currentListPrice = 0
    if (existingFeeLine) {
      const qty = Number(existingFeeLine.quantity) || 1
      const primaryPostDiscount =
        Number(existingFeeLine.cost?.totalAmount?.amount) || 0
      const feeGid = existingFeeLine.merchandise.id
      for (const [pStr, gid] of localVariantCache) {
        if (gid === feeGid) {
          currentListPrice = Number(pStr)
          break
        }
      }
      const preDiscountSubtotal = currentListPrice * qty
      if (preDiscountSubtotal > 0) {
        discountRateOnFee =
          (preDiscountSubtotal - primaryPostDiscount) / preDiscountSubtotal
      }
    }
    const capped = Math.min(Math.max(discountRateOnFee, 0), 0.95)

    const desiredNet = realCartTotal * feeRate
    const inflated = desiredNet / (1 - capped)
    const targetPriceStr = formatPrice(inflated)

    // If desiredNet is zero or negative, strip all fee lines and bail.
    if (desiredNet <= 0) {
      if (feeLines.length === 0) return
      const mutations = feeLines.map((line) => ({
        type: 'removeCartLine',
        id: line.id,
        quantity: line.quantity,
      }))
      runMutations(mutations, 'strip-fees')
      return
    }

    // If we're already provisioning THIS exact target price, wait.
    if (activeTargetPriceStr.value === targetPriceStr && !existingFeeLine) {
      // eslint-disable-next-line no-console
      console.log(
        `[processing-fee:retail] ⏸️  provisioning $${targetPriceStr} — awaiting result`,
      )
      return
    }

    // If the existing fee line's VARIANT GID already matches the GID
    // we'd pick for this target price, no swap needed. We look up the
    // target GID from the local price→gid cache (populated by prior
    // backend fetches). GID comparison is the authoritative check —
    // Checkout UI surface doesn't expose `merchandise.price`, so we
    // can't compare prices directly.
    if (existingFeeLine) {
      const expectedGid = localVariantCache.get(targetPriceStr)
      if (expectedGid && existingFeeLine.merchandise.id === expectedGid) {
        // Already at the right variant. Skip.
        return
      }
      // Fallback price check (only useful right after a discount
      // change) — if the LIST price we reconstructed above is within
      // epsilon of the inflated target, treat as no-swap.
      if (
        currentListPrice > 0 &&
        Math.abs(currentListPrice - inflated) < SWAP_EPSILON
      ) {
        return
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[processing-fee:retail] 💵 totalAmount=$${totalAmount.toFixed(2)} · realCart=$${realCartTotal.toFixed(2)} · discountOnFee=${(capped * 100).toFixed(2)}% · desiredNet=$${desiredNet.toFixed(2)} · target=$${targetPriceStr}`,
    )

    activeTargetPriceStr.value = targetPriceStr

    // Resolve the variant GID for this exact price — cache-first, then
    // backend fetch on miss.
    const cachedGid = localVariantCache.get(targetPriceStr)
    if (cachedGid) {
      knownFeeGids.add(cachedGid)
      applyTarget(targetPriceStr, cachedGid, feeLines)
      return
    }

    // Fire the async provisioning request. When it resolves the
    // signal update we do inside will re-trigger this effect and hit
    // the cache path above.
    const api = new FullPageApi()
    api
      .getFeeVariant(Number(targetPriceStr))
      .then((result) => {
        const gid = /** @type {any} */ (result)?.gid
        const priceStr = formatPrice(
          Number(/** @type {any} */ (result)?.price ?? targetPriceStr),
        )
        if (!gid) {
          // eslint-disable-next-line no-console
          console.error(
            '[processing-fee:retail] ❌ backend returned no gid for target=$' +
              targetPriceStr,
          )
          activeTargetPriceStr.value = null
          return
        }
        localVariantCache.set(priceStr, gid)
        knownFeeGids.add(gid)
        applyTarget(priceStr, gid, feeLines)
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error(
          `[processing-fee:retail] ❌ getFeeVariant($${targetPriceStr}) failed:`,
          err?.message || err,
        )
        activeTargetPriceStr.value = null
      })
  })

  return null
}

/**
 * @param {string} targetPriceStr
 * @param {string} targetGid
 * @param {any[]} feeLines
 */
function applyTarget(targetPriceStr, targetGid, feeLines) {
  /** @type {any[]} */
  const mutations = []

  if (feeLines.length === 0) {
    // No fee line yet → initial add.
    mutations.push({
      type: 'addCartLine',
      merchandiseId: targetGid,
      quantity: 1,
    })
  } else {
    // Fee line exists. Update FIRST in place; remove any extras.
    const [survivor, ...extras] = feeLines
    for (const line of extras) {
      mutations.push({
        type: 'removeCartLine',
        id: line.id,
        quantity: line.quantity,
      })
    }

    const needsVariantSwap = survivor.merchandise.id !== targetGid
    const needsQtyReset = survivor.quantity !== 1
    if (needsVariantSwap || needsQtyReset) {
      /** @type {any} */
      const updateChange = {
        type: 'updateCartLine',
        id: survivor.id,
        quantity: 1,
      }
      if (needsVariantSwap) updateChange.merchandiseId = targetGid
      mutations.push(updateChange)
    }
  }

  if (mutations.length === 0) {
    // No mutations needed but do NOT write to activeTargetPriceStr —
    // that would retrigger the effect. Just leave state as-is; the
    // early-return GID check will short-circuit the next tick.
    return
  }

  runMutations(mutations, `apply target $${targetPriceStr}`)
}

/**
 * @param {any[]} mutations
 * @param {string} label
 */
function runMutations(mutations, label) {
  if (isMutating) return
  isMutating = true
  ;(async () => {
    try {
      for (const m of mutations) {
        // eslint-disable-next-line no-console
        console.log(
          `[processing-fee:retail] → ${m.type}${'merchandiseId' in m ? ' ' + m.merchandiseId : ' id=' + m.id} qty=${m.quantity}`,
        )
        await shopify.applyCartLinesChange(m)
      }
      // eslint-disable-next-line no-console
      console.log(
        `[processing-fee:retail] ✅ ${label} — ${mutations.length} step${mutations.length === 1 ? '' : 's'}`,
      )
    } catch (/** @type {any} */ err) {
      // eslint-disable-next-line no-console
      console.error(
        `[processing-fee:retail] ❌ ${label} failed:`,
        err?.message || err,
      )
    } finally {
      isMutating = false
      activeTargetPriceStr.value = null
    }
  })()
}
