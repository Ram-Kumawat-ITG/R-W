import { authenticate } from "../shopify.server";
import connectDB from "../db/mongo.server";
import {
  isRetailQboProductSyncEnabled,
  syncRetailProductToQbo,
} from "../services/retailQbo/retailQboProductSync.service";

// Retail Shopify products/create → create the matching QBO Item(s) in the
// RETAIL realm + maintain retail_qbo_product_maps. Fire-and-forget: verify
// HMAC, dedup, return 200 fast, do the QBO work in the background.
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
    console.error("[webhooks.products.create] HMAC auth failed:", err?.message || err);
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

  syncRetailProductToQbo(payload, { shop, event: "create" })
    .then((s) => console.log(`[webhooks.products.create] qbo synced product ${payload.id}:`, s))
    .catch((err) => console.error(`[webhooks.products.create] qbo sync failed for ${payload.id}:`, err?.message || err));

  return new Response(null, { status: 200 });
}

export async function loader() {
  return new Response("Method not allowed", { status: 405 });
}
