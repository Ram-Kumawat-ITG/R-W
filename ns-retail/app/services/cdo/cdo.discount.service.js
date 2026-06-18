// Shopify discount writes for practitioner referral codes.
//
// A practitioner referral code is backed by a Shopify "basic code" percentage
// discount on the retail storefront — visiting https://<shop>/discount/<code>
// auto-applies it at checkout. This module owns the Admin GraphQL writes for
// those discounts (create / activate / deactivate) via the app's offline
// session (`unauthenticated.admin(shop)`).
//
// Requires the `write_discounts` scope on the installed app + a completed
// OAuth install on `shop`. All three mutations were validated against the
// Admin schema (discountCodeBasicCreate / discountCodeActivate /
// discountCodeDeactivate).
//
// Callers:
//   - cdo.portal.service.js → practitioner self-service create + pause/resume
//   - app/api/cdo-internal/create-shopify-discount.js → wholesale-registration
//     server-to-server create (shared-secret authed)

import { unauthenticated } from "../../shopify.server";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("cdo.discount.service");

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

const MUTATION_DISCOUNT_ACTIVATE = `#graphql
  mutation ActivatePractitionerDiscount($id: ID!) {
    discountCodeActivate(id: $id) {
      codeDiscountNode { id }
      userErrors { field message code }
    }
  }
`;

const MUTATION_DISCOUNT_DEACTIVATE = `#graphql
  mutation DeactivatePractitionerDiscount($id: ID!) {
    discountCodeDeactivate(id: $id) {
      codeDiscountNode { id }
      userErrors { field message code }
    }
  }
`;

// Shopify's documented shareable discount URL — visiting it applies the code.
export function buildShopifyDiscountUrl(shop, code) {
  return `https://${shop}/discount/${encodeURIComponent(code)}`;
}

