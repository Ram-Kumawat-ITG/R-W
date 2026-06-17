// Order status derivation — the single source of truth for the two
// admin-facing statuses on the Retail Orders list + detail pages:
//
//   • Shipping status  — the FULFILLMENT state of the order
//       unfulfilled · partially_fulfilled · fulfilled · restocked · returned · cancelled
//   • Delivery status  — the CARRIER shipment state of what was shipped
//       not_shipped · shipped · label_printed · confirmed · ready_for_pickup
//       · in_transit · out_for_delivery · attempted_delivery · delivered
//       · failure · returned · cancelled
//
// Both are DERIVED (never trusted from a single stored field) so they stay in
// sync with Shopify even when one webhook is missed or arrives late:
//   - order.fulfillmentStatus  ← orders/* webhooks (Shopify's order-level value)
//   - order.fulfillments[]      ← fulfillments/create|update webhooks
//                                 (.status = fulfillment lifecycle,
//                                  .shipmentStatus = carrier tracking events)
//
// This module is PURE (no server imports, no process.env) so it is safe to
// import from BOTH the service layer (server) and the route components
// (client badges) — see the project rule against importing *.service.js into
// render code.

// Shopify Fulfillment.shipment_status → progress rank. Higher = closer to the
// customer's hands. "shipped" is our synthetic value for a fulfillment that
// exists but whose carrier hasn't reported a tracking event yet. "failure" is
// handled out-of-band (it's an exception, not a progress point).
const SHIPMENT_RANK = {
  shipped: 0.5,
  label_printed: 1,
  label_purchased: 1,
  confirmed: 1,
  ready_for_pickup: 2,
  in_transit: 3,
  attempted_delivery: 3,
  out_for_delivery: 4,
  delivered: 5,
};

function isCancelled(order) {
  return (
    order?.status === "cancelled" ||
    Boolean(order?.cancelledAt) ||
    Boolean(order?.cancelled_at)
  );
}

// Fulfillments that haven't been cancelled — the only ones that count toward
// the order's shipping / delivery state.
function activeFulfillments(order) {
  const ff = Array.isArray(order?.fulfillments) ? order.fulfillments : [];
  return ff.filter((f) => String(f?.status || "").toLowerCase() !== "cancelled");
}

// Normalize a raw carrier shipment_status to a canonical delivery key.
// Returns null when there is no carrier event yet.
function normalizeShipmentStatus(raw) {
  const v = String(raw || "").toLowerCase().trim();
  if (!v) return null;
  if (v === "label_purchased") return "label_printed";
  return v;
}

// SHIPPING (fulfillment) status — what fraction of the order has shipped.
// Trusts Shopify's order-level fulfillment_status when present, and self-heals
// from fulfillments[] when that field is stale/missing (the bug where a
// shipped+delivered order still read "unfulfilled" because orders/updated was
// missed).
export function deriveShippingStatus(order) {
  if (!order) return "unfulfilled";
  if (isCancelled(order)) return "cancelled";

  const raw = String(order.fulfillmentStatus || "").toLowerCase();
  if (raw === "fulfilled") return "fulfilled";
  if (raw === "partial" || raw === "partially_fulfilled") return "partially_fulfilled";
  if (raw === "restocked") return "returned";

  // Self-heal: order-level field absent/unfulfilled but fulfillments exist.
  const active = activeFulfillments(order);
  if (active.length > 0) {
    const anyShipped = active.some(
      (f) =>
        normalizeShipmentStatus(f.shipmentStatus) ||
        ["success", "open"].includes(String(f.status || "").toLowerCase()),
    );
    if (anyShipped) return "fulfilled";
  }
  return "unfulfilled";
}

