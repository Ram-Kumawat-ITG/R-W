// Shipping / carrier constants + pure helpers.
//
// ISOMORPHIC and dependency-free (no process.env, no I/O) so it can be
// imported from BOTH the server (order.service fulfillment handler) and the
// admin route render (app.orders.$id.jsx) without dragging a config chain
// into the browser bundle — same rule that keeps render-side code out of
// *.service.js / *.config.js.
//
// The carrier → official-tracking-URL templates here are the BASE set;
// services/order/tracking.config.js can pass env-configured extras into
// resolveCarrierTrackingUrl for "other configured carriers" without touching
// this file (and without leaking env into the bundle — the service resolves
// and STORES the final URL, the render only reads it back).

// `{trackingNumber}` is substituted (URL-encoded) at resolve time.
export const CARRIER_TRACKING_URL_TEMPLATES = Object.freeze({
  ups: 'https://www.ups.com/track?loc=en_US&tracknum={trackingNumber}',
  fedex: 'https://www.fedex.com/fedextrack/?trknbr={trackingNumber}',
  usps: 'https://tools.usps.com/go/TrackConfirmAction?tLabels={trackingNumber}',
  dhl: 'https://www.dhl.com/us-en/home/tracking.html?tracking-id={trackingNumber}',
})

export const CARRIER_LABEL = Object.freeze({
  ups: 'UPS',
  fedex: 'FedEx',
  usps: 'USPS',
  dhl: 'DHL',
  other: 'Other',
})

// Shopify `shipment_status` (carrier-driven) + `status` (fulfillment-level)
// values we render. Anything unmapped falls back to the raw value.
export const SHIPMENT_STATUS_LABEL = Object.freeze({
  // carrier shipment_status
  label_printed: 'Label printed',
  label_purchased: 'Label purchased',
  attempted_delivery: 'Attempted delivery',
  ready_for_pickup: 'Ready for pickup',
  picked_up: 'Picked up',
  confirmed: 'Confirmed',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  failure: 'Delivery failure',
  // fulfillment.status
  pending: 'Pending',
  open: 'Open',
  success: 'Fulfilled',
  cancelled: 'Cancelled',
  error: 'Error',
})

// Normalize a Shopify `tracking_company` free-text string to a carrier key.
// Shopify sends values like "UPS", "United States Postal Service", "USPS",
// "FedEx", "DHL Express", "DHL eCommerce" — match loosely. Unknown → 'other'.
export function normalizeCarrier(raw) {
  const v = String(raw || '').trim().toLowerCase()
  if (!v) return 'other'
  if (v.includes('ups') && !v.includes('groups')) return 'ups'
  if (v.includes('fedex') || v.includes('fed ex')) return 'fedex'
  if (v.includes('usps') || v.includes('postal service') || v.includes('united states post')) {
    return 'usps'
  }
  if (v.includes('dhl')) return 'dhl'
  return 'other'
}

// Human label for the carrier: the canonical brand name for a known key,
// otherwise the raw company string Shopify provided, otherwise "Carrier".
export function carrierDisplayName(carrierKey, rawCompany) {
  if (carrierKey && carrierKey !== 'other' && CARRIER_LABEL[carrierKey]) {
    return CARRIER_LABEL[carrierKey]
  }
  return rawCompany || CARRIER_LABEL.other
}

// Friendly shipment-status label, falling back to the raw value.
export function shipmentStatusLabel(status) {
  if (!status) return null
  return SHIPMENT_STATUS_LABEL[status] || status
}

// Resolve the customer-facing tracking link:
//   1. A carrier deep-link from the template map (base ∪ extraTemplates),
//      with the tracking number pre-filled.
//   2. Else Shopify's own `tracking_url` (already carrier-aware for many).
//   3. Else null (render the number as plain text).
// `extraTemplates` is the optional env-configured override map the server
// passes in; the render never needs it (the resolved URL is stored).
export function resolveCarrierTrackingUrl({
  carrierKey,
  trackingNumber,
  shopifyUrl,
  extraTemplates,
} = {}) {
  const templates = { ...CARRIER_TRACKING_URL_TEMPLATES, ...(extraTemplates || {}) }
  const tpl = carrierKey ? templates[carrierKey] : null
  if (tpl && trackingNumber) {
    return tpl.replace('{trackingNumber}', encodeURIComponent(String(trackingNumber)))
  }
  return shopifyUrl || null
}
