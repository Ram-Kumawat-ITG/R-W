// Payment-method enum + display labels.
//
// Why a separate file: these are used by both server code (config
// defaults in `services/invoice/invoice.service.js`) and client UI
// (badges + columns on admin routes). Keeping them isomorphic and
// dependency-free means either layer can import without pulling the
// other's deps.
//
// Canonical values are the same as the enum on the Invoice +
// CustomerMap Mongoose schemas. Don't add a new method here without
// also extending the enums on:
//   - models/invoice.server.js (paymentMethod, customerPaymentPreference, paymentSettledVia)
//   - models/customerMap.server.js (paymentMethod)

export const PAYMENT_METHODS = Object.freeze(['card', 'check', 'ach'])

// Long-form labels for detail pages — enough words to be unambiguous
// on a wide page with whitespace to spare.
export const PAYMENT_METHOD_LABEL = Object.freeze({
  card: 'Credit card',
  check: 'Check / Cheque',
  ach: 'ACH / Bank transfer',
})

// Compact labels for list/table cells where vertical density matters
// and each row only gets a handful of pixels.
export const PAYMENT_METHOD_SHORT = Object.freeze({
  card: 'Credit card',
  check: 'Cheque',
  ach: 'ACH',
})

// Helpers that fall back to the raw enum value so legacy / unexpected
// values still render something meaningful instead of `undefined`.
export function paymentMethodLabel(method) {
  return PAYMENT_METHOD_LABEL[method] || method || null
}
export function paymentMethodShort(method) {
  return PAYMENT_METHOD_SHORT[method] || method || null
}
