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
}
