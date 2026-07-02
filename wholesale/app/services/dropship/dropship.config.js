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

import { readEnv } from '../../utils/env.utils'

export const dropshipConfig = {
  retailCustomerEmail: readEnv('DROPSHIP_RETAIL_CUSTOMER_EMAIL', {
    fallback: 'famixu@denipl.com',
  }),
  retailCustomerTag: readEnv('DROPSHIP_RETAIL_CUSTOMER_TAG', {
    fallback: 'ns-retail-internal',
  }),
  // NOTE: the shipping markup is no longer configurable here. As of
  // 2026-06-25 it is a tiered table (1-2 items → $2, 3 → $3, 4+ → $5)
  // hard-coded inside the carrier-service callbacks
  // (app/api/shipping/rates.js + ns-retail/app/api/shipping/rates.js).
  // Two locations, one tier table — keep them in lock-step on any change.
  //
  // The drop-ship `buildShippingLine` is now PASS-THROUGH — the wholesale
  // order carries the EXACT retail shipping price (carrier + tiered
  // handling markup) the customer paid. The earlier reverse-calc that
  // subtracted the markup was removed at product-owner request — the
  // supplier-side order should reflect what the customer paid, not the
  // carrier-only portion. The legacy `SHIPPING_PER_QTY_CENTS` env var is
  // no longer read.
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
