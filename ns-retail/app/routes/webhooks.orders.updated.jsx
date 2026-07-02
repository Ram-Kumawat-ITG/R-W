import { authenticate } from "../shopify.server";
import { ingestShopifyOrder } from "../services/cdo/cdo.service";
import { ensureRetailInvoiceFromPayload } from "../services/retailQbo/retailOrderInvoice.service";
import { extractPractitionerCode } from "../utils/orderCode";

// In-memory dedup of webhook ids (the DB layer is also idempotent).
const _seenWebhookIds = new Set();
const SEEN_TTL_MS = 5 * 60 * 1000;

// Handler for orders/updated — fires on order changes including payment
// transitions (paid) and, crucially, REFUNDS / VOIDS. Re-runs the order sync;
// ingestShopifyOrder reconciles the commission to the order's current payment
// state: create when newly paid, reverse when refunded/voided (a paid/batched
// commission is never clawed back), no-op otherwise. Idempotent.
export async function action({ request }) {
  let shop, payload, webhookId;
  try {
    const res = await authenticate.webhook(request);
    shop = res.shop;
    payload = res.payload;
    webhookId = request.headers.get("x-shopify-webhook-id");
  } catch (err) {
    console.error("[webhooks.orders.updated] HMAC auth failed:", err?.message || err);
    return new Response(null, { status: 401 });
  }

  if (webhookId) {
    if (_seenWebhookIds.has(webhookId)) {
      console.log(`[webhooks.orders.updated] duplicate webhook id ${webhookId}, skipping`);
      return new Response(null, { status: 200 });
    }
    _seenWebhookIds.add(webhookId);
    setTimeout(() => _seenWebhookIds.delete(webhookId), SEEN_TTL_MS).unref?.();
  }

  const { code, source } = extractPractitionerCode(payload);
  // Ingest first, THEN ensure the retail QBO invoice (idempotent — retries a
  // missed/failed create). Chained + fire-and-forget so the webhook 200s fast.
  ingestShopifyOrder({ shop, payload, rawCode: code, attributionSource: source })
    .then(() => ensureRetailInvoiceFromPayload({ shop, payload, trigger: "orders/updated" }))
    .catch((err) => {
      console.error(
        `[webhooks.orders.updated] processing order ${payload?.id} failed:`,
        err?.message || err,
      );
    });

  return new Response(null, { status: 200 });
}

export async function loader() {
  return new Response("Method not allowed", { status: 405 });
}
