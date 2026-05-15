import { loadStripe } from '@stripe/stripe-js'

let stripePromise

// Singleton — call this from <Elements stripe={getStripe()}>.
// Returns null when the publishable key is missing so the UI can render a
// graceful fallback instead of crashing.
export function getStripe() {
  const key = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY
  if (!key) return null
  if (!stripePromise) {
    stripePromise = loadStripe(key)
  }
  return stripePromise
}

export function hasStripe() {
  return Boolean(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY)
}
