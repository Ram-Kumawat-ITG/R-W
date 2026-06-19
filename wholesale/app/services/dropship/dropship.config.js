// Drop-ship orchestrator config — identifies the synthetic B2B customer
// on the wholesale store that every retail-triggered drop-ship order is
// attached to.
//
// SERVER-ONLY (reads process.env at init).
//
// The email + tag are RESOLUTION ANCHORS so the orchestrator never
// hard-codes a Shopify Customer GID. On first call the service finds
// (or creates) the customer by tag/email and caches the GID in-process.
//
// Override these per-environment so dev / staging / prod each point at
// their own internal customer without a code change.

import { readEnv, readInt } from '../../utils/env.utils'

export const dropshipConfig = {
  retailCustomerEmail: readEnv('DROPSHIP_RETAIL_CUSTOMER_EMAIL', {
    fallback: 'famixu@denipl.com',
  }),
  retailCustomerTag: readEnv('DROPSHIP_RETAIL_CUSTOMER_TAG', {
    fallback: 'ns-retail-internal',
  }),
  // SHARED with the carrier-service callback at app/api/shipping/rates.js —
  // markup per cart-item, in cents, applied on TOP of every real carrier
  // quote retail charges its customer. Drop-ship reverses this math so the
  // parallel wholesale order only carries the REAL carrier cost
  // (retail_shipping − totalQty × this_value).
  //
  // Default $1/item — matches rates.js default. Keep both ends in sync via
  // the same env var (single source of truth).
  shippingMarkupPerQtyCents: readInt('SHIPPING_PER_QTY_CENTS', 100),
}

// Pre-normalized (trimmed + lowercased) anchor email. The orchestrator and
// the Admin Orders route loaders compare against this so an order placed by
// the retail customer is recognized regardless of how Shopify cased the
// address. ShopifyOrder.customerEmail is also stored lowercased, so this is
// directly usable in a Mongo `{ customerEmail: ... }` filter.
//
// SERVER-ONLY: this module reads process.env at init. Only import it from
// loaders / actions / services — never from a route's render path (the
// React Router compiler strips loader-only imports from the client bundle).
export const RETAIL_CUSTOMER_EMAIL = String(dropshipConfig.retailCustomerEmail || '')
  .trim()
  .toLowerCase()

// True when `email` is the retail drop-ship customer (DROPSHIP_RETAIL_CUSTOMER_EMAIL).
// Orders placed by this customer are "Admin Orders" — already paid, never
// invoiced, and excluded from the commission / payment CRON. Case-insensitive.
export function isRetailCustomerEmail(email) {
  if (!email || !RETAIL_CUSTOMER_EMAIL) return false
  return String(email).trim().toLowerCase() === RETAIL_CUSTOMER_EMAIL
}
