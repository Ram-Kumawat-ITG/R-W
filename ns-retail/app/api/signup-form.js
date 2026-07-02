import connectDB from "../db/mongo.server";
import CdoApplication from "../models/cdoApplication.server";
import CdoPractitionerCode from "../models/cdoPractitionerCode.server";
import CdoReferral from "../models/cdoReferral.server";
import { checkPatientBinding } from "../services/cdo/cdo.service";
import { authenticate } from "../shopify.server";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const NAME_REGEX = /^[A-Za-zÀ-ÖØ-öø-ÿ' -]+$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/signup-form   (Shopify app proxy)
//
// Creates a retail Shopify customer. If practitionerCode is supplied and
// valid, the code is tagged onto the customer for downstream CDO
// attribution (e.g., orders/create webhook reads the tag and creates a
// cdoCommission record — that work lives in Phase 2 of the CDO roadmap).
//
// No password is collected — the retail store uses Shopify's passwordless
// (new) customer accounts. Shopify automatically sends an OTP activation
// email after customerCreate; the customer sets up auth on Shopify's
// hosted page.
//
// Body: { firstName, lastName, email, practitionerCode? }
// Returns: { status, result: { customerId, email } }
export async function action({ request }) {
  if (request.method !== "POST") {
    return json(405, { status: "error", message: "Method not allowed" });
  }

  let admin;
  let shopDomain = null;
  try {
    const auth = await authenticate.public.appProxy(request);
    admin = auth.admin;
    shopDomain = auth.session?.shop || auth.liquid?.shop || null;
  } catch (e) {
    return json(401, { status: "error", message: "Unauthorized" });
  }
  if (!admin) {
    return json(500, { status: "error", message: "Admin client unavailable" });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { status: "error", message: "Invalid JSON payload" });
  }

  // ── Server-side validation (defense-in-depth — same rules as frontend) ──
  const firstName = String(body?.firstName || "").trim();
  const lastName = String(body?.lastName || "").trim();
  const email = String(body?.email || "").trim().toLowerCase();
  const rawCode = String(body?.practitionerCode || "").trim();

  const fieldErrors = [];
  if (!firstName || firstName.length < 3 || !NAME_REGEX.test(firstName)) {
    fieldErrors.push({ field: "firstName", message: "Invalid first name" });
  }
  if (!lastName || lastName.length < 3 || !NAME_REGEX.test(lastName)) {
    fieldErrors.push({ field: "lastName", message: "Invalid last name" });
  }
  if (!EMAIL_REGEX.test(email)) {
    fieldErrors.push({ field: "email", message: "Invalid email" });
  }
  if (fieldErrors.length) {
    return json(400, {
      status: "error",
      message: "Validation failed",
      result: { fieldErrors },
    });
  }

  // ── Re-verify the practitioner code if provided (don't trust client) ──
  // We fetch the FULL practitioner-code doc here (not just the code string)
  // because we need its fields to build the immutable referral snapshot
  // that gets persisted on the cdo_applications row.
  let verifiedCode = null;
  let verifiedCodeDoc = null;
  if (rawCode) {
    try {
      await connectDB();
      const escaped = rawCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const doc = await CdoPractitionerCode.findOne({
        code: { $regex: `^${escaped}$`, $options: "i" },
        status: "active",
      })
        .select(
          "code practitionerId practitionerName practitionerEmail discountPercent commissionRate",
        )
        .lean();
      if (!doc) {
        return json(400, {
          status: "error",
          message: "Practitioner code is invalid",
          result: {
            fieldErrors: [
              { field: "practitionerCode", message: "Code not found" },
            ],
          },
        });
      }
      verifiedCode = doc.code;
      verifiedCodeDoc = doc;
    } catch (err) {
      console.error(
        "[api.signup-form] code re-verify failed:",
        err?.message || err,
      );
      // Don't block signup on transient DB failure — but don't tag either
      verifiedCode = null;
      verifiedCodeDoc = null;
    }
  }

  // ── Permanent patient↔practitioner binding ──────────────────────────
  // A returning patient may only sign up under the practitioner they're
  // already associated with. If this email is already bound to a DIFFERENT
  // practitioner, reject the code — the relationship is permanent. Same
  // practitioner (a different / updated code) is allowed and falls through.
  if (verifiedCodeDoc) {
    try {
      const verdict = await checkPatientBinding({
        email,
        practitionerId: verifiedCodeDoc.practitionerId
          ? String(verifiedCodeDoc.practitionerId)
          : null,
      });
      if (!verdict.ok) {
        return json(409, {
          status: "error",
          message: "You are already associated with another practitioner",
          result: {
            fieldErrors: [
              {
                field: "practitionerCode",
                message:
                  "You are already associated with another practitioner",
              },
            ],
          },
        });
      }
    } catch (err) {
      // Don't block signup on a transient binding-lookup failure.
      console.error(
        "[api.signup-form] binding check failed (non-fatal):",
        err?.message || err,
      );
    }
  }

  // ── Build the Shopify customerCreate input ──────────────────────────
  // Tags include the verified code (per user spec: "save it on customer
  // tag not in metafield"). Format: code:<the-code>. Future order webhooks
  // grep tags for `code:*` to attribute commissions.
  //
  // We ALSO tag the customer with the practitioner's bare email so the
  // admin can filter "all patients referred by drjohn@example.com" in
  // Shopify admin's customer list. Bare email (no prefix) per locked
  // decision 2026-06-04.
  const tags = ["Signup-Self"];
  if (verifiedCode) {
    tags.push(`code:${verifiedCode}`);
    if (verifiedCodeDoc?.practitionerEmail) {
      tags.push(verifiedCodeDoc.practitionerEmail);
    }
  }

  const customerInput = {
    firstName,
    lastName,
    email,
    tags,
    emailMarketingConsent: {
      marketingState: "NOT_SUBSCRIBED",
      marketingOptInLevel: null,
      consentUpdatedAt: new Date(Date.now() - 60_000).toISOString(),
    },
  };

  // No password sent — retail store uses Shopify's passwordless (new)
  // customer accounts. Shopify automatically dispatches an activation
  // email after customerCreate.

  try {
    const res = await admin.graphql(
      `mutation customerSignup($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer { id email firstName lastName tags }
          userErrors { field message }
        }
      }`,
      { variables: { input: customerInput } },
    );
    const data = await res.json();
    const userErrors = data?.data?.customerCreate?.userErrors || [];

    if (userErrors.length) {
      const mapped = userErrors.map((ue) => {
        const rawField = Array.isArray(ue.field)
          ? ue.field[ue.field.length - 1]
          : ue.field;
        let field = "email";
        if (rawField === "firstName" || rawField === "lastName") field = rawField;
        return { field, message: ue.message };
      });
      return json(409, {
        status: "error",
        message: userErrors[0].message,
        result: { fieldErrors: mapped },
      });
    }

    const customer = data?.data?.customerCreate?.customer;
    if (!customer?.id) {
      return json(500, {
        status: "error",
        message: "customerCreate returned no customer",
      });
    }

    console.log(
      `[api.signup-form] created retail customer ${customer.id} email=${email}` +
        (verifiedCode ? ` code=${verifiedCode}` : ""),
    );

    // ── Persist to cdo_applications ───────────────────────────────────
    // Patient applications live here (practitioner applications live in
    // wholesale_applications). The `referral` field is an IMMUTABLE
    // snapshot of the practitioner + discount terms at signup time —
    // even if the practitioner later edits or archives the code, this
    // patient's referral linkage stays fixed.
    //
    // Failure here is log-only: the Shopify customer is already created
    // with the code:<code> tag and the OTP invite is on its way. An
    // admin can backfill the cdo_applications row manually if needed.
    try {
      await connectDB();
      const referralSnapshot = verifiedCodeDoc
        ? {
            code: verifiedCodeDoc.code,
            codeId: String(verifiedCodeDoc._id),
            practitionerId: verifiedCodeDoc.practitionerId
              ? String(verifiedCodeDoc.practitionerId)
              : null,
            practitionerSource: "wholesale",
            practitionerName: verifiedCodeDoc.practitionerName || null,
            practitionerEmail: verifiedCodeDoc.practitionerEmail || null,
            discountPercent:
              typeof verifiedCodeDoc.discountPercent === "number"
                ? verifiedCodeDoc.discountPercent
                : 0,
            commissionRate:
              typeof verifiedCodeDoc.commissionRate === "number"
                ? verifiedCodeDoc.commissionRate
                : null,
            linkedAt: new Date(),
          }
        : null;

      const appDoc = await CdoApplication.create({
        shop: shopDomain,
        applicantType: "patient",
        firstName,
        lastName,
        email,
        billingAddress: null,
        shippingAddress: null,
        referral: referralSnapshot,
        status: "approved",
        submittedAt: new Date(),
        reviewedAt: null,
        customerId: customer.id,
      });
      console.log(
        `[api.signup-form] saved cdo_application ${appDoc._id} for ${email}` +
          (referralSnapshot ? ` referredBy=${referralSnapshot.practitionerEmail}` : ""),
      );

      // ── cdo_referrals lifecycle row ──────────────────────────────────
      // Signup with a valid code IS the conversion event in this flow
      // (the patient is now a Shopify customer attributed to the
      // practitioner). Upsert keyed on (shop, referralCode, referredEmail)
      // so the later orders/create webhook (upsertReferralConversion)
      // is idempotent — it'll just update orderId on first order.
      if (referralSnapshot) {
        try {
          const now = new Date();
          await CdoReferral.findOneAndUpdate(
            {
              shop: shopDomain,
              referralCode: referralSnapshot.code,
              referredEmail: email,
            },
            {
              $set: {
                status: "converted",
                convertedAt: now,
                referredName: `${firstName} ${lastName}`.trim(),
              },
              $setOnInsert: {
                shop: shopDomain,
                practitionerId: referralSnapshot.practitionerId,
                practitionerEmail: referralSnapshot.practitionerEmail,
                practitionerName: referralSnapshot.practitionerName,
                referralCode: referralSnapshot.code,
                referredEmail: email,
                referredAt: now,
              },
            },
            { upsert: true, new: true },
          );
          console.log(
            `[api.signup-form] cdo_referrals upserted code=${referralSnapshot.code} email=${email}`,
          );
        } catch (err) {
          console.error(
            "[api.signup-form] cdo_referrals upsert failed (non-fatal):",
            err?.message || err,
          );
        }
      }
    } catch (err) {
      console.error(
        "[api.signup-form] cdo_application save failed (non-fatal):",
        err?.message || err,
      );
    }

    return json(200, {
      status: "success",
      message: "Account created",
      result: { customerId: customer.id, email: customer.email },
    });
  } catch (err) {
    console.error(
      "[api.signup-form] customerCreate threw:",
      err?.message || err,
    );
    return json(500, {
      status: "error",
      message: "Sign up failed. Please try again.",
    });
  }
}

export async function loader() {
  return json(405, { status: "error", message: "Method not allowed" });
}
