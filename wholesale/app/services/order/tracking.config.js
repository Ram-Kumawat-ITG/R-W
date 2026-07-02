// Shipment-tracking config — env-configured carrier overrides/extras.
//
// SERVER-ONLY (reads process.env at init). The pure base carrier map +
// resolver live in app/utils/shipping.constants.js so the render side never
// imports this. The order-service fulfillment handler reads
// `extraCarrierTemplates` here and passes it into resolveCarrierTrackingUrl,
// then STORES the resolved URL on the order doc.
//
// CARRIER_TRACKING_URLS lets ops add or override carrier deep-links without a
// code change. Format: a JSON object of { carrierKey: "https://…{trackingNumber}…" }.
// Example: CARRIER_TRACKING_URLS='{"ontrac":"https://www.ontrac.com/tracking/?number={trackingNumber}"}'
// These merge on top of the base UPS/FedEx/USPS/DHL templates (override wins).

import { readEnv } from '../../utils/env.utils'

function parseTemplates(raw) {
  if (!raw) return {}
  try {
    const obj = JSON.parse(raw)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj
    console.warn('[tracking.config] CARRIER_TRACKING_URLS is not a JSON object — ignoring')
  } catch (err) {
    console.warn(`[tracking.config] CARRIER_TRACKING_URLS is not valid JSON — ignoring (${err.message})`)
  }
  return {}
}

export const trackingConfig = {
  extraCarrierTemplates: parseTemplates(readEnv('CARRIER_TRACKING_URLS', { fallback: '' })),
}
