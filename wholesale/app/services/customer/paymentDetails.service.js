// Payment-details resolver — a strategy registry that picks the right
// payment method to attach to a brand-new NMI customer vault.
//
// Strategies are tried in registration order; the first one that returns
// non-null wins. Adding a new source (wholesale_applications lookup,
// Collect.js token from registration, manual cheque) is a single
// `registerPaymentDetailsStrategy(name, fn)` call.

import { nmiConfig } from '../nmi/nmi.config'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('customer.payment_resolver')

// A PaymentDetails value is the shape consumed by NMI's createCustomerVault:
//   { paymentToken }           — Collect.js hosted token
//   { cardNumber, cardExpiry } — raw card
//   { achRouting, achAccount } — ACH
const strategies = []

export function registerPaymentDetailsStrategy(name, fn) {
  strategies.push({ name, fn })
}

export async function resolvePaymentDetails({ shop, email, shopifyCustomerId }) {
  for (const { name, fn } of strategies) {
    try {
      const result = await fn({ shop, email, shopifyCustomerId })
      if (result) {
        console.log(`[customers] payment details resolved via "${name}" strategy`)
        log.info('resolved', { strategy: name, email })
        return { ...result, _source: name }
      }
    } catch (err) {
      // A strategy failure shouldn't break the resolver — log and try
      // the next one.
      console.error(`[customers] strategy "${name}" threw, continuing:`, err.message)
      log.warn('strategy.failed', { strategy: name, email, err })
    }
  }
  console.log(`[customers] payment details resolved → none available`)
  log.info('resolved.none', { email })
  return null
}

// ── Built-in strategies ──────────────────────────────────────────────

// 1. Static test card from env. Sandbox only — config layer scrubs the
//    values in non-sandbox env via assertSafeTestCardConfig().
registerPaymentDetailsStrategy('static-test-card', async () => {
  const { ccnumber, ccexp, cvv } = nmiConfig.testCard
  if (!ccnumber || !ccexp) return null
  return {
    cardNumber: ccnumber,
    cardExpiry: ccexp,
    cardCvv: cvv || undefined,
  }
})

// 2. Future: wholesale_applications lookup. Skeleton in place so it's
//    obvious where to plug in DB-driven payment data.
//
// registerPaymentDetailsStrategy('wholesale-application', async ({ email, shop }) => {
//   const app = await WholesaleApplication.findOne({ shop, email })
//   if (!app?.payment?.cardNumberHash) return null
//   // ...decrypt / use a vault token stored at registration time...
//   return { paymentToken: app.payment.nmiPaymentToken }
// })
