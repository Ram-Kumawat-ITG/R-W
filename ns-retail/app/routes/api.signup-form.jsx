import connectDB from "../db/mongo.server";
import CdoPractitionerCode from "../models/cdoPractitionerCode.server";
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
  try {
    const auth = await authenticate.public.appProxy(request);
    admin = auth.admin;
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
  let verifiedCode = null;
  if (rawCode) {
    try {
      await connectDB();
      const escaped = rawCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const doc = await CdoPractitionerCode.findOne({
        code: { $regex: `^${escaped}$`, $options: "i" },
        status: "active",
      })
        .select("code")
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
    } catch (err) {
      console.error(
        "[api.signup-form] code re-verify failed:",
        err?.message || err,
      );
      // Don't block signup on transient DB failure — but don't tag either
      verifiedCode = null;
    }
  }

  // ── Build the Shopify customerCreate input ──────────────────────────
  // Tags include the verified code (per user spec: "save it on customer
  // tag not in metafield"). Format: code:<the-code>. Future order webhooks
  // grep tags for `code:*` to attribute commissions.
  const tags = ["Signup-Self"];
  if (verifiedCode) {
    tags.push(`code:${verifiedCode}`);
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
      // Map Shopify's field paths back to our form fields.
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
