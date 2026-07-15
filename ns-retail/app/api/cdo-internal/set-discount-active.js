import { setShopifyDiscountActive } from "../../services/cdo/cdo.discount.service";

// POST /api/cdo-internal/set-discount-active
//
// Server-to-server endpoint called by the wholesale app's
// `setReferralCodeStatus()` to activate (resume) a practitioner discount.
//
// WHY THIS EXISTS: wholesale used to call `discountCodeActivate`/
// `discountCodeDeactivate` directly against the retail store's Admin API
// using its own static access token (a separate Shopify app installation
// from ns-retail's). That works fine for `discountCodeDeactivate`, but
// `discountCodeActivate` on a Function-backed discount (see
// cdo.discount.service.js) FAILS with "Code discount activation has
// failed." when called from any app other than the one that owns the
// discount's Function — confirmed via live testing 2026-07-08. Reactivating
// (and creating — see create-shopify-discount.js) a Function-backed
// discount must go through the OWNING app's own authenticated session,
// i.e. ns-retail's, hence this cross-app hop.
//
// Wholesale's deactivate (pause) call is UNCHANGED and still goes direct —
// only activate (resume) needed to move here.
//
// Auth: shared secret `RETAIL_SYNC_SECRET` (same pattern as
// create-shopify-discount.js).
//
// Body:
//   {
//     discountId  string  — gid://shopify/DiscountCodeNode/... (shopifyDiscountId)
//     shop        string  — retail Shopify shop domain (xxx.myshopify.com)
//   }
//
// Returns:
//   { status: 'success' } or { status: 'error', message }.

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function action({ request }) {
  if (request.method !== "POST") {
    return json(405, { status: "error", message: "Method not allowed" });
  }

  // ── Auth (shared secret) ──────────────────────────────────────────
  const expectedSecret =
    // eslint-disable-next-line no-undef
    process.env.RETAIL_SYNC_SECRET || "";
  const incomingSecret = request.headers.get("x-sync-secret") || "";
  if (!expectedSecret || incomingSecret !== expectedSecret) {
    console.warn("[cdo-internal/set-discount-active] auth failed");
    return json(401, { status: "error", message: "Unauthorized" });
  }

  // ── Parse + validate body ─────────────────────────────────────────
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { status: "error", message: "Invalid JSON payload" });
  }

  const discountId = String(body?.discountId || "").trim();
  const shop = String(body?.shop || "").trim();

  if (!discountId) {
    return json(400, { status: "error", message: "discountId required" });
  }
  if (!shop) {
    return json(400, { status: "error", message: "shop required" });
  }

  const result = await setShopifyDiscountActive({ shop, discountId, active: true });

  if (result.ok) {
    return json(200, { status: "success", message: "Discount activated" });
  }
  return json(500, {
    status: "error",
    message: result.error || "Discount activation failed",
  });
}

export async function loader() {
  return json(405, { status: "error", message: "Method not allowed" });
}