// DELIVERY (carrier) status — where the shipment is on the way to the
// customer. Derived from fulfillments[].shipmentStatus (kept fresh by the
// fulfillments/update webhook on each carrier scan).
export function deriveDeliveryStatus(order) {
  if (!order) return "not_shipped";
  if (isCancelled(order)) return "cancelled";

  const active = activeFulfillments(order);
  if (active.length === 0) {
    return String(order.fulfillmentStatus || "").toLowerCase() === "restocked"
      ? "returned"
      : "not_shipped";
  }

  const keys = active.map((f) => normalizeShipmentStatus(f.shipmentStatus));
  // A failed delivery needs attention — surface it over everything else.
  if (keys.includes("failure")) return "failure";
  // Every shipment delivered → the whole order is delivered.
  if (keys.every((k) => k === "delivered")) return "delivered";

  // Otherwise report the least-progressed shipment so the still-in-flight part
  // stays visible. A fulfillment with no carrier event yet ranks as "shipped".
  let lowestKey = "shipped";
  let lowestRank = Infinity;
  for (const k of keys) {
    const eff = k || "shipped";
    const rank = SHIPMENT_RANK[eff] ?? 0.5;
    if (rank < lowestRank) {
      lowestRank = rank;
      lowestKey = eff;
    }
  }
  return lowestKey;
}

// The date the order was delivered — the latest "delivered" timestamp across
// active fulfillments. Prefers the explicit `deliveredAt` (stamped at the
// delivered transition / mirrored from the wholesale order for drop-ship
// orders), falling back to `updatedAt` (when the shipmentStatus last changed,
// i.e. when it flipped to delivered). Returns null until every active shipment
// is delivered.
export function deriveDeliveredAt(order) {
  const active = activeFulfillments(order);
  if (active.length === 0) return null;
  const delivered = active.filter(
    (f) => normalizeShipmentStatus(f.shipmentStatus) === "delivered",
  );
  if (delivered.length === 0 || delivered.length !== active.length) return null;
  const times = delivered
    .map((f) => {
      const src = f.deliveredAt || f.updatedAt;
      return src ? new Date(src).getTime() : NaN;
    })
    .filter((t) => Number.isFinite(t));
  return times.length ? new Date(Math.max(...times)) : null;
}

// Tracking numbers + carrier links across the order's active (non-cancelled)
// fulfillments — for the Orders list "Shipping status" column, mirroring the
// detail page's fulfillment table. Deduped by tracking number (or URL when a
// fulfillment has a URL but no number). Returns [] when nothing has shipped.
export function extractTracking(order) {
  const out = [];
  const seen = new Set();
  for (const f of activeFulfillments(order)) {
    const number = f?.trackingNumber ? String(f.trackingNumber) : "";
    const url = f?.trackingUrl ? String(f.trackingUrl) : "";
    if (!number && !url) continue;
    const key = number || url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      number: number || null,
      url: url || null,
      company: f?.trackingCompany ? String(f.trackingCompany) : null,
    });
  }
  return out;
}

// key → { label, tone } for the Polaris <s-badge>. `tone` is one of
// success | warning | critical | info | neutral.
export const SHIPPING_STATUS_META = {
  unfulfilled: { label: "Unfulfilled", tone: "neutral" },
  partially_fulfilled: { label: "Partially fulfilled", tone: "warning" },
  fulfilled: { label: "Fulfilled", tone: "success" },
  restocked: { label: "Restocked", tone: "neutral" },
  returned: { label: "Returned", tone: "warning" },
  cancelled: { label: "Cancelled", tone: "critical" },
};

export const DELIVERY_STATUS_META = {
  not_shipped: { label: "Not shipped", tone: "neutral" },
  shipped: { label: "Shipped", tone: "info" },
  label_printed: { label: "Label printed", tone: "info" },
  confirmed: { label: "Confirmed", tone: "info" },
  ready_for_pickup: { label: "Ready for pickup", tone: "warning" },
  in_transit: { label: "In transit", tone: "info" },
  out_for_delivery: { label: "Out for delivery", tone: "warning" },
  attempted_delivery: { label: "Attempted delivery", tone: "warning" },
  delivered: { label: "Delivered", tone: "success" },
  failure: { label: "Delivery failed", tone: "critical" },
  returned: { label: "Returned", tone: "warning" },
  cancelled: { label: "Cancelled", tone: "critical" },
};

// Friendly fallback for an unknown key (snake_case → Title Case).
function titleCase(key) {
  return String(key || "")
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function shippingStatusMeta(key) {
  return SHIPPING_STATUS_META[key] || { label: titleCase(key) || "—", tone: "neutral" };
}

export function deliveryStatusMeta(key) {
  return DELIVERY_STATUS_META[key] || { label: titleCase(key) || "—", tone: "neutral" };
}
