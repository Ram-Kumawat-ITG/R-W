// extensions/checkout-ui/src/Checkout.jsx
//
// Processing fee — N% of cart GRAND TOTAL (items + shipping + tax) —
// added at checkout as a real cart line item. Shopify Checkout UI
// extensions cannot increase the cart total directly; the only
// supported path is to add a line item via
// `applyCartLinesChange({type:'addCartLine', ...})` referencing a
// real ProductVariant.
//
// ── Two compensation layers ──────────────────────────────────────────
//
//  1. Self-compensation (fee-on-fee):
//     realCartTotal = totalAmount − feeTotal
//     Prevents the fee from compounding on itself when the cart
//     re-evaluates (the fee line's totalAmount is already inside
//     `cost.totalAmount`).
//
//  2. Discount-on-fee compensation (qty inflation):
//     Shopify applies cart-wide / order-wide discounts to EVERY cart
//     line including ours. There is no native "non-discountable" line
//     flag and Discount Functions cannot intercept native code /
//     automatic discounts. So we INFLATE the fee quantity so that
//     AFTER Shopify applies the discount to our fee line, the customer's
//     NET fee equals exactly N% of `realCartTotal`.
//
//        discountRateOnFee = (feeSubtotal − feeTotal) / feeSubtotal
//        desiredFeeNet     = realCartTotal × N%
//        targetQty         = desiredFeeNet ÷ (1 − discountRateOnFee) × 100
//
//     Converges in 2 iterations: round 1 adds the base qty, round 2 sees
//     the actual discount allocation and rewrites qty up.
//
// VARIANT GID + FEE RATE are HARDCODED below.
//   • Edit the two constants and rebuild — no merchant setup needed.
//   • The extension reads neither settings nor the Storefront API.
//
// ── One-time setup (developer) ───────────────────────────────────────
//   1. Shopify Admin → Products → Add product
//        Title: "Processing Fee"
//        Variant price: $0.01  (one cent — quantity = cents of fee)
//        Track inventory: OFF
//        Charge tax on this product: OFF
//        Sales channels: unchecked (hide from storefront catalog)
//   2. Open the new variant → copy its GID from the URL
//        (e.g. gid://shopify/ProductVariant/45678901234567)
//   3. Paste it into FEE_VARIANT_GID below.
//   4. Rebuild + redeploy.
//
// ── Lifecycle / when the fee appears ─────────────────────────────────
// Cart-line mutations require `instructions.value.lines.canAddCartLine`
// — which Shopify only sets to true AFTER the buyer has entered a
// shipping address. So the fee appears at the shipping step (after
// address, before payment), exactly when "the totals update" — matching
// the operator's intent that the customer sees the true charge before
// picking a payment method.

import '@shopify/ui-extensions/preact'
import { render } from 'preact'
import { useSignalEffect } from '@preact/signals'

// ── HARDCODED — edit these two constants ────────────────────────────
// Paste the Processing Fee variant GID here. Format:
//   gid://shopify/ProductVariant/<numeric_id>
const FEE_VARIANT_GID = 'gid://shopify/ProductVariant/45231995191365'

// Percentage charged on cart GRAND TOTAL (items + shipping + tax).
// 3 = 3%.
const FEE_PERCENT = 3

export default async () => {
  render(<ProcessingFee />, document.body)
}

