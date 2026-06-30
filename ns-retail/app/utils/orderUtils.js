// Shared, reusable helpers for Shopify order payloads. PURE (no DB, no
// process.env) so any handler — order ingest, refund, chargeback, or
// customer-merge — can reuse them instead of re-defining the extraction
// inline (which was previously buried inside cdo.service.resolveOrderReferral).

// Extract the buyer email from a Shopify orders/* REST payload, lowercased +
// trimmed. Prefers the order email, then the contact email, then the
// customer's email. Returns "" when none is present.
export function orderEmail(payload) {
  return String(
    payload?.email || payload?.contact_email || payload?.customer?.email || "",
  )
    .toLowerCase()
    .trim();
}
