import { authenticate } from "../shopify.server";
import { recordFulfillmentAndSync } from "../services/retailQbo/retailOrderInvoice.service";

// Shopify fulfillments/create webhook — a shipment was created for a retail
// order. Capture its carrier + tracking onto the cdo_orders doc and mirror it
// onto the retail QBO invoice (if one exists). Thin handler: verify HMAC,
// dedup, return 200 immediately, do the work fire-and-forget.
const _seenWebhookIds = new Set();
const SEEN_TTL_MS = 5 * 60 * 1000;

export async function action({ request }) {
  let shop, payload, webhookId;
  try {
    const res = await authenticate.webhook(request);
    shop = res.shop;
    payload = res.payload;
    webhookId = request.headers.get("x-shopify-webhook-id");
  } catch (err) {
    console.error("[webhooks.fulfillments.create] HMAC auth failed:", err?.message || err);
    return new Response(null, { status: 401 });
  }

  if (webhookId) {
    if (_seenWebhookIds.has(webhookId)) {
      return new Response(null, { status: 200 });
    }
    _seenWebhookIds.add(webhookId);
    setTimeout(() => _seenWebhookIds.delete(webhookId), SEEN_TTL_MS).unref?.();
  }

  const orderGid = payload?.order_id ? `gid://shopify/Order/${payload.order_id}` : null;
  if (orderGid) {
    recordFulfillmentAndSync({
      shop,
      shopifyOrderId: orderGid,
      fulfillment: payload,
      event: "created",
    }).catch((err) => {
      console.error(
        `[webhooks.fulfillments.create] sync for order ${payload?.order_id} failed:`,
        err?.message || err,
      );
    });
  }

  return new Response(null, { status: 200 });
}

export async function loader() {
  return new Response("Method not allowed", { status: 405 });
}