function ProcessingFee() {
  // eslint-disable-next-line no-console
  console.log('[processing-fee] ⏱️  render · variantId=' + FEE_VARIANT_GID   )

  useSignalEffect(() => {
    // Guard against the unedited placeholder so a forgotten paste
    // doesn't quietly add a phantom line.
    if (FEE_VARIANT_GID.endsWith('REPLACE_ME')) {
      // eslint-disable-next-line no-console
      console.log(
        '[processing-fee] ⚠️  FEE_VARIANT_GID still placeholder — paste the real variant GID into Checkout.jsx and rebuild',
      )
      return
    }

    // ── Gate on the buyer-journey + cart-mutation capability ────────
    const canAdd = shopify.instructions.value?.lines?.canAddCartLine
    if (!canAdd) {
      // eslint-disable-next-line no-console
      console.log(
        '[processing-fee] ⏸️  skip — canAddCartLine=false (shipping address not entered yet)',
      )
      return
    }

    // Use GRAND TOTAL (items + shipping + tax). Note: totalAmount
    // ALREADY includes our existing fee line, so we subtract it below
    // in `realBase` to prevent the fee from compounding on itself.
    const totalAmount = Number(shopify.cost.totalAmount.value?.amount) || 0
    if (totalAmount === 0) return

    const feeRate = FEE_PERCENT / 100
    const lines = shopify.lines.value || []

    // SAFETY — the fee variant MUST be priced at $0.01 (one cent), so a
    // single unit's totalAmount on the line equals 1 ¢. If a misconfigured
    // GID points at a real product (e.g. one priced at $50), the
    // "existingFeeLine" branch below would treat the customer's actual
    // product as a fee line and mangle the cart. Refuse to touch a line
    // whose per-unit price isn't $0.01 — log loudly so the operator notices.
    //
    // Detection rule: a true fee line has totalAmount == quantity * 0.01.
    // Allow a small floating-point slop (< $0.011 per unit).
    const candidate = lines.find(
      (l) => l?.merchandise?.id === FEE_VARIANT_GID,
    )
    const candidateTotal = candidate
      ? Number(candidate.cost?.totalAmount?.amount) || 0
      : 0
    const candidateQty = Number(candidate?.quantity) || 0
    const candidatePerUnit = candidateQty > 0 ? candidateTotal / candidateQty : 0
    const candidateLooksLikeFee =
      !candidate || (candidatePerUnit > 0 && candidatePerUnit <= 0.011)

    if (candidate && !candidateLooksLikeFee) {
      // eslint-disable-next-line no-console
      console.error(
        `[processing-fee] ❌ ABORT — variantId=${FEE_VARIANT_GID} matches a cart line priced at $${candidatePerUnit.toFixed(2)}/unit (expected $0.01). Wrong GID? Refusing to touch this line to avoid corrupting the customer's cart.`,
      )
      return
    }

    const existingFeeLine = candidateLooksLikeFee ? candidate : null
    // POST-discount fee line total (= what the cart summary displays).
    const existingFeeDollars = existingFeeLine
      ? Number(existingFeeLine.cost?.totalAmount?.amount) || 0
      : 0
    // PRE-discount fee line total. The Checkout UI cart-line cost API
    // does NOT expose `subtotalAmount` directly, but we KNOW the variant
    // is priced at exactly $0.01/unit (the safety guard above refuses
    // to touch any line whose per-unit price differs), so the pre-
    // discount subtotal is just qty × $0.01. This equals
    // `existingFeeDollars` when no discount touches our line, and is
    // larger than it when Shopify pulls a discount out of the fee.
    const existingFeeQty = existingFeeLine
      ? Number(existingFeeLine.quantity) || 0
      : 0
    const existingFeeSubtotalDollars = existingFeeQty * 0.01

    // Layer 1 — self-compensation: strip our existing fee out of the
    // grand total so the percentage doesn't compound on itself.
    const realCartTotal = totalAmount - existingFeeDollars

    // Layer 2 — discount-on-fee detection: what fraction of the fee
    // subtotal is being absorbed by an active cart discount? 0 means
    // no discount, 0.10 means 10% off, etc. Pro-rata fixed-amount
    // discounts ($5 off cart) show up here as a non-zero rate as well.
    // Cap at 95% to avoid divide-by-near-zero blowups.
    const discountRateOnFeeRaw =
      existingFeeSubtotalDollars > 0
        ? (existingFeeSubtotalDollars - existingFeeDollars) / existingFeeSubtotalDollars
        : 0
    const discountRateOnFee = Math.min(Math.max(discountRateOnFeeRaw, 0), 0.95)

    // Desired NET fee — what the customer actually pays in fee after
    // discounts. N% of the real cart (excludes our fee, includes
    // shipping + tax, already post-discount on the real items).
    const desiredFeeNet = realCartTotal * feeRate

    // Inflate qty so that AFTER Shopify applies its discount to our
    // fee line, the net amount equals `desiredFeeNet`. Variant priced
    // at $0.01 → quantity is cents-of-pre-discount-fee.
    const inflationFactor = 1 / (1 - discountRateOnFee)
    const targetQty = Math.max(
      0,
      Math.round(desiredFeeNet * inflationFactor * 100),
    )

    // eslint-disable-next-line no-console
    console.log(
      `[processing-fee] 💵 totalAmount=$${totalAmount.toFixed(2)} · realCartTotal=$${realCartTotal.toFixed(2)} · discountOnFee=${(discountRateOnFee * 100).toFixed(2)}% · desiredNet=$${desiredFeeNet.toFixed(2)} · inflated=$${(desiredFeeNet * inflationFactor).toFixed(2)} · targetQty=${targetQty} · existingQty=${existingFeeLine?.quantity ?? 0}`,
    )

    if (targetQty <= 0) {
      if (existingFeeLine) {
        // eslint-disable-next-line no-console
        console.log('[processing-fee] 🗑️  removing fee line')
        void shopify.applyCartLinesChange({
          type: 'removeCartLine',
          id: existingFeeLine.id,
          quantity: existingFeeLine.quantity,
        })
      }
      return
    }

    if (existingFeeLine) {
      if (existingFeeLine.quantity !== targetQty) {
        // eslint-disable-next-line no-console
        console.log(
          `[processing-fee] 🔄 updating fee line ${existingFeeLine.quantity} → ${targetQty}`,
        )
        void shopify.applyCartLinesChange({
          type: 'updateCartLine',
          id: existingFeeLine.id,
          quantity: targetQty,
        })
      }
    } else {
      // eslint-disable-next-line no-console
      console.log(`[processing-fee] ➕ adding fee line qty=${targetQty}`)
      void shopify.applyCartLinesChange({
        type: 'addCartLine',
        merchandiseId: FEE_VARIANT_GID,
        quantity: targetQty,
      })
    }
  })

  // Headless behaviour — no visible UI.
  return null
}
