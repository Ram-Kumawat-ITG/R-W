/* eslint-disable react/prop-types */
// Shipping (fulfillment) + Delivery (carrier) status badges. Both read the
// canonical status key produced server-side by the order-status derivation
// (app/utils/orderStatus.js) and render a tone-mapped Polaris <s-badge>, so the
// Orders list + detail pages stay visually consistent.

import { shippingStatusMeta, deliveryStatusMeta } from "../../utils/orderStatus";

export function ShippingBadge({ status }) {
  const m = shippingStatusMeta(status);
  return <s-badge tone={m.tone}>{m.label}</s-badge>;
}

export function DeliveryBadge({ status }) {
  const m = deliveryStatusMeta(status);
  return <s-badge tone={m.tone}>{m.label}</s-badge>;
}
