import { authenticate } from "../shopify.server";
import { cancelShopifyOrder } from "../services/cdo/cdo.service";

// In-memory dedup of webhook ids — Shopify delivers at-least-once. The
// service layer is also idempotent (re-cancelling a cancelled order /
// already-reversed commission is a no-op), this is just a fast-path.
const _seenWebhookIds = new Set();
const SEEN_TTL_MS = 5 * 60 * 1000;

// Handler for retail Shopify orders/cancelled.
//
//   1. Verify HMAC
//   2. Dedup against the webhook id
//   3. Return 200 IMMEDIATELY (fire-and-forget)
//   4. Mark the cdo_order cancelled + reverse its commission if it isn't
//      already paid / batched into a payout (see cancelShopifyOrder)
export async function action({ request }) {
  let shop, payload, webhookId;
  try {
    const res = await authenticate.webhook(request);
    shop = res.shop;
    payload = res.payload;
    webhookId = request.headers.get("x-shopify-webhook-id");
  } catch (err) {
    console.error(
      "[webhooks.orders.cancelled] HMAC auth failed:",
      err?.message || err,
    );
    return new Response(null, { status: 401 });
  }

  if (webhookId) {
    if (_seenWebhookIds.has(webhookId)) {
      console.log(`[webhooks.orders.cancelled] duplicate webhook id ${webhookId}, skipping`);
      return new Response(null, { status: 200 });
    }
    _seenWebhookIds.add(webhookId);
    setTimeout(() => _seenWebhookIds.delete(webhookId), SEEN_TTL_MS).unref?.();
  }

  const shopifyOrderId =
    payload?.admin_graphql_api_id ||
    (payload?.id ? `gid://shopify/Order/${payload.id}` : null);

  cancelShopifyOrder({ shop, shopifyOrderId }).catch((err) => {
    console.error(
      `[webhooks.orders.cancelled] cancelling order ${payload?.id} failed:`,
      err?.message || err,
    );
  });

  return new Response(null, { status: 200 });
}

export async function loader() {
  return new Response("Method not allowed", { status: 405 });
}
