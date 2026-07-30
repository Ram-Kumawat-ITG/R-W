import { authenticate } from "../shopify.server";
import connectDB from "../db/mongo.server";
import {
  isRetailQboProductSyncEnabled,
  markRetailQboProductDeleted,
} from "../services/retailQbo/retailQboProductSync.service";

// Retail Shopify products/delete → the QBO Item is NEVER deleted or
// deactivated (retention for historical reporting/accounting/analytics). We
// only flag the mapping row(s) as shopify-deleted for audit. Fire-and-forget.
const _seenWebhookIds = new Set();
const SEEN_TTL_MS = 5 * 60 * 1000;

export async function action({ request }) {
  let payload, webhookId;
  try {
    const res = await authenticate.webhook(request);
    payload = res.payload;
    webhookId = request.headers.get("x-shopify-webhook-id");
  } catch (err) {
    console.error("[webhooks.products.delete] HMAC auth failed:", err?.message || err);
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

  markRetailQboProductDeleted(payload.id)
    .then((s) => console.log(`[webhooks.products.delete] qbo item retained for ${payload.id}:`, s))
    .catch((err) => console.error(`[webhooks.products.delete] mark-deleted failed for ${payload.id}:`, err?.message || err));

  return new Response(null, { status: 200 });
}

export async function loader() {
  return new Response("Method not allowed", { status: 405 });
}
