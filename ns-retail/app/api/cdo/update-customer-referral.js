/* eslint-env node */
// Update a customer's referral code assignment and sync Shopify customer tags.
//
// POST /api/cdo/update-customer-referral
//   customerId: ObjectId string          (required)
//   newReferralCode: string              (required — new code to assign)
//   shopifyCustomerId: string            (optional — GraphQL ID to sync tags)
//   shop: string                         (optional — used for code validation)
//
// Response: { ok: true, customer: {...} } or { ok: false, error: "message" }

import { authenticate } from "../../shopify.server";
import { updateApplicationReferral } from "../../services/cdo/cdo.service";
import { lookupCustomerByEmail } from "../../utils/customerTags";
import { syncPatientCode } from "../../utils/patientCode";
import connectDB from "../../db/mongo.server";

export async function action({ request }) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const { session } = await authenticate.admin(request);
    const actor = session?.onlineAccessInfo?.associated_user?.email || session?.shop || "admin";

    const body = await request.json();
    const { customerId, newReferralCode, shopifyCustomerId, shop } = body;

    if (!customerId || !newReferralCode) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "customerId and newReferralCode are required",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    await connectDB();
    const updated = await updateApplicationReferral({
      customerId,
      newReferralCode,
      actor,
      shop: shop || session?.shop,
    });

    // Sync Shopify customer tags
    let targetShopifyCustomerId = shopifyCustomerId;
    if (!targetShopifyCustomerId && updated.email) {
      // Look up the customer by email if ID not provided
      try {
        targetShopifyCustomerId = await lookupCustomerByEmail(
          shop || session?.shop,
          updated.email,
        );
      } catch (err) {
        console.error(
          `[api/cdo/update-customer-referral] customer lookup failed for ${updated.email}:`,
          err?.message || err,
        );
      }
    }

    if (targetShopifyCustomerId && updated.referral?.code) {
      // Write BOTH the code: tag AND the cdo.active_code metafield together
      // (this endpoint previously set only the tag, which left the Function's
      // enforcement metafield stale → the code would be declined at checkout).
      const sync = await syncPatientCode(
        shop || session?.shop,
        targetShopifyCustomerId,
        updated.referral.code,
        { practitionerEmail: updated.referral?.practitionerEmail },
      );
      if (!sync.ok) {
        console.error(
          `[api/cdo/update-customer-referral] Shopify code sync for ${targetShopifyCustomerId} incomplete (${sync.reason}) — tag/metafield may be out of sync.`,
        );
        // Non-blocking: sync failure doesn't fail the referral update.
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        customer: {
          id: updated._id.toString(),
          email: updated.email,
          name: `${updated.firstName || ""} ${updated.lastName || ""}`.trim(),
          referralCode: updated.referral?.code || null,
          discountPercent: updated.referral?.discountPercent ?? 0,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[api/cdo/update-customer-referral] error:", error?.message || error);
    return new Response(
      JSON.stringify({
        ok: false,
        error: error?.message || "Failed to update customer referral",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
}
