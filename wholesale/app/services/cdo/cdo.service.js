// CDO (Customer Development Officer / referral program) service for the
// wholesale app. Phase 1 scope: auto-generate a practitioner code at the
// end of a successful wholesale registration so new approved
// practitioners can immediately start sharing their code with retail
// patients.
//
// The code is written to `cdo_practitioner_codes` (shared MongoDB
// collection between wholesale + ns-retail) and back-linked on
// `wholesale_applications.cdoPractitionerCodeId`.
//
// Failure here MUST NOT block the registration — the customer's NMI
// vault + Shopify customer already exist by the time we get called.
// An admin can re-generate manually from the ns-retail CDO admin if
// auto-gen fails.

import crypto from "node:crypto";
import CdoPractitionerCode from "../../models/cdoPractitionerCode.server";
import WholesaleApplication from "../../models/wholesaleApplication.server";

// Default discount percentage applied to every freshly-generated practitioner
// code. Stored as a fraction (0.10 = 10%) to match cdo_settings.defaultCommissionRate.
// Admin can edit per-code later via the CDO admin UI.
const DEFAULT_DISCOUNT_PERCENT = 0.2;

// eslint-disable-next-line no-undef
const RETAIL_SHOP_DOMAIN = process.env.RETAIL_SHOP_DOMAIN || "";
// eslint-disable-next-line no-undef
const RETAIL_ADMIN_ACCESS_TOKEN = process.env.RETAIL_ADMIN_ACCESS_TOKEN || "";
const RETAIL_API_VERSION = "2025-07";

const MUTATION_DISCOUNT_CREATE = /* GraphQL */ `
  mutation CreatePractitionerDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode {
        id
        codeDiscount {
          ... on DiscountCodeBasic {
            title
            codes(first: 1) {
              nodes {
                code
              }
            }
          }
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export function buildShopifyDiscountUrl(shop, code) {
  return `https://${shop}/discount/${encodeURIComponent(code)}`;
}

const MUTATION_DISCOUNT_ACTIVATE = /* GraphQL */ `
  mutation ActivatePractitionerDiscount($id: ID!) {
    discountCodeActivate(id: $id) {
      codeDiscountNode { id }
      userErrors { field message code }
    }
  }
`;

const MUTATION_DISCOUNT_DEACTIVATE = /* GraphQL */ `
  mutation DeactivatePractitionerDiscount($id: ID!) {
    discountCodeDeactivate(id: $id) {
      codeDiscountNode { id }
      userErrors { field message code }
    }
  }
`;

function isDuplicateError(userErrors) {
  return userErrors.some((e) =>
    String(e?.message || "")
      .toLowerCase()
      .includes("already exists"),
  );
}

/**
 * Create a basic percentage code discount on the retail store for a
 * practitioner code. Direct retail Admin GraphQL call via the offline
 * access token in RETAIL_ADMIN_ACCESS_TOKEN — no HTTP hop through ns-retail.
 *
 * @param {object} args
 * @param {string} args.code
 * @param {number} args.discountPercent  fraction (0.10 = 10%)
 * @param {string} [args.practitionerName]
 * @returns {Promise<
 *   | { ok: true,  duplicate: false, shopifyDiscountId: string|null, shopifyDiscountUrl: string }
 *   | { ok: true,  duplicate: true,  shopifyDiscountId: null,        shopifyDiscountUrl: string }
 *   | { ok: false, error: string, userErrors?: Array }
 * >}
 *   `duplicate: true` means the code already exists on the retail store (the
 *   discount is usable, but we didn't create it) — callers decide whether
 *   that's a soft success or a conflict.
 */
