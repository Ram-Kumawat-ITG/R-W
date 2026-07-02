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
  // synthetic order-level rollup keys (deriveDeliveryStatus)
  not_shipped: 'Not shipped',
  shipped: 'Shipped',
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

// Carrier shipment_status → progress rank (higher = closer to the customer's
// hands). `shipped` is the synthetic value for a fulfillment with no carrier
// scan yet. `failure` is handled out-of-band (an exception, not a progress
// point).
export const SHIPMENT_STATUS_RANK = Object.freeze({
  shipped: 0.5,
  label_printed: 1,
  label_purchased: 1,
  confirmed: 1,
  ready_for_pickup: 2,
  in_transit: 3,
  attempted_delivery: 3,
  out_for_delivery: 4,
  delivered: 5,
})

// Roll the per-shipment carrier statuses up into ONE order-level delivery
// status for a list column. Returns:
//   'not_shipped'  — no active (non-cancelled) fulfillment yet
//   'failure'      — any active shipment failed delivery (surfaced first)
//   'delivered'    — EVERY active shipment is delivered
//   else           — the LEAST-progressed active shipment (so the still-in-
//                    flight part stays visible); a shipment with no carrier
//                    event yet counts as 'shipped'.
// Pure + isomorphic — safe to call from a loader or a render path.
export function deriveDeliveryStatus(fulfillments) {
  const active = (Array.isArray(fulfillments) ? fulfillments : []).filter(
    (f) => String(f?.status || '').toLowerCase() !== 'cancelled',
  )
  if (!active.length) return 'not_shipped'
  const keys = active.map((f) => {
    const v = String(f?.shipmentStatus || '').toLowerCase().trim()
    return v || null
  })
  if (keys.includes('failure')) return 'failure'
  if (keys.every((k) => k === 'delivered')) return 'delivered'
  let lowestKey = 'shipped'
  let lowestRank = Infinity
  for (const k of keys) {
    const eff = k || 'shipped'
    const rank = SHIPMENT_STATUS_RANK[eff] ?? 0.5
    if (rank < lowestRank) {
      lowestRank = rank
      lowestKey = eff
    }
  }
  return lowestKey
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
