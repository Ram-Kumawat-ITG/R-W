import { authenticate, unauthenticated } from "../shopify.server";
import { ingestShopifyOrder } from "../services/cdo/cdo.service";
import { ensureRetailInvoiceFromPayload } from "../services/retailQbo/retailOrderInvoice.service";
import {
  extractPractitionerCode,
  extractCodeFromTags,
} from "../utils/orderCode";
import { syncCustomerCodeTag } from "../utils/customerTags";

// In-memory dedup of webhook ids — Shopify delivers at-least-once and
// can fire the same payload multiple times in a short window. 5 min TTL
// is enough to absorb retries without leaking memory. (The DB layer is
// also idempotent — orders upsert by (shop, shopifyOrderId) — this is just
// a fast-path so retries don't re-run the whole pipeline.)
const _seenWebhookIds = new Set();
const SEEN_TTL_MS = 5 * 60 * 1000;

// Handler for retail Shopify orders/create.
//
// On every order:
//   1. Verify HMAC
//   2. Dedup against the webhook id
//   3. Return 200 IMMEDIATELY (fire-and-forget the rest — never block the
//      webhook response on downstream Mongo / GraphQL calls)
//   4. Resolve the practitioner code: cart/order attribute first, then a
//      discount code on the order, then a `CODE:`/`REFERRAL:` tag on the
//      Shopify customer (the code isn't always present on the order itself)
//   5. Hand the order to cdo.service.ingestShopifyOrder, which syncs the
//      full order into cdo_orders and — when attributed — creates the
//      referral / commission / ledger / customer-mapping records
//   6. Tag the customer with `code:<the-code>` when attributed
export async function action({ request }) {
  // Loud entry banner — fires on EVERY inbound POST to /webhooks/orders/create,
  // before HMAC verify. Lets you confirm Shopify is hitting the route at all
  // (vs. the request silently 404'ing or the subscription never being registered).
  console.log(
    `\n========================================\n[webhooks.orders.create] 🔔 WEBHOOK RECEIVED at ${new Date().toISOString()}\n========================================`,
  );

  let shop, payload, webhookId;
  try {
    const res = await authenticate.webhook(request);
    shop = res.shop;
    payload = res.payload;
    webhookId = request.headers.get("x-shopify-webhook-id");
    console.log(
      `[webhooks.orders.create] ✅ HMAC verified · shop=${shop} · webhookId=${webhookId} · orderId=${payload?.id} · orderName=${payload?.name}`,
    );
  } catch (err) {
    console.error(
      "[webhooks.orders.create] ❌ HMAC auth failed:",
      err?.message || err,
    );
    return new Response(null, { status: 401 });
  }

  if (webhookId) {
    if (_seenWebhookIds.has(webhookId)) {
      console.log(
        `[webhooks.orders.create] ⏭️  duplicate webhook id ${webhookId} — skipping (returning 200)`,
      );
      return new Response(null, { status: 200 });
    }
    _seenWebhookIds.add(webhookId);
    setTimeout(() => _seenWebhookIds.delete(webhookId), SEEN_TTL_MS).unref?.();
  }

  console.log(
    `[webhooks.orders.create] 🚀 dispatching processOrder + forwardToWholesale (fire-and-forget) for order ${payload?.id}`,
  );

  // Fire-and-forget so Shopify gets 200 fast. Errors inside the
  // promise are logged but don't affect the webhook response.
  processOrder({ shop, payload }).catch((err) => {
    console.error(
      `[webhooks.orders.create] ❌ processing order ${payload?.id} failed:`,
      err?.message || err,
    );
  });

  // Drop-ship forwarder — POST the full order payload to the wholesale
  // app's /api/sync/retail-order so it can create the parallel wholesale
  // Shopify order, wholesale invoice, and retail QBO bill.
  //
  // This is INDEPENDENT of the CDO tagging logic above — every retail
  // order needs to flow to wholesale regardless of whether a practitioner
  // code was used. Fire-and-forget; failures here do NOT block the
  // webhook 200 response.
  forwardToWholesaleDropship({ payload, retailShop: shop }).catch((err) => {
    console.error(
      `[webhooks.orders.create] ❌ forward-to-wholesale failed for order ${payload?.id}:`,
      err?.message || err,
    );
  });

  console.log(
    `[webhooks.orders.create] ✅ 200 returned to Shopify (downstream work continues in background) · order=${payload?.id}\n`,
  );
  return new Response(null, { status: 200 });
}

