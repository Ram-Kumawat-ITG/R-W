// Wholesale customers/delete webhook → one-way sync to retail Shopify.
//
// Two responsibilities, in order:
//   1. SOFT-DELETE the practitioner mirror on retail BEFORE removing the
//      Mongo doc — we need retailShopifyCustomerId, which lives there.
//      Soft-delete = remove the wholesale-Practitioner tag and add the
//      archived-practitioner tag. The retail customer record stays so any
//      retail order history they have as a patient is preserved.
//   2. Delete the WholesaleApplication doc.
//
// If the retail-side sync fails, we still delete the Mongo doc — leaving
// an orphan retail mirror is preferable to leaving a stale wholesale
// record. Admin can clean up the orphan manually if needed.

import { authenticate } from "../shopify.server";
import connectDB from "../services/APIService/mongo.service";
import WholesaleApplication from "../models/wholesaleApplication.server";
import { sendResponse } from "../services/APIService/api.service";
import { syncPractitionerToRetail } from "../services/retailSync/practitioner.service";
import { createLogger } from "../utils/logger.utils";

const log = createLogger("webhook.customers_delete");

export async function action({ request }) {
  console.log("[webhooks/customers/delete] received webhook");
  const { topic, shop, payload } = await authenticate.webhook(request);
  if (topic !== "CUSTOMERS_DELETE") {
    return sendResponse(400, "error", "Invalid webhook topic", null);
  }

  await connectDB();

  const customerId = "gid://shopify/Customer/" + payload.id;
  const application = await WholesaleApplication.findOne({
    customerId,
    shop,
  }).lean();

  if (application) {
    // ⚠️ DISABLED (2026-07-06) — wholesale → retail practitioner mirror
    // was turned off per the product decision that wholesale
    // practitioners should NOT auto-create ns-retail customers. See
    // the banner in webhooks.customers.create.jsx for the full
    // rationale + re-enable steps. The Mongo doc is still deleted
    // below (step 2) so wholesale-side state stays clean.
    log.info("retail_sync.delete_skipped_disabled", {
      customerId,
      applicationId: String(application._id),
    });

    // ── Original implementation (preserved) ─────────────────────────
    // 1. Soft-delete on retail BEFORE removing the Mongo doc.
    // try {
    //   await syncPractitionerToRetail({ application, action: "delete" });
    // } catch (err) {
    //   log.error("retail_sync.delete_failed", {
    //     customerId,
    //     applicationId: String(application._id),
    //     err: err?.message || String(err),
    //   });
    //   // Continue — see file header.
    // }
  } else {
    log.info("no_application_found_for_delete", { customerId });
  }

  // 2. Now delete the Mongo doc.
  await WholesaleApplication.deleteOne({ customerId, shop });

  return sendResponse(200, "success", "Customer deleted successfully", null);
}