// `unauthenticated.admin` expects a bare shop domain (no protocol).
function bareShopDomain(shop) {
  let domain = String(shop || "");
  try {
    if (/^https?:\/\//i.test(domain)) domain = new URL(domain).host;
  } catch {
    /* use as-is */
  }
  return domain;
}

function isDuplicateError(userErrors) {
  return userErrors.some((e) =>
    String(e?.message || "")
      .toLowerCase()
      .includes("already exists"),
  );
}

/**
 * Create a basic percentage code discount on `shop` for a practitioner code.
 *
 * @param {object} args
 * @param {string} args.shop              retail shop domain (xxx.myshopify.com)
 * @param {string} args.code              the referral code (e.g. "john_a3f1c8e2")
 * @param {number} args.discountPercent   fraction, e.g. 0.10 for 10%
 * @param {string} [args.practitionerName] admin-readable title hint
 * @returns {Promise<
 *   | { ok: true,  duplicate: false, shopifyDiscountId: string|null, shopifyDiscountUrl: string }
 *   | { ok: true,  duplicate: true,  shopifyDiscountId: null,        shopifyDiscountUrl: string }
 *   | { ok: false, error: string, userErrors?: Array }
 * >}
 *   `duplicate: true` means the code already exists on Shopify (the discount is
 *   usable, but we didn't create it — the caller decides whether that's a soft
 *   success or a conflict).
 */
export async function createShopifyDiscount({
  shop,
  code,
  discountPercent,
  practitionerName,
}) {
  const shopDomain = bareShopDomain(shop);
  if (!shopDomain) return { ok: false, error: "shop required" };
  if (!code) return { ok: false, error: "code required" };
  if (
    !Number.isFinite(discountPercent) ||
    discountPercent <= 0 ||
    discountPercent > 1
  ) {
    return {
      ok: false,
      error:
        "discountPercent must be a fraction between 0 and 1 (e.g. 0.10 for 10%)",
    };
  }

  let admin;
  try {
    ({ admin } = await unauthenticated.admin(shopDomain));
  } catch (err) {
    log.error("admin_context_failed", {
      shop: shopDomain,
      err: err?.message || String(err),
    });
    return { ok: false, error: "Could not obtain admin context for retail shop" };
  }

  const title = practitionerName
    ? `Practitioner code (${practitionerName}) — ${code}`
    : `Practitioner code — ${code}`;

  const input = {
    title,
    code,
    startsAt: new Date().toISOString(),
    customerSelection: { all: true },
    customerGets: {
      value: { percentage: discountPercent },
      items: { all: true },
    },
    // Reusable across customers + orders — referrals need unlimited reuse.
    usageLimit: null,
    appliesOncePerCustomer: false,
  };

  try {
    const res = await admin.graphql(MUTATION_DISCOUNT_CREATE, {
      variables: { basicCodeDiscount: input },
    });
    const data = await res.json();
    if (data?.errors?.length) {
      log.error("create.graphql_errors", {
        code,
        errors: JSON.stringify(data.errors).slice(0, 300),
      });
      return { ok: false, error: "Discount creation failed" };
    }
    const userErrors = data?.data?.discountCodeBasicCreate?.userErrors || [];
    if (userErrors.length) {
      if (isDuplicateError(userErrors)) {
        log.info("create.duplicate", { shop: shopDomain, code });
        return {
          ok: true,
          duplicate: true,
          shopifyDiscountId: null,
          shopifyDiscountUrl: buildShopifyDiscountUrl(shopDomain, code),
        };
      }
      return {
        ok: false,
        error: userErrors.map((e) => e.message).join("; "),
        userErrors,
      };
    }

    const shopifyDiscountId =
      data?.data?.discountCodeBasicCreate?.codeDiscountNode?.id || null;
    log.info("create.ok", { shop: shopDomain, code, discountPercent, shopifyDiscountId });
    return {
      ok: true,
      duplicate: false,
      shopifyDiscountId,
      shopifyDiscountUrl: buildShopifyDiscountUrl(shopDomain, code),
    };
  } catch (err) {
    log.error("create.threw", { code, err: err?.message || String(err) });
    return { ok: false, error: "Discount creation failed" };
  }
}

/**
 * Activate or deactivate an existing discount by its node id. Deactivating
 * makes the storefront link stop applying the code (used when a practitioner
 * pauses a referral code); activating re-enables it (resume).
 *
 * @param {object} args
 * @param {string} args.shop        retail shop domain
 * @param {string} args.discountId  gid://shopify/DiscountCodeNode/... (shopifyDiscountId)
 * @param {boolean} args.active     true → activate, false → deactivate
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function setShopifyDiscountActive({ shop, discountId, active }) {
  const shopDomain = bareShopDomain(shop);
  if (!shopDomain) return { ok: false, error: "shop required" };
  if (!discountId) return { ok: false, error: "discountId required" };

  let admin;
  try {
    ({ admin } = await unauthenticated.admin(shopDomain));
  } catch (err) {
    log.error("admin_context_failed", {
      shop: shopDomain,
      err: err?.message || String(err),
    });
    return { ok: false, error: "Could not obtain admin context for retail shop" };
  }

  const mutation = active
    ? MUTATION_DISCOUNT_ACTIVATE
    : MUTATION_DISCOUNT_DEACTIVATE;
  const field = active ? "discountCodeActivate" : "discountCodeDeactivate";

  try {
    const res = await admin.graphql(mutation, {
      variables: { id: discountId },
    });
    const data = await res.json();
    if (data?.errors?.length) {
      log.error("toggle.graphql_errors", {
        discountId,
        active,
        errors: JSON.stringify(data.errors).slice(0, 300),
      });
      return { ok: false, error: "Discount update failed" };
    }
    const userErrors = data?.data?.[field]?.userErrors || [];
    if (userErrors.length) {
      return { ok: false, error: userErrors.map((e) => e.message).join("; ") };
    }
    log.info("toggle.ok", { shop: shopDomain, discountId, active });
    return { ok: true };
  } catch (err) {
    log.error("toggle.threw", {
      discountId,
      active,
      err: err?.message || String(err),
    });
    return { ok: false, error: "Discount update failed" };
  }
}
