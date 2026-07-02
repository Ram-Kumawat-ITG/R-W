/* eslint-env node */
import { sendResponse } from "../../services/APIService/api.service";
import { applyWholesaleFulfillment } from "../../services/sync/wholesaleFulfillment.service";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("api.sync.wholesale_fulfillment");

// Dedup re-delivered notifications (wholesale retries / repeated live-pulls)
// on (orderRef + event + signature) within a short window. The applier is
// idempotent regardless, but this avoids redundant Shopify mutations + emails.
const _seen = new Set();
function claim(key) {
  if (!key || _seen.has(key)) return false;
  _seen.add(key);
  setTimeout(() => _seen.delete(key), 5 * 60 * 1000).unref?.();
  return true;
}

// POST /api/sync/wholesale-fulfillment
//
// Called by the WHOLESALE app when a drop-ship wholesale order's fulfillment /
// cancellation status changes. We mirror that status onto the linked RETAIL
// Shopify order: create/update the fulfillment (carrier + tracking, customer
// notified), or tag the order on cancellation, then record it on cdo_orders +
// the retail QBO invoice.
//
// Auth: shared secret RETAIL_SYNC_SECRET via the `x-sync-secret` header — the
// same secret the reverse retail→wholesale order sync uses.
//
// Body (JSON):
//   {
//     event              "fulfillment" | "cancelled"
//     retailOrderGid     gid://shopify/Order/<id>   (preferred)
//     retailOrderId      "<numeric id>"             (fallback)
//     retailShop         retail shop domain
//     wholesaleOrderId, wholesaleOrderName          (for audit/logging)
//     fulfillmentStatus, shippedAt
//     fulfillments[]     { trackingNumber, trackingCompany, carrier,
//                          trackingUrl, shipmentStatus, status, fulfilledAt }
//     cancel             { cancelledAt, reason }    (when event === "cancelled")
//     signature          content hash (dedup)
//   }
export async function action({ request }) {
  if (request.method !== "POST") {
    return sendResponse(405, "error", "Method not allowed", null);
  }

  // ── Auth (shared secret) ──────────────────────────────────────────
  const expectedSecret = process.env.RETAIL_SYNC_SECRET || "";
  const incomingSecret = request.headers.get("x-sync-secret") || "";
  if (!expectedSecret || incomingSecret !== expectedSecret) {
    log.warn("auth.failed", { hasSecret: Boolean(incomingSecret) });
    return sendResponse(401, "error", "Unauthorized", null);
  }

  // ── Parse body ────────────────────────────────────────────────────
  let payload;
  try {
    payload = await request.json();
  } catch {
    return sendResponse(400, "error", "Invalid JSON payload", null);
  }

  const orderRef = payload?.retailOrderGid || payload?.retailOrderId;
  if (!orderRef) {
    return sendResponse(400, "error", "Missing retailOrderId / retailOrderGid", null);
  }

  const event = payload?.event || "fulfillment";
  const dedupKey = `${orderRef}:${event}:${payload?.signature || ""}`;
  if (!claim(dedupKey)) {
    log.info("dedup.skipped", { dedupKey });
    return sendResponse(200, "success", "Duplicate — already processing", { orderRef });
  }

  log.info("received", {
    event,
    retailOrderId: payload?.retailOrderId,
    wholesaleOrderId: payload?.wholesaleOrderId,
    fulfillments: Array.isArray(payload?.fulfillments) ? payload.fulfillments.length : 0,
  });

  // Fire-and-forget — ack immediately so the wholesale caller never blocks on
  // Shopify GraphQL + QBO. The applier self-handles and logs all errors.
  applyWholesaleFulfillment(payload)
    .then((r) => log.info("done", { event, result: r }))
    .catch((err) => log.error("unhandled", { err: err?.message || String(err) }));

  return sendResponse(200, "success", "Received", { orderRef });
}

export async function loader() {
  return sendResponse(405, "error", "Method not allowed", null);
}
