// Shopify discount writes for practitioner referral codes.
//
// A practitioner referral code is backed by a Shopify APP discount (function-
// backed `DiscountCodeApp`, not a plain `DiscountCodeBasic`) on the retail
// storefront — visiting https://<shop>/discount/<code> auto-applies it at
// checkout the same way, but eligibility is decided at checkout-calculation
// time by the `practitioner-discount` Shopify Function (see
// extensions/practitioner-discount/), not by Shopify's native
// `customerSelection`. This is what makes the discount actually enforce the
// patient↔practitioner binding even when a shopper types the code directly
// into Shopify's own native discount field, a `/discount/<code>` marketing
// link, or has it applied manually in the Admin — every one of those surfaces
// routes through the same Function at calculation time.
//
// The Function reads a single JSON config metafield on the discount node
// (namespace "cdo", key "config": `{ percentage, practitionerId }`) and
// compares `practitionerId` against the buyer's `cdo.practitioner_id`
// customer metafield (see utils/practitionerMetafields.js). This module owns
// the Admin GraphQL writes for those discounts (create / activate /
// deactivate) via the app's offline session (`unauthenticated.admin(shop)`).
//
// Requires the `write_discounts` scope on the installed app + a completed
// OAuth install on `shop`, PLUS the `practitioner-discount` function
// extension deployed (`shopify app deploy`) — its resulting Function ID must
// be set as `CDO_PRACTITIONER_DISCOUNT_FUNCTION_ID` in the environment.
//
// Callers:
//   - cdo.portal.service.js → practitioner self-service create + pause/resume
//   - app/api/cdo-internal/create-shopify-discount.js → wholesale-registration
//     server-to-server create (shared-secret authed)

import { unauthenticated } from "../../shopify.server";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("cdo.discount.service");

const CONFIG_METAFIELD_NAMESPACE = "cdo";
const CONFIG_METAFIELD_KEY = "config";

const MUTATION_DISCOUNT_CREATE = `#graphql
  mutation CreatePractitionerDiscount($codeAppDiscount: DiscountCodeAppInput!) {
    discountCodeAppCreate(codeAppDiscount: $codeAppDiscount) {
      codeAppDiscount {
        discountId
        title
        codes(first: 1) { nodes { code } }
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

const MUTATION_DISCOUNT_DELETE = `#graphql
  mutation DeletePractitionerDiscount($id: ID!) {
    discountCodeDelete(id: $id) {
      deletedCodeDiscountId
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
 * Create a Function-backed percentage code discount on `shop` for a
 * practitioner code. Eligibility (does THIS buyer belong to THIS
 * practitioner?) is decided inside the `practitioner-discount` Function at
 * checkout-calculation time, not by Shopify's native `customerSelection` —
 * see the module comment above for why.
 *
 * @param {object} args
 * @param {string} args.shop              retail shop domain (xxx.myshopify.com)
 * @param {string} args.code              the referral code (e.g. "john_a3f1c8e2")
 * @param {number} args.discountPercent   fraction, e.g. 0.10 for 10%
 * @param {string} args.practitionerId    owning practitioner's id — written to
 *                                        the discount's config metafield so the
 *                                        Function can gate on it
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
  practitionerId,
  practitionerName,
}) {
  const shopDomain = bareShopDomain(shop);
  if (!shopDomain) return { ok: false, error: "shop required" };
  if (!code) return { ok: false, error: "code required" };
  if (!practitionerId) return { ok: false, error: "practitionerId required" };
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

  const functionId = process.env.CDO_PRACTITIONER_DISCOUNT_FUNCTION_ID || "";
  if (!functionId) {
    return {
      ok: false,
      error:
        "CDO_PRACTITIONER_DISCOUNT_FUNCTION_ID is not configured — deploy the practitioner-discount function extension and set its Function ID first",
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
    functionId,
    startsAt: new Date().toISOString(),
    // Order-wide percentage off, matching the old customerGets.items.all
    // behaviour. The Function computes the actual line targets/value.
    discountClasses: ["ORDER"],
    // Practitioner discounts never combine with other discounts (referrals
    // aren't meant to be doubled up with a public promo code).
    combinesWith: {
      orderDiscounts: false,
      productDiscounts: false,
      shippingDiscounts: false,
    },
    // Reusable across customers + orders — referrals need unlimited reuse.
    usageLimit: null,
    appliesOncePerCustomer: false,
    metafields: [
      {
        namespace: CONFIG_METAFIELD_NAMESPACE,
        key: CONFIG_METAFIELD_KEY,
        type: "json",
        value: JSON.stringify({ percentage: discountPercent, practitionerId: String(practitionerId) }),
      },
    ],
  };

  try {
    const res = await admin.graphql(MUTATION_DISCOUNT_CREATE, {
      variables: { codeAppDiscount: input },
    });
    const data = await res.json();
    if (data?.errors?.length) {
      log.error("create.graphql_errors", {
        code,
        errors: JSON.stringify(data.errors).slice(0, 300),
      });
      return { ok: false, error: "Discount creation failed" };
    }
    const userErrors = data?.data?.discountCodeAppCreate?.userErrors || [];
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
      data?.data?.discountCodeAppCreate?.codeAppDiscount?.discountId || null;
    log.info("create.ok", { shop: shopDomain, code, discountPercent, practitionerId, shopifyDiscountId });
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

/**
 * Permanently delete a discount by its node id. Used by the
 * migrate-practitioner-discounts script to free up a code string before
 * recreating it as a Function-backed app discount — Shopify enforces
 * globally-unique code strings, so a plain `DiscountCodeBasic` occupying a
 * code must be deleted (deactivating isn't enough) before a
 * `DiscountCodeApp` can be created with the same code.
 *
 * @param {object} args
 * @param {string} args.shop        retail shop domain
 * @param {string} args.discountId  gid://shopify/DiscountCodeNode/... (shopifyDiscountId)
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function deleteShopifyDiscount({ shop, discountId }) {
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

  try {
    const res = await admin.graphql(MUTATION_DISCOUNT_DELETE, {
      variables: { id: discountId },
    });
    const data = await res.json();
    if (data?.errors?.length) {
      log.error("delete.graphql_errors", {
        discountId,
        errors: JSON.stringify(data.errors).slice(0, 300),
      });
      return { ok: false, error: "Discount deletion failed" };
    }
    const userErrors = data?.data?.discountCodeDelete?.userErrors || [];
    if (userErrors.length) {
      return { ok: false, error: userErrors.map((e) => e.message).join("; ") };
    }
    log.info("delete.ok", { shop: shopDomain, discountId });
    return { ok: true };
  } catch (err) {
    log.error("delete.threw", {
      discountId,
      err: err?.message || String(err),
    });
    return { ok: false, error: "Discount deletion failed" };
  }
}
