import { authenticate } from "../shopify.server";
import connectDB from "../db/mongo.server";
import {
  isRetailQboProductSyncEnabled,
  syncRetailInventoryLevel,
} from "../services/retailQbo/retailQboProductSync.service";

// Retail Shopify inventory_levels/update → reconcile the matching QBO
// Inventory item's on-hand quantity to Shopify's new `available`. This is the
// ongoing stock-sync path (products/update does NOT fire on stock-only
// changes, and QBO QtyOnHand can only be changed via InventoryAdjustment).
// Fire-and-forget.
const _seenWebhookIds = new Set();
const SEEN_TTL_MS = 5 * 60 * 1000;

export async function action({ request }) {
  let payload, webhookId;
  try {
    const res = await authenticate.webhook(request);
    payload = res.payload;
    webhookId = request.headers.get("x-shopify-webhook-id");
  } catch (err) {
    console.error("[webhooks.inventory_levels.update] HMAC auth failed:", err?.message || err);
    return new Response(null, { status: 401 });
  }

  if (!isRetailQboProductSyncEnabled()) {
    return new Response(null, { status: 200 });
  }

  // Payload: { inventory_item_id, location_id, available, updated_at }
  const inventoryItemId = payload?.inventory_item_id;
  const available = payload?.available;
  if (inventoryItemId == null) return new Response("Bad payload", { status: 400 });

  if (webhookId) {
    if (_seenWebhookIds.has(webhookId)) return new Response(null, { status: 200 });
    _seenWebhookIds.add(webhookId);
    setTimeout(() => _seenWebhookIds.delete(webhookId), SEEN_TTL_MS).unref?.();
  }

  await connectDB();

  syncRetailInventoryLevel({ inventoryItemId, available })
    .then((s) => console.log(`[webhooks.inventory_levels.update] qbo qty sync for inv ${inventoryItemId}:`, s))
    .catch((err) => console.error(`[webhooks.inventory_levels.update] failed for inv ${inventoryItemId}:`, err?.message || err));

  return new Response(null, { status: 200 });
}

export async function loader() {
  return new Response("Method not allowed", { status: 405 });
}
