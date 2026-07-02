// POST /api/cdo/checkout-validate-code
//
// Called by the Shopify checkout UI extension's "Verify" button via
// direct fetch() — NOT through the app proxy, so we can't use
// authenticate.public.appProxy. Instead this endpoint is publicly
// reachable but rate-limited; it only returns whether a code exists and
// the practitioner's name (no secrets).
//
// CORS-enabled because checkout extensions are served from
// shop1.myshopify.com / checkout.shopify.com origins, which are
// different from our app's domain.
//
// For production hardening, layer in session-token verification via
// authenticate.public.checkout(request) once Shopify's review approves
// our app's network_access — but the surface here is intentionally
// minimal (one read, public-knowable info only) so even without that
// extra auth the risk is bounded.

import connectDB from "../../db/mongo.server";
import CdoPractitionerCode from "../../models/cdoPractitionerCode.server";
import {
  resolvePractitionerReferral,
  checkPatientBinding,
} from "../../services/cdo/cdo.service";

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

// In-memory rate limit: 10 / min / IP. Same pattern as the other
// validate-code endpoint; trades multi-instance correctness for
// zero-dep simplicity.
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
  // Buyer identity — used to enforce the permanent patient↔practitioner
  // binding. Either is sufficient; both are best-effort. A guest checkout
  // without PCD level-2 email access sends neither, in which case the
  // checkout-time binding check is skipped (order ingest still attributes
  // server-side to the already-bound practitioner).
  const email = String(body?.email || "").trim().toLowerCase();
  const customerId = String(body?.customerId || "").trim();

  try {
    await connectDB();
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const doc = await CdoPractitionerCode.findOne({
      code: { $regex: `^${escaped}$`, $options: "i" },
      status: "active",
    })
      .select("code practitionerId")
      .lean();

    // Unknown / inactive code.
    if (!doc) {
      return json(200, {
        status: "success",
        message: "Invalid Referral Code",
        result: {
          valid: false,
          reason: "not_found",
          message: "Invalid Referral Code",
        },
      });
    }

    // Code exists, but confirm it still resolves to an ELIGIBLE practitioner
    // (approved + reselling). resolvePractitionerReferral returns null when
    // the owning practitioner record is gone or no longer qualifies.
    const referral = await resolvePractitionerReferral(doc.code);
    if (!referral) {
      return json(200, {
        status: "success",
        message: "Practitioner does not exist",
        result: {
          valid: false,
          reason: "practitioner_missing",
          message: "Practitioner does not exist",
        },
      });
    }

    // Permanent-binding enforcement: a patient already associated with a
    // practitioner may only use codes belonging to that same practitioner.
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
            valid: false,
            reason: "bound_other",
            message: "You are already associated with another practitioner",
          },
        });
      }
    }

    return json(200, {
      status: "success",
      message: "Code valid",
      result: {
        valid: true,
        code: referral.code,
        practitionerName: referral.practitionerName || null,
        discountPercent:
          typeof referral.discountPercent === "number"
            ? referral.discountPercent
            : 0,
      },
    });
  } catch (err) {
    console.error(
      "[api.cdo.checkout-validate-code] lookup failed:",
      err?.message || err,
    );
    return json(500, { status: "error", message: "Lookup failed" });
  }
}

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return json(405, { status: "error", message: "Method not allowed" });
}
