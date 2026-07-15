import { authenticate } from "../shopify.server";
import connectDB from "../db/mongo.server";
import {
  isRetailQboProductSyncEnabled,
  syncRetailProductToQbo,
} from "../services/retailQbo/retailQboProductSync.service";

// Retail Shopify products/update → update the matching QBO Item(s) in the
// RETAIL realm (creating any that don't exist yet) + refresh
// retail_qbo_product_maps. Never deletes/deactivates. Fire-and-forget.
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
    console.error("[webhooks.products.update] HMAC auth failed:", err?.message || err);
    return new Response(null, { status: 401 });
  }

  if (!payload?.id) return new Response("Bad payload", { status: 400 });

  if (!isRetailQboProductSyncEnabled()) {
    return new Response(null, { status: 200 });
  }

  if (webhookId) {
    if (_seenWebhookIds.has(webhookId)) return new Response(null, { status: 200 });
    _seenWebhookIds.add(webhookId);
    setTimeout(() => _seenWebhookIds.delete(webhookId), SEEN_TTL_MS).unref?.();
  }

  await connectDB();

  syncRetailProductToQbo(payload, { shop, event: "update" })
    .then((s) => console.log(`[webhooks.products.update] qbo synced product ${payload.id}:`, s))
    .catch((err) => console.error(`[webhooks.products.update] qbo sync failed for ${payload.id}:`, err?.message || err));

  return new Response(null, { status: 200 });
}

export async function loader() {
  return new Response("Method not allowed", { status: 405 });
}