export async function createRetailDiscount({
  code,
  discountPercent,
  practitionerName,
}) {
  if (!RETAIL_SHOP_DOMAIN || !RETAIL_ADMIN_ACCESS_TOKEN) {
    console.warn(
      "[cdo] skipping retail discount creation — RETAIL_SHOP_DOMAIN or RETAIL_ADMIN_ACCESS_TOKEN missing",
    );
    return { ok: false, error: "Retail store credentials not configured" };
  }
  if (!code) return { ok: false, error: "code required" };
  if (
    !Number.isFinite(discountPercent) ||
    discountPercent <= 0 ||
    discountPercent > 1
  ) {
    return {
      ok: false,
      error: `invalid discountPercent ${discountPercent} (expected a fraction between 0 and 1)`,
    };
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
    usageLimit: null,
    appliesOncePerCustomer: false,
  };

  try {
    const res = await fetch(
      `https://${RETAIL_SHOP_DOMAIN}/admin/api/${RETAIL_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": RETAIL_ADMIN_ACCESS_TOKEN,
        },
        body: JSON.stringify({
          query: MUTATION_DISCOUNT_CREATE,
          variables: { basicCodeDiscount: input },
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        `[cdo] retail discount create HTTP ${res.status} for "${code}": ${text.slice(0, 200)}`,
      );
      return { ok: false, error: `Retail store HTTP ${res.status}` };
    }
    const data = await res.json();
    if (data?.errors?.length) {
      console.error(
        `[cdo] retail discount GraphQL errors for "${code}":`,
        JSON.stringify(data.errors).slice(0, 300),
      );
      return { ok: false, error: "Discount creation failed" };
    }
    const errs = data?.data?.discountCodeBasicCreate?.userErrors || [];
    if (errs.length) {
      if (isDuplicateError(errs)) {
        console.log(
          `[cdo] retail discount "${code}" already exists — URL returned, no node id`,
        );
        return {
          ok: true,
          duplicate: true,
          shopifyDiscountId: null,
          shopifyDiscountUrl: buildShopifyDiscountUrl(RETAIL_SHOP_DOMAIN, code),
        };
      }
      console.error(
        `[cdo] retail discountCodeBasicCreate userErrors for "${code}":`,
        errs.map((e) => `${(e.field || []).join(".")}: ${e.message}`).join("; "),
      );
      return {
        ok: false,
        error: errs.map((e) => e.message).join("; "),
        userErrors: errs,
      };
    }
    const nodeId =
      data?.data?.discountCodeBasicCreate?.codeDiscountNode?.id || null;
    console.log(
      `[cdo] created retail discount code="${code}" percent=${discountPercent} id=${nodeId}`,
    );
    return {
      ok: true,
      duplicate: false,
      shopifyDiscountId: nodeId,
      shopifyDiscountUrl: buildShopifyDiscountUrl(RETAIL_SHOP_DOMAIN, code),
    };
  } catch (err) {
    console.error(
      `[cdo] retail discount create threw for "${code}":`,
      err?.message || err,
    );
    return { ok: false, error: "Discount creation failed" };
  }
}

/**
 * Activate or deactivate an existing retail discount by its node id. Used by
 * the Practitioner Portal's pause/resume referral-code flow. Direct retail
 * Admin GraphQL call via RETAIL_ADMIN_ACCESS_TOKEN — no HTTP hop through
 * ns-retail.
 *
 * @param {object} args
 * @param {string} args.discountId  gid://shopify/DiscountCodeNode/...
 * @param {boolean} args.active     true → activate, false → deactivate
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function setRetailDiscountActive({ discountId, active }) {
  if (!RETAIL_SHOP_DOMAIN || !RETAIL_ADMIN_ACCESS_TOKEN) {
    return { ok: false, error: "Retail store credentials not configured" };
  }
  if (!discountId) return { ok: false, error: "discountId required" };

  const mutation = active ? MUTATION_DISCOUNT_ACTIVATE : MUTATION_DISCOUNT_DEACTIVATE;
  const field = active ? "discountCodeActivate" : "discountCodeDeactivate";

  try {
    const res = await fetch(
      `https://${RETAIL_SHOP_DOMAIN}/admin/api/${RETAIL_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": RETAIL_ADMIN_ACCESS_TOKEN,
        },
        body: JSON.stringify({ query: mutation, variables: { id: discountId } }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        `[cdo] retail discount toggle HTTP ${res.status} for "${discountId}": ${text.slice(0, 200)}`,
      );
      return { ok: false, error: `Retail store HTTP ${res.status}` };
    }
    const data = await res.json();
    if (data?.errors?.length) {
      console.error(
        `[cdo] retail discount toggle GraphQL errors for "${discountId}":`,
        JSON.stringify(data.errors).slice(0, 300),
      );
      return { ok: false, error: "Discount update failed" };
    }
    const userErrors = data?.data?.[field]?.userErrors || [];
    if (userErrors.length) {
      return { ok: false, error: userErrors.map((e) => e.message).join("; ") };
    }
    console.log(`[cdo] retail discount toggle ok id=${discountId} active=${active}`);
    return { ok: true };
  } catch (err) {
    console.error(
      `[cdo] retail discount toggle threw for "${discountId}":`,
      err?.message || err,
    );
    return { ok: false, error: "Discount update failed" };
  }
}