// ── Drop-ship forwarder ─────────────────────────────────────────────────
//
// Reads three env vars (set in ns-retail/.env):
//   WHOLESALE_API_BASE   - e.g. "https://abc.trycloudflare.com" — the
//                          wholesale app's current public URL
//   WHOLESALE_SHOP       - e.g. "ns-wholesale.myshopify.com" — passed as
//                          ?shop=... query param so wholesale knows which
//                          tenant to operate on
//   RETAIL_SYNC_SECRET   - shared secret matching wholesale/.env's same
//                          var; sent as x-sync-secret header for auth
//
// If any env var is missing, logs once and skips — the webhook still
// returns 200, and the CDO tagging logic continues to work. This lets
// devs run ns-retail standalone without the wholesale app booted.
async function forwardToWholesaleDropship({ payload, retailShop }) {
  // eslint-disable-next-line no-undef
  const apiBase ="https://buzz-wherever-screw-partnerships.trycloudflare.com"||  process.env.WHOLESALE_API_BASE;
  // eslint-disable-next-line no-undef
  const wholesaleShop = process.env.WHOLESALE_SHOP;
  // eslint-disable-next-line no-undef
  const syncSecret = process.env.RETAIL_SYNC_SECRET;

  console.log(
    `[forward-to-wholesale] ▶️  starting forward for order ${payload?.id} · apiBase=${apiBase || "(missing)"} · wholesaleShop=${wholesaleShop || "(missing)"} · secretSet=${Boolean(syncSecret)}`,
  );

  if (!apiBase || !wholesaleShop || !syncSecret) {
    console.warn(
      "[forward-to-wholesale] ⚠️  missing env (WHOLESALE_API_BASE/WHOLESALE_SHOP/RETAIL_SYNC_SECRET) — skipping forward",
    );
    return;
  }

  const url = new URL(`${apiBase.replace(/\/$/, "")}/api/sync/retail-order`);
  url.searchParams.set("shop", wholesaleShop);
  if (retailShop) url.searchParams.set("retail_shop", retailShop);

  console.log(`[forward-to-wholesale] 🌐 POST ${url.toString()}`);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-sync-secret": syncSecret,
      // ngrok free-tier serves an HTML interstitial ("You are about to
      // visit…") with HTTP 200 on first POST unless this header is set.
      // Without it the wholesale app never sees the request — Shopify
      // CLI tunnels add this header automatically for embedded admin
      // requests, but our server-to-server fetch must add it manually.
      "ngrok-skip-browser-warning": "true",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `wholesale /api/sync/retail-order returned ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  console.log(
    `[forward-to-wholesale] order ${payload?.id} forwarded (status ${res.status})`,
  );
}

async function processOrder({ shop, payload }) {
  let { code, source } = extractPractitionerCode(payload);

  // The referral code isn't always on the order. Fall back to the
  // customer's Shopify tags (e.g. "CODE:DURGESH10" / "REFERRAL:DURGESH10").
  const customerGid = payload?.customer?.admin_graphql_api_id || null;
  if (!code && customerGid) {
    try {
      const tags = await fetchCustomerTags(shop, customerGid);
      const fromTag = extractCodeFromTags(tags);
      if (fromTag) {
        code = fromTag;
        source = "customer_tag";
        console.log(
          `[webhooks.orders.create] resolved code "${fromTag}" from customer ${customerGid} tags`,
        );
      }
    } catch (err) {
      console.error(
        `[webhooks.orders.create] fetching customer ${customerGid} tags failed:`,
        err?.message || err,
      );
    }
  }

  const result = await ingestShopifyOrder({
    shop,
    payload,
    rawCode: code,
    attributionSource: source,
  });

  // Retail QBO invoice — every retail order gets a corresponding QBO Invoice
  // in the retail company (QBO_RETAIL_*), created right after the order is
  // synced into cdo_orders. Idempotent (claims on cdo_orders.retailQbo +
  // QBO requestid) and best-effort: a QBO failure must never break order
  // ingestion or the webhook 200. No-ops cleanly if retail QBO isn't
  // configured. The invoice id + sync state persist on cdo_orders.retailQbo.
  // The helper logs the outcome (success / reason it was skipped / error), and
  // the orders/paid + orders/updated handlers retry the same idempotent call,
  // so a transient QBO failure here self-heals on the next order event.
  await ensureRetailInvoiceFromPayload({
    shop,
    payload,
    trigger: "orders/create",
  });

  // Tag the customer with the canonical code when the order attributed and
  // we have a linked customer. Guest checkouts may have no customer — the
  // cdo_application mapping (by email) still happened inside the service.
  if (result?.attributed && result.customerGid && result.referralCode) {
    await tagCustomerWithCode(
      shop,
      result.customerGid,
      result.referralCode,
    ).catch((err) => {
      console.error(
        `[webhooks.orders.create] tag customer ${result.customerGid} failed:`,
        err?.message || err,
      );
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────
// extractPractitionerCode + extractCodeFromTags live in ../utils/orderCode
// (shared with the orders/paid + orders/updated handlers). Customer-tag
// fetching + tagging stay here (Shopify Admin API).

async function fetchCustomerTags(shop, customerGid) {
  const { admin } = await unauthenticated.admin(shop);
  const res = await admin.graphql(
    `query GetCustomerTags($id: ID!) {
      customer(id: $id) { id tags }
    }`,
    { variables: { id: customerGid } },
  );
  const data = await res.json();
  return data?.data?.customer?.tags || [];
}

async function tagCustomerWithCode(shop, customerGid, code, practitionerEmail) {
  // Use the shared utility for tagging — it handles adding/removing code:*
  // tags and preserves existing tags. Logs outcome internally.
  try {
    await syncCustomerCodeTag(shop, customerGid, code, practitionerEmail);
  } catch (err) {
    throw new Error(`Failed to tag customer ${customerGid}: ${err?.message || err}`);
  }
}

export async function loader() {
  return new Response("Method not allowed", { status: 405 });
}
