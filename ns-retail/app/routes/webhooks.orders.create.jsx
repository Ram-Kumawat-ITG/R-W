import { authenticate, unauthenticated } from "../shopify.server";
import { ingestShopifyOrder } from "../services/cdo/cdo.service";

// In-memory dedup of webhook ids — Shopify delivers at-least-once and
// can fire the same payload multiple times in a short window. 5 min TTL
// is enough to absorb retries without leaking memory. (The DB layer is
// also idempotent — orders upsert by (shop, shopifyOrderId) — this is just
// a fast-path so retries don't re-run the whole pipeline.)
const _seenWebhookIds = new Set();
const SEEN_TTL_MS = 5 * 60 * 1000;

const CODE_PATTERN = /^[a-z]+_[a-f0-9]{8}$/i;

// Customer-tag convention for carrying a referral code, e.g.
// "CODE:DURGESH10" or "REFERRAL:DURGESH10" (prefix case-insensitive). The
// value after the colon is the practitioner code, resolved downstream
// against cdo_practitioner_codes.
const TAG_CODE_PATTERN = /^\s*(?:code|referral)\s*:\s*(.+?)\s*$/i;

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
  let shop, payload, webhookId;
  try {
    const res = await authenticate.webhook(request);
    shop = res.shop;
    payload = res.payload;
    webhookId = request.headers.get("x-shopify-webhook-id");
  } catch (err) {
    console.error(
      "[webhooks.orders.create] HMAC auth failed:",
      err?.message || err,
    );
    return new Response(null, { status: 401 });
  }

  if (webhookId) {
    if (_seenWebhookIds.has(webhookId)) {
      console.log(`[webhooks.orders.create] duplicate webhook id ${webhookId}, skipping`);
      return new Response(null, { status: 200 });
    }
    _seenWebhookIds.add(webhookId);
    setTimeout(() => _seenWebhookIds.delete(webhookId), SEEN_TTL_MS).unref?.();
  }

  // Fire-and-forget so Shopify gets 200 fast. Errors inside the
  // promise are logged but don't affect the webhook response.
  processOrder({ shop, payload }).catch((err) => {
    console.error(
      `[webhooks.orders.create] processing order ${payload?.id} failed:`,
      err?.message || err,
    );
  });

  return new Response(null, { status: 200 });
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

  // Tag the customer with the canonical code when the order attributed and
  // we have a linked customer. Guest checkouts may have no customer — the
  // cdo_application mapping (by email) still happened inside the service.
  if (result?.attributed && result.customerGid && result.referralCode) {
    await tagCustomerWithCode(shop, result.customerGid, result.referralCode).catch((err) => {
      console.error(
        `[webhooks.orders.create] tag customer ${result.customerGid} failed:`,
        err?.message || err,
      );
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

// Returns { code, source } where source is "note_attribute" |
// "discount_code" | null — recorded on the order for attribution audit.
function extractPractitionerCode(order) {
  // 1. Preferred: the cart attribute our checkout UI extension stamps
  //    on the order before discount apply. Reliable signal even if the
  //    discount itself was later removed by another code.
  const noteAttrs = order?.note_attributes || [];
  for (const attr of noteAttrs) {
    if (attr?.name === "cdo_practitioner_code" && attr?.value) {
      const v = String(attr.value).trim();
      if (v) return { code: v, source: "note_attribute" };
    }
  }
  // 2. Fallback: scan discount_codes for one that matches the
  //    practitioner-code shape.
  const dcs = order?.discount_codes || [];
  for (const dc of dcs) {
    const c = String(dc?.code || "").trim();
    if (c && CODE_PATTERN.test(c)) return { code: c, source: "discount_code" };
  }
  return { code: null, source: null };
}

// Scan a customer's tags for a referral code carried as "CODE:<code>" or
// "REFERRAL:<code>". Returns the first match's code value, or null.
function extractCodeFromTags(tags) {
  for (const t of tags || []) {
    const m = String(t).match(TAG_CODE_PATTERN);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

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

async function tagCustomerWithCode(shop, customerGid, code) {
  const newTag = `code:${code}`;
  const { admin } = await unauthenticated.admin(shop);

  // Fetch existing tags so we don't clobber other tags
  const existing = await fetchCustomerTags(shop, customerGid);

  if (existing.includes(newTag)) {
    console.log(`[webhooks.orders.create] tag "${newTag}" already on ${customerGid}`);
    return;
  }

  const updRes = await admin.graphql(
    `mutation TagCustomer($input: CustomerInput!) {
      customerUpdate(input: $input) {
        customer { id tags }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input: { id: customerGid, tags: [...existing, newTag] },
      },
    },
  );
  const updData = await updRes.json();
  const errs = updData?.data?.customerUpdate?.userErrors || [];
  if (errs.length) {
    throw new Error(
      `customerUpdate userErrors: ${errs.map((e) => e.message).join("; ")}`,
    );
  }
  console.log(`[webhooks.orders.create] tagged ${customerGid} with "${newTag}"`);
}

export async function loader() {
  return new Response("Method not allowed", { status: 405 });
}
