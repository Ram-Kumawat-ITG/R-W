import { authenticate } from "../shopify.server";
import { sendResponse } from "../services/APIService/api.service";
import {
  getUnauthenticatedAdmin,
  executeGraphQL,
  executeMutation,
} from "../services/shopify/shopify.apis";
import { QUERY_CUSTOMER_TAGS } from "../services/shopify/shopify.queries";
import {
  MUTATION_CUSTOMER_DELETE,
  MUTATION_CUSTOMER_UPDATE,
} from "../services/shopify/shopify.mutations";
import { createLogger } from "../utils/logger.utils";

const log = createLogger("webhook.customers_create");

const APPROVED_TAG = "Approved";
const UNAUTHORIZED_TAG = "unauthorized_signup";

// Module-level dedup for Shopify's at-least-once webhook delivery. Same
// webhook id arriving twice within 5 minutes is skipped. Process-local —
// resets on restart, which is fine because the second-attempt scenarios
// (already-deleted customer) are idempotent and silently no-op.
const _dedupedWebhookIds = new Set();
function claimWebhook(id) {
  if (!id || _dedupedWebhookIds.has(id)) return false;
  _dedupedWebhookIds.add(id);
  setTimeout(() => _dedupedWebhookIds.delete(id), 5 * 60 * 1000);
  return true;
}

function parseTagsField(tags) {
  // Shopify webhook payloads send `tags` as a comma-separated string
  // (e.g. "Approved, VIP"). Convert to a clean array of trimmed strings.
  if (Array.isArray(tags))
    return tags.map((t) => String(t).trim()).filter(Boolean);
  return String(tags || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function hasTag(tags, target) {
  const t = target.toLowerCase();
  return tags.some((x) => String(x).trim().toLowerCase() === t);
}

export const loader = async () => {
  return new Response(
    JSON.stringify({
      route: "/webhooks/customers/create",
      status: "alive — POST a Shopify customers/create webhook here",
      method_expected: "POST",
    }),
    {
      status: 405,
      headers: { "Content-Type": "application/json", Allow: "POST" },
    },
  );
};

export const action = async ({ request }) => {
  const webhookId = request.headers.get("x-shopify-webhook-id") || "";
  console.log(
    `\n[webhook] customers/create POST received at ${new Date().toISOString()}`,
  );
  console.log(`[webhook]   webhook-id: ${webhookId || "(missing)"}`);

  let topic, shop, payload;
  try {
    const result = await authenticate.webhook(request);
    topic = result.topic;
    shop = result.shop;
    payload = result.payload;
  } catch (err) {
    console.log(`[webhook] HMAC verification failed: ${err?.message || err}`);
    log.error("auth.failed", { err: err?.message || String(err) });
    return new Response("Unauthorized", { status: 401 });
  }

  if (topic !== "CUSTOMERS_CREATE") {
    log.warn("topic.unexpected", { topic });
    return sendResponse(400, "error", "Invalid webhook topic", null);
  }

  if (!claimWebhook(webhookId)) {
    log.info("dedup.skipped", { webhookId });
    return new Response(null, { status: 200 });
  }

  const customerId = payload?.id;
  const customerEmail = payload?.email;
  const payloadTags = parseTagsField(payload?.tags);
  const hasApprovedAtCreation = hasTag(payloadTags, APPROVED_TAG);

  log.info("received", {
    shop,
    customerId,
    email: customerEmail,
    tags: payloadTags,
    hasApprovedTag: hasApprovedAtCreation,
  });

  if (!customerId) {
    log.warn("payload.missing_id", { payload });
    return sendResponse(400, "error", "Missing customer id", null);
  }

  // Fast path: tag was set at creation (our registration form). Keep customer.
  if (hasApprovedAtCreation) {
    console.log(
      `[webhook] customer ${customerId} created with Approved tag — keeping`,
    );
    log.info("kept.has_approved_at_creation", {
      customerId,
      email: customerEmail,
    });
    return new Response(null, { status: 200 });
  }

  // No tag at creation. Fire-and-forget the cleanup so the webhook response
  // returns 200 to Shopify immediately. Any failures are logged.
  (async () => {
    try {
      const { admin } = await getUnauthenticatedAdmin(shop);
      const customerGid = `gid://shopify/Customer/${customerId}`;

      // Live re-fetch — the customer may have been tagged Approved between
      // creation and this webhook arriving (rare but possible race).
      const json = await executeGraphQL(admin, QUERY_CUSTOMER_TAGS, {
        id: customerGid,
      });
      const live = json?.data?.customer;
      if (!live) {
        log.warn("customer.not_found_on_refetch", {
          customerId,
          email: customerEmail,
        });
        return;
      }

      const liveTags = Array.isArray(live.tags) ? live.tags : [];
      if (hasTag(liveTags, APPROVED_TAG)) {
        console.log(
          `[webhook] customer ${customerId} now has Approved tag (added between creation + webhook) — keeping`,
        );
        log.info("kept.approved_added_late", {
          customerId,
          email: customerEmail,
        });
        return;
      }

      const orderCount = Number(live.numberOfOrders || 0);
      const stillNoApprovedTag = !hasTag(liveTags, APPROVED_TAG);

      if (orderCount === 0 && stillNoApprovedTag) {
        // Safe to delete — no orders attached.
        const { userErrors } = await executeMutation(
          admin,
          MUTATION_CUSTOMER_DELETE,
          { id: customerGid },
          "customerDelete",
        );
        if (userErrors.length) {
          console.error(
            `[webhook] customerDelete userErrors for ${customerId}:`,
            userErrors,
          );
          log.error("delete.user_errors", {
            customerId,
            email: customerEmail,
            userErrors,
          });
          return;
        }
        console.log(
          `[webhook] deleted unauthorized customer ${customerId} (0 orders, email=${customerEmail})`,
        );
        log.info("deleted.unauthorized", {
          customerId,
          email: customerEmail,
        });
        return;
      }

      // Customer has orders — DO NOT auto-cancel or delete. Tag for admin review.
      if (hasTag(liveTags, UNAUTHORIZED_TAG)) {
        console.log(
          `[webhook] customer ${customerId} already flagged unauthorized — no-op`,
        );
        log.info("flag.already_present", { customerId });
        return;
      }
      const nextTags = Array.from(new Set([...liveTags, UNAUTHORIZED_TAG]));
      const { userErrors } = await executeMutation(
        admin,
        MUTATION_CUSTOMER_UPDATE,
        { input: { id: customerGid, tags: nextTags } },
        "customerUpdate",
      );
      if (userErrors.length) {
        console.error(
          `[webhook] customerUpdate (flag) userErrors for ${customerId}:`,
          userErrors,
        );
        log.error("flag.user_errors", {
          customerId,
          email: customerEmail,
          userErrors,
        });
        return;
      }
      console.log(
        `[webhook] customer ${customerId} has ${orderCount} orders — flagged "${UNAUTHORIZED_TAG}" for admin review`,
      );
      log.warn("flagged.has_orders", {
        customerId,
        email: customerEmail,
        orderCount,
      });
    } catch (err) {
      console.error(
        `[webhook] customers/create cleanup failed for ${customerId}:`,
        err?.stack || err,
      );
      log.error("cleanup.failed", {
        customerId,
        email: customerEmail,
        err: err?.message || String(err),
      });
    }
  })();

  // Return 200 immediately so Shopify doesn't retry while we run the cleanup.
  return new Response(null, { status: 200 });
};
