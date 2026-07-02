// POST /api/cdo/checkout-apply-code
//
// Called by the Shopify checkout UI extension when a valid referral code is
// applied to the cart. This endpoint immediately tags the Shopify customer
// with the referral code so the tag becomes the default for future orders.
//
// Similar to checkout-validate-code: public, CORS-enabled, rate-limited,
// intentionally minimal surface (validates + tags, no secrets exposed).
//
// Request body:
//   code: string (required) — the referral code
//   email: string (optional) — customer email for lookup
//   shopifyCustomerId: string (optional) — customer's Shopify ID (GraphQL)
//   shopifyShop: string (optional) — shop domain for tag sync
//
// Response: { status, message, result: { ok, tagged } } or error

import connectDB from "../../db/mongo.server";
import CdoPractitionerCode from "../../models/cdoPractitionerCode.server";
import {
  resolvePractitionerReferral,
  checkPatientBinding,
} from "../../services/cdo/cdo.service";
import { syncCustomerCodeTag, lookupCustomerByEmail } from "../../utils/customerTags";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

// In-memory rate limit: 10 / min / IP
const _attempts = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const entry = _attempts.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + 60_000;
  }
  entry.count += 1;
  _attempts.set(ip, entry);
  return entry.count <= 10;
}
function getClientIp(request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export async function action({ request }) {
  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return json(405, { status: "error", message: "Method not allowed" });
  }

  const ip = getClientIp(request);
  if (!checkRateLimit(ip)) {
    return json(429, { status: "error", message: "Too many requests" });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { status: "error", message: "Invalid JSON payload" });
  }

  const raw = String(body?.code || "").trim();
  if (!raw) {
    return json(400, { status: "error", message: "Code is required" });
  }

  const email = String(body?.email || "").trim().toLowerCase();
  const customerId = String(body?.customerId || "").trim();
  const shopifyCustomerId = String(body?.shopifyCustomerId || "").trim();
  const shopifyShop = String(body?.shopifyShop || "").trim();

  try {
    await connectDB();
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const doc = await CdoPractitionerCode.findOne({
      code: { $regex: `^${escaped}$`, $options: "i" },
      status: "active",
    })
      .select("code practitionerId")
      .lean();

    // Unknown / inactive code
    if (!doc) {
      return json(200, {
        status: "success",
        message: "Invalid code",
        result: {
          ok: false,
          tagged: false,
          reason: "not_found",
        },
      });
    }

    // Confirm code resolves to an eligible practitioner
    const referral = await resolvePractitionerReferral(doc.code);
    if (!referral) {
      return json(200, {
        status: "success",
        message: "Practitioner does not exist",
        result: {
          ok: false,
          tagged: false,
          reason: "practitioner_missing",
        },
      });
    }

    // Check permanent binding
    if (email || customerId) {
      const verdict = await checkPatientBinding({
        email,
        customerId,
        practitionerId: referral.practitionerId,
      });
      if (!verdict.ok) {
        return json(200, {
          status: "success",
          message: "You are already associated with another practitioner",
          result: {
            ok: false,
            tagged: false,
            reason: "bound_other",
          },
        });
      }
    }

    // Code is valid. Now tag the Shopify customer if possible.
    let tagged = false;
    let tagError = null;

    if (shopifyShop && (shopifyCustomerId || email)) {
      try {
        let gid = shopifyCustomerId;

        // If only email provided, look up the customer
        if (!gid && email) {
          gid = await lookupCustomerByEmail(shopifyShop, email);
        }

        // If we have a customer ID, tag them
        if (gid) {
          await syncCustomerCodeTag(
            shopifyShop,
            gid,
            referral.code,
            referral.practitionerEmail,
          );
          tagged = true;
          console.log(
            `[checkout-apply-code] tagged ${gid} with code ${referral.code}`,
          );
        }
      } catch (tagErr) {
        // Tag sync failed — log it but don't fail the validation
        tagError = tagErr?.message || String(tagErr);
        console.error(
          `[checkout-apply-code] tag sync failed for ${email || customerId}:`,
          tagError,
        );
        // Non-blocking: tag failure is informational only
      }
    }

    return json(200, {
      status: "success",
      message: "Code applied",
      result: {
        ok: true,
        code: referral.code,
        practitionerName: referral.practitionerName || null,
        discountPercent: referral.discountPercent || 0,
        tagged,
        tagError: tagError || null,
      },
    });
  } catch (err) {
    console.error(
      "[api.cdo.checkout-apply-code] failed:",
      err?.message || err,
    );
    return json(500, { status: "error", message: "Operation failed" });
  }
}

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return json(405, { status: "error", message: "Method not allowed" });
}
