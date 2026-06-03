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
        discountPercent: 0,
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

  return {
    codeId: String(created._id),
    code: created.code,
    alreadyExisted: false,
  };
}
