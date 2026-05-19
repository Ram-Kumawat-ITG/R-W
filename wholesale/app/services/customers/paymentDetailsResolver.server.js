import { config } from '../config.server'
import { createLogger } from '../logger.server'

const log = createLogger('customers.payment_resolver')

// Strategy registry. First strategy that returns a non-null PaymentDetails
// wins. New strategies (e.g. wholesale_applications lookup) get added
// here without touching ensureCustomerForOrder.
//
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

// ---- Built-in strategies ----

// 1. Static test card from env. Sandbox only — config layer scrubs the
//    values in non-sandbox env via assertSafeTestCardConfig().
registerPaymentDetailsStrategy('static-test-card', async () => {
  const { ccnumber, ccexp, cvv } = config.nmi.testCard
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
