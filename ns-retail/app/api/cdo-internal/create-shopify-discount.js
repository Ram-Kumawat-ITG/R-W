import { createShopifyDiscount } from "../../services/cdo/cdo.discount.service";

// POST /api/cdo-internal/create-shopify-discount
//
// Server-to-server endpoint called by the wholesale app's
// `generatePractitionerCode()` right after a new code is persisted to
// `cdo_practitioner_codes`. Creates a matching Shopify discount on the
// retail store via Admin GraphQL and returns its shareable URL.
//
// Wholesale then saves the URL to `cdo_practitioner_codes.shopifyDiscountUrl`
// so the practitioner dashboard can display it without re-querying Shopify.
//
// The actual Admin GraphQL write lives in the shared
// `services/cdo/cdo.discount.service.createShopifyDiscount` (also used by the
// practitioner-portal self-service create path). This endpoint is the
// shared-secret-authed transport for the cross-app (wholesale → retail) caller.
//
// Auth: shared secret `RETAIL_SYNC_SECRET` (same env var used by the
// existing /api/sync/retail-order endpoint in the reverse direction).
// Sent as `x-sync-secret` header by the caller.
//
// Body:
//   {
//     code             string  — practitioner code, e.g. "john_a3f1c8e2"
//     discountPercent  number  — fraction, e.g. 0.10 for 10%
//     practitionerName string  — for the discount title (admin-readable)
//     shop             string  — retail Shopify shop domain (xxx.myshopify.com)
//   }
//
// Returns:
//   { status: 'success', result: { shopifyDiscountId, shopifyDiscountUrl } }
//   or { status: 'error', message } with appropriate HTTP code.

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
    console.warn("[cdo-internal/create-shopify-discount] auth failed");
    return json(401, { status: "error", message: "Unauthorized" });
  }

  // ── Parse + validate body ─────────────────────────────────────────
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { status: "error", message: "Invalid JSON payload" });
  }

  const code = String(body?.code || "").trim();
  const discountPercent = Number(body?.discountPercent || 0);
  const practitionerName = String(body?.practitionerName || "").trim();
  const shop = String(body?.shop || "").trim();

  if (!code) {
    return json(400, { status: "error", message: "code required" });
  }
  if (!shop) {
    return json(400, { status: "error", message: "shop required" });
  }
  if (
    !Number.isFinite(discountPercent) ||
    discountPercent <= 0 ||
    discountPercent > 1
  ) {
    return json(400, {
      status: "error",
      message:
        "discountPercent must be a fraction between 0 and 1 (e.g. 0.10 for 10%)",
    });
  }

  // ── Delegate to the shared discount-write helper ───────────────────
  const result = await createShopifyDiscount({
    shop,
    code,
    discountPercent,
    practitionerName,
  });

  if (result.ok) {
    // duplicate === code already exists on Shopify — soft success, the caller
    // can still persist + display the shareable URL (idempotent re-runs).
    return json(200, {
      status: "success",
      message: result.duplicate
        ? "Code already exists on Shopify; URL returned"
        : "Discount created",
      result: {
        shopifyDiscountId: result.shopifyDiscountId,
        shopifyDiscountUrl: result.shopifyDiscountUrl,
      },
    });
  }

  // A userErrors failure is a request-level conflict (409); anything else
  // (admin-context / network / GraphQL transport) is a 500.
  const httpStatus = result.userErrors?.length ? 409 : 500;
  return json(httpStatus, {
    status: "error",
    message: result.error || "Discount creation failed",
    ...(result.userErrors ? { result: { userErrors: result.userErrors } } : {}),
  });
}

export async function loader() {
  return json(405, { status: "error", message: "Method not allowed" });
}