// Strip everything that's not [a-z] from the first name so the prefix
// is deterministic. Names with diacritics ("José") collapse to "jos",
// punctuation-only names ("---") collapse to empty → fallback to
// "practitioner".
function sanitizeFirstName(input) {
  const lowered = String(input || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return lowered || "practitioner";
}

// 8 hex chars = 4 random bytes. 4 billion combinations — collisions
// extremely unlikely across a real catalog, and the per-shop unique
// index catches the rare clash via the E11000 retry loop below.
function randomHex(bytes = 4) {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Generate a referral code for a newly-approved practitioner and persist
 * it. Idempotent on `cdoPractitionerCodeId` — if the application already
 * has a code linked, returns the existing one without creating a new row.
 *
 * @param {Object} args
 * @param {string|import('mongoose').Types.ObjectId} args.applicationId - WholesaleApplication._id
 * @param {string} args.firstName - Practitioner's first name (used as code prefix)
 * @param {string} [args.lastName] - Stored as denormalized practitionerName
 * @param {string} args.email - Practitioner's email
 * @param {string} [args.shop] - Shopify shop domain (e.g., 'foo.myshopify.com')
 * @returns {Promise<{ codeId: string, code: string, alreadyExisted: boolean }>}
 */
export async function generatePractitionerCode({
  applicationId,
  firstName,
  lastName,
  email,
  shop,
}) {
  if (!applicationId) throw new Error("applicationId is required");

  // Idempotency: if this application already has a code, return it.
  // Lets us safely re-run on retried submits without duplicating.
  const existingApp = await WholesaleApplication.findById(applicationId)
    .select("cdoPractitionerCodeId cdoPractitionerCode")
    .lean();
  if (existingApp?.cdoPractitionerCodeId) {
    return {
      codeId: String(existingApp.cdoPractitionerCodeId),
      code: existingApp.cdoPractitionerCode,
      alreadyExisted: true,
    };
  }

  const prefix = sanitizeFirstName(firstName);
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim() || null;
  const maxAttempts = 5;

  let created = null;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidate = `${prefix}_${randomHex(4)}`;
    try {
      created = await CdoPractitionerCode.create({
        shop: shop || null,
        practitionerId: String(applicationId),
        practitionerEmail: email,
        practitionerName: fullName,
        code: candidate,
        isPrimary: true,
        discountPercent: DEFAULT_DISCOUNT_PERCENT,
        commissionRate: null,
        status: "active",
        createdBy: "wholesale-registration",
        updatedBy: "wholesale-registration",
      });
      break;
    } catch (err) {
      lastErr = err;
      const isDup = err?.code === 11000;
      if (!isDup || attempt === maxAttempts) {
        // Either it's a real error (schema/connection/etc), or we've
        // exhausted attempts on duplicates. Bubble up — caller logs
        // and continues, so the registration still succeeds.
        throw new Error(
          `Failed to generate practitioner code after ${attempt} attempt(s): ${err?.message || err}`,
        );
      }
      // Duplicate hex collision — try again with a fresh random suffix.
      console.warn(
        `[cdo] code "${candidate}" collided (attempt ${attempt}/${maxAttempts}), retrying`,
      );
    }
  }

  // Back-link on the WholesaleApplication doc so we can:
  //   a) skip re-generation on retried submits (idempotency above)
  //   b) look up the code from the application without a join
  await WholesaleApplication.updateOne(
    { _id: applicationId },
    {
      $set: {
        cdoPractitionerCodeId: created._id,
        cdoPractitionerCode: created.code,
      },
    },
  );

  console.log(
    `[cdo] generated practitioner code ${created.code} for application=${applicationId} email=${email}`,
  );

  // Create the matching Shopify discount object on the retail store.
  // Best-effort — failures log but don't roll back the code row. Admin
  // can re-trigger discount creation manually from the CDO admin if
  // shopifyDiscountId stays null. discountPercent is read from the row
  // we just created so a future per-tier change (10/20/30%) flows through.
  const disc = await createRetailDiscount({
    code: created.code,
    discountPercent: created.discountPercent,
    practitionerName: fullName,
  });

  if (disc.ok && (disc.shopifyDiscountId || disc.shopifyDiscountUrl)) {
    await CdoPractitionerCode.updateOne(
      { _id: created._id },
      {
        $set: {
          shopifyDiscountId: disc.shopifyDiscountId || null,
          shopifyDiscountUrl: disc.shopifyDiscountUrl || null,
        },
      },
    );
    // Reflect on the in-memory `created` doc so callers see the URL.
    created.shopifyDiscountId = disc.shopifyDiscountId || null;
    created.shopifyDiscountUrl = disc.shopifyDiscountUrl || null;
  } else if (!disc.ok) {
    console.warn(
      `[cdo] retail discount not created for auto-generated code "${created.code}": ${disc.error}`,
    );
  }

  return {
    codeId: String(created._id),
    code: created.code,
    shopifyDiscountId: created.shopifyDiscountId || null,
    shopifyDiscountUrl: created.shopifyDiscountUrl || null,
    alreadyExisted: false,
  };
}
