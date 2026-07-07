// Wholesale customers/update webhook → one-way sync to retail Shopify.
//
// Fires whenever a wholesale Shopify customer is updated (via admin UI,
// customer account, or any of our app's API endpoints). We look up the
// matching WholesaleApplication; if it exists, the customer is a
// practitioner and we push the minimal-field update (firstName, lastName,
// email, phone) to their retail Shopify customer mirror.
//
// Best-effort — Shopify webhook returns 200 immediately so retries aren't
// triggered by retail-side blips. The retail sync runs fire-and-forget.

import { authenticate } from "../shopify.server";
import { sendResponse } from "../services/APIService/api.service";
import { createLogger } from "../utils/logger.utils";
import connectDB from "../services/APIService/mongo.service";
import WholesaleApplication from "../models/wholesaleApplication.server";
import { syncPractitionerToRetail } from "../services/retailSync/practitioner.service";

const log = createLogger("webhook.customers_update");

// Same module-level dedup pattern as customers/create. Shopify delivers
// at-least-once; the same webhook id within 5 minutes is a duplicate.
const _dedupedWebhookIds = new Set();
function claimWebhook(id) {
  if (!id || _dedupedWebhookIds.has(id)) return false;
  _dedupedWebhookIds.add(id);
  setTimeout(() => _dedupedWebhookIds.delete(id), 5 * 60 * 1000);
  return true;
}

export const loader = async () => {
  return new Response(
    JSON.stringify({
      route: "/webhooks/customers/update",
      status: "alive — POST a Shopify customers/update webhook here",
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
    `\n[webhook] customers/update POST received at ${new Date().toISOString()}`,
  );

  let topic, shop, payload;
  try {
    const result = await authenticate.webhook(request);
    topic = result.topic;
    shop = result.shop;
    payload = result.payload;
  } catch (err) {
    log.error("auth.failed", { err: err?.message || String(err) });
    return new Response("Unauthorized", { status: 401 });
  }

  if (topic !== "CUSTOMERS_UPDATE") {
    log.warn("topic.unexpected", { topic });
    return sendResponse(400, "error", "Invalid webhook topic", null);
  }

  if (!claimWebhook(webhookId)) {
    log.info("dedup.skipped", { webhookId });
    return new Response(null, { status: 200 });
  }

  const customerId = payload?.id;
  const customerEmail = payload?.email;

  log.info("received", {
    shop,
    customerId,
    email: customerEmail,
  });

  if (!customerId) {
    log.warn("payload.missing_id", { payload });
    return sendResponse(400, "error", "Missing customer id", null);
  }

  // Fire-and-forget — return 200 immediately so Shopify doesn't retry.
  (async () => {
    try {
      await connectDB();
      const customerGid = `gid://shopify/Customer/${customerId}`;
      const application = await WholesaleApplication.findOne({
        customerId: customerGid,
        shop,
      }).lean();
      if (!application) {
        log.info("retail_sync.skip_non_practitioner", {
          customerId,
          email: customerEmail,
        });
        return;
      }

      // ⚠️ DISABLED (2026-07-06) — wholesale → retail practitioner mirror
      // was turned off per the product decision that wholesale
      // practitioners should NOT auto-create ns-retail customers. See
      // the banner in webhooks.customers.create.jsx for the full
      // rationale + re-enable steps.
      log.info("retail_sync.update_skipped_disabled", {
        customerId,
        email: customerEmail,
      });

      // ── Original implementation (preserved) ───────────────────────
      // Apply any incoming changes from the Shopify payload to the
      // in-memory WholesaleApplication snapshot before syncing — the
      // Mongo doc may not have been refreshed for an admin-UI edit.
      //
      // const merged = {
      //   ...application,
      //   firstName: payload.first_name || application.firstName,
      //   lastName: payload.last_name || application.lastName,
      //   email: payload.email || application.email,
      //   phone: payload.phone || application.phone,
      // };
      //
      // await syncPractitionerToRetail({
      //   application: merged,
      //   action: "update",
      // });
    } catch (err) {
      log.error("retail_sync.update_failed", {
        customerId,
        email: customerEmail,
        err: err?.message || String(err),
      });
    }
  })();

  return new Response(null, { status: 200 });
};
