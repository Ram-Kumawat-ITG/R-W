import { authenticate } from "../shopify.server";
import { ingestShopifyOrder } from "../services/cdo/cdo.service";
import { ensureRetailInvoiceFromPayload } from "../services/retailQbo/retailOrderInvoice.service";
import { extractPractitionerCode } from "../utils/orderCode";

// In-memory dedup of webhook ids (the DB layer is also idempotent).
const _seenWebhookIds = new Set();
const SEEN_TTL_MS = 5 * 60 * 1000;

// Handler for orders/paid — fires when an order's payment is captured.
// Re-runs the order sync; ingestShopifyOrder now sees the order as PAID and
// creates the commission record (deferred at orders/create time if the order
// was still unpaid). Idempotent: re-delivery never double-creates.
//
// Attribution is resolved by the service (cdo_applications mapping primary,
// the order's code as fallback) — the create handler already tagged the
// customer, so no tagging is needed here.
export async function action({ request }) {
  let shop, payload, webhookId;
  try {
    const res = await authenticate.webhook(request);
    shop = res.shop;
    payload = res.payload;
    webhookId = request.headers.get("x-shopify-webhook-id");
  } catch (err) {
    console.error("[webhooks.orders.paid] HMAC auth failed:", err?.message || err);
    return new Response(null, { status: 401 });
  }

  if (webhookId) {
    if (_seenWebhookIds.has(webhookId)) {
      console.log(`[webhooks.orders.paid] duplicate webhook id ${webhookId}, skipping`);
      return new Response(null, { status: 200 });
    }
    _seenWebhookIds.add(webhookId);
    setTimeout(() => _seenWebhookIds.delete(webhookId), SEEN_TTL_MS).unref?.();
  }

  const { code, source } = extractPractitionerCode(payload);
  // Ingest first (so the cdo_orders doc exists), THEN ensure the retail QBO
  // invoice — idempotent, so this retries a missed/failed create from
  // orders/create. Chained + fire-and-forget so the webhook still 200s fast.
  ingestShopifyOrder({ shop, payload, rawCode: code, attributionSource: source })
    .then(() => ensureRetailInvoiceFromPayload({ shop, payload, trigger: "orders/paid" }))
    .catch((err) => {
      console.error(
        `[webhooks.orders.paid] processing order ${payload?.id} failed:`,
        err?.message || err,
      );
    });

  return new Response(null, { status: 200 });
}

export async function loader() {
  return new Response("Method not allowed", { status: 405 });
}
