// extensions/processing-fee/src/Checkout.jsx  (ns-retail)
//
// Mirrors wholesale/extensions/checkout-ui/src/Checkout.jsx — keep both
// files in lockstep. If you change the math here, change it there too.
//
// Processing fee — N% of cart GRAND TOTAL (items + shipping + tax) —
// added at checkout as a real cart line item. Shopify Checkout UI
// extensions cannot increase the cart total directly; the only
// supported path is to add a line item via
// `applyCartLinesChange({type:'addCartLine', ...})` referencing a
// real ProductVariant.
//
// Base = totalAmount - existingFee (self-compensation so the fee
// doesn't compound on itself when the cart re-renders).
//
// VARIANT GID + FEE RATE are HARDCODED below.
//   • Edit the two constants and rebuild — no merchant setup needed.
//   • The extension reads neither settings nor the Storefront API.
//
// ── One-time setup (developer) ───────────────────────────────────────
//   1. Retail Shopify Admin → Products → Add product
//        Title: "Processing Fee"
//        Variant price: $0.01  (one cent — quantity = cents of fee)
//        Track inventory: OFF
//        Requires shipping: OFF      (digital — keeps it out of carrier
//                                      service payload + zero weight)
//        Charge tax on this product: OFF
//        Sales channels: unchecked (hide from storefront catalog)
//   2. Open the new variant → copy its GID from the URL
//        (e.g. gid://shopify/ProductVariant/45678901234567)
//   3. Paste it into FEE_VARIANT_GID below.
//   4. ALSO update PROCESSING_FEE_VARIANT_ID in
//        ns-retail/app/api/shipping/rates.js
//      (so the carrier-service callback excludes the fee from the
//       handling-markup tier + free-shipping calculations — same trick
//       as the wholesale store).
//   5. Rebuild + redeploy.
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
// Paste the retail-store Processing Fee variant GID here. Format:
//   gid://shopify/ProductVariant/<numeric_id>
// MUST be a variant priced at $0.01 (one cent) — the safety guard below
// aborts if the per-unit price doesn't match.
const FEE_VARIANT_GID = 'gid://shopify/ProductVariant/49734006374642'

// Percentage charged on cart GRAND TOTAL (items + shipping + tax).
// 3 = 3%.
const FEE_PERCENT = 3

export default async () => {
  render(<ProcessingFee />, document.body)
}

function ProcessingFee() {
  // eslint-disable-next-line no-console
  console.log('[processing-fee:retail] ⏱️  render · variantId=' + FEE_VARIANT_GID)

  useSignalEffect(() => {
    // Guard against the unedited placeholder so a forgotten paste
    // doesn't quietly add a phantom line.
    if (FEE_VARIANT_GID.endsWith('REPLACE_ME')) {
      // eslint-disable-next-line no-console
      console.log(
        '[processing-fee:retail] ⚠️  FEE_VARIANT_GID still placeholder — create the Processing Fee product in the retail Shopify store, paste its variant GID into Checkout.jsx, and rebuild',
      )
      return
    }

    // ── Gate on the buyer-journey + cart-mutation capability ────────
    const canAdd = shopify.instructions.value?.lines?.canAddCartLine
    if (!canAdd) {
      // eslint-disable-next-line no-console
      console.log(
        '[processing-fee:retail] ⏸️  skip — canAddCartLine=false (shipping address not entered yet)',
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
        `[processing-fee:retail] ❌ ABORT — variantId=${FEE_VARIANT_GID} matches a cart line priced at $${candidatePerUnit.toFixed(2)}/unit (expected $0.01). Wrong GID? Refusing to touch this line to avoid corrupting the customer's cart.`,
      )
      return
    }

    const existingFeeLine = candidateLooksLikeFee ? candidate : null
    const existingFeeDollars = existingFeeLine
      ? Number(existingFeeLine.cost?.totalAmount?.amount) || 0
      : 0

    // Subtract the fee we already added so the percentage doesn't
    // compound on itself when the cart re-renders.
    const realBase = totalAmount - existingFeeDollars

    // Variant price = $0.01 → quantity = cents-of-fee.
    const targetQty = Math.max(0, Math.round(realBase * feeRate * 100))

    // eslint-disable-next-line no-console
    console.log(
      `[processing-fee:retail] 💵 totalAmount=$${totalAmount.toFixed(2)} · realBase=$${realBase.toFixed(2)} · rate=${FEE_PERCENT}% · targetQty=${targetQty} (= $${(targetQty / 100).toFixed(2)}) · existingQty=${existingFeeLine?.quantity ?? 0}`,
    )

    if (targetQty <= 0) {
      if (existingFeeLine) {
        // eslint-disable-next-line no-console
        console.log('[processing-fee:retail] 🗑️  removing fee line')
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
          `[processing-fee:retail] 🔄 updating fee line ${existingFeeLine.quantity} → ${targetQty}`,
        )
        void shopify.applyCartLinesChange({
          type: 'updateCartLine',
          id: existingFeeLine.id,
          quantity: targetQty,
        })
      }
    } else {
      // eslint-disable-next-line no-console
      console.log(`[processing-fee:retail] ➕ adding fee line qty=${targetQty}`)
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
