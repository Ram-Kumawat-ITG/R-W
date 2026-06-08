import { unauthenticated } from "../../shopify.server";

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

const MUTATION_DISCOUNT_CREATE = `#graphql
  mutation CreatePractitionerDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode {
        id
        codeDiscount {
          ... on DiscountCodeBasic {
            title
            codes(first: 1) { nodes { code } }
          }
        }
      }
      userErrors { field message code }
    }
  }
`;

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
      message: "discountPercent must be a fraction between 0 and 1 (e.g. 0.10 for 10%)",
    });
  }

  // ── Get admin client for the retail shop ───────────────────────────
  // unauthenticated.admin uses the offline session stored when the app
  // was installed on this shop. Requires a previously-completed OAuth
  // install on the target shop (which has happened in dev).
  let admin;
  try {
    const ctx = await unauthenticated.admin(shop);
    admin = ctx.admin;
  } catch (err) {
    console.error(
      "[cdo-internal/create-shopify-discount] unauthenticated.admin failed:",
      err?.message || err,
    );
    return json(500, {
      status: "error",
      message: "Could not obtain admin context for retail shop",
      detail: err?.message || String(err),
    });
  }

  // ── Build mutation input ──────────────────────────────────────────
  const startsAt = new Date().toISOString();
  const title = practitionerName
    ? `Practitioner code (${practitionerName}) — ${code}`
    : `Practitioner code — ${code}`;

  const input = {
    title,
    code,
    startsAt,
    customerSelection: { all: true },
    customerGets: {
      value: { percentage: discountPercent },
      items: { all: true },
    },
    // Reusable across customers + orders. Practitioner-driven referrals
    // need unlimited reuse, not a one-time code.
    usageLimit: null,
    appliesOncePerCustomer: false,
  };

  // ── Fire the mutation ─────────────────────────────────────────────
  try {
    const res = await admin.graphql(MUTATION_DISCOUNT_CREATE, {
      variables: { basicCodeDiscount: input },
    });
    const data = await res.json();
    const errs = data?.data?.discountCodeBasicCreate?.userErrors || [];
    if (errs.length) {
      // If Shopify says the code is already taken, treat that as a soft
      // success — the discount exists, we can still compute the URL.
      const isDuplicate = errs.some((e) =>
        String(e?.message || "")
          .toLowerCase()
          .includes("already exists"),
      );
      if (isDuplicate) {
        const url = buildShopifyDiscountUrl(shop, code);
        console.log(
          `[cdo-internal/create-shopify-discount] code "${code}" already exists on Shopify, returning URL only`,
        );
        return json(200, {
          status: "success",
          message: "Code already exists on Shopify; URL returned",
          result: { shopifyDiscountId: null, shopifyDiscountUrl: url },
        });
      }
      return json(409, {
        status: "error",
        message: errs.map((e) => e.message).join("; "),
        result: { userErrors: errs },
      });
    }

    const nodeId =
      data?.data?.discountCodeBasicCreate?.codeDiscountNode?.id || null;
    const url = buildShopifyDiscountUrl(shop, code);

    console.log(
      `[cdo-internal/create-shopify-discount] created discount code="${code}" percent=${discountPercent} id=${nodeId}`,
    );

    return json(200, {
      status: "success",
      message: "Discount created",
      result: { shopifyDiscountId: nodeId, shopifyDiscountUrl: url },
    });
  } catch (err) {
    console.error(
      "[cdo-internal/create-shopify-discount] mutation threw:",
      err?.message || err,
    );
    return json(500, {
      status: "error",
      message: "Discount creation failed",
      detail: err?.message || String(err),
    });
  }
}

function buildShopifyDiscountUrl(shop, code) {
  // Shopify's documented shareable discount URL format.
  // Visiting this URL on the storefront applies the code automatically.
  return `https://${shop}/discount/${encodeURIComponent(code)}`;
}

export async function loader() {
  return json(405, { status: "error", message: "Method not allowed" });
}
