// POST /api/cdo/checkout-find-by-email
//
// Called by the checkout-ui-code extension when the buyer has typed an
// email in guest checkout but isn't authenticated, so the extension
// can't see customer.tags. We look up the email in cdo_applications
// and return the bound practitioner code (if any) so the extension
// can still auto-apply the discount.
//
// CORS-enabled because the request is made directly from the checkout
// extension's sandbox iframe — same model as checkout-validate-code.

import connectDB from "../../db/mongo.server";
import CdoApplication from "../../models/cdoApplication.server";
import CdoPractitionerCode from "../../models/cdoPractitionerCode.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// In-memory rate limit: 30 / min / IP. More generous than validate-code
// because checkout extension may call this twice per checkout (initial
// render + email change).
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
  return entry.count <= 30;
}
function getClientIp(request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function action({ request }) {
  console.log(
    `[api.cdo.checkout-find-by-email] ${request.method} hit at ${new Date().toISOString()}`,
  );
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return json(405, { status: "error", message: "Method not allowed" });
  }

  const ip = getClientIp(request);
  if (!checkRateLimit(ip)) {
    console.warn(`[api.cdo.checkout-find-by-email] rate-limited ip=${ip}`);
    return json(429, { status: "error", message: "Too many requests" });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    console.warn(`[api.cdo.checkout-find-by-email] invalid JSON`);
    return json(400, { status: "error", message: "Invalid JSON payload" });
  }

  const email = String(body?.email || "").trim().toLowerCase();
  console.log(`[api.cdo.checkout-find-by-email] lookup email=${email}`);
  if (!email || !EMAIL_RE.test(email)) {
    console.log(`[api.cdo.checkout-find-by-email] email invalid → found:false`);
    return json(200, {
      status: "success",
      result: { found: false },
    });
  }

  try {
    await connectDB();
    const app = await CdoApplication.findOne({ email })
      .select("referral")
      .lean();

    const refCode = app?.referral?.code;
    if (!refCode) {
      console.log(
        `[api.cdo.checkout-find-by-email] email=${email} → no cdo_application or no referral → found:false`,
      );
      return json(200, {
        status: "success",
        result: { found: false },
      });
    }

    // Verify the code is still active in cdo_practitioner_codes (handles
    // the case where the practitioner was blocked / code archived after
    // the binding was made — we shouldn't auto-apply a dead code).
    const escaped = String(refCode).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const codeDoc = await CdoPractitionerCode.findOne({
      code: { $regex: `^${escaped}$`, $options: "i" },
      status: "active",
    })
      .select("code practitionerName discountPercent")
      .lean();

    if (!codeDoc) {
      console.log(
        `[api.cdo.checkout-find-by-email] email=${email} bound to code=${refCode} but code is not active → found:false`,
      );
      return json(200, {
        status: "success",
        message: "Bound code is no longer active",
        result: { found: false },
      });
    }

    console.log(
      `[api.cdo.checkout-find-by-email] email=${email} → found:true code=${codeDoc.code} practitioner=${codeDoc.practitionerName}`,
    );
    return json(200, {
      status: "success",
      result: {
        found: true,
        code: codeDoc.code,
        practitionerName: codeDoc.practitionerName || null,
        discountPercent:
          typeof codeDoc.discountPercent === "number"
            ? codeDoc.discountPercent
            : 0,
      },
    });
  } catch (err) {
    console.error(
      "[api.cdo.checkout-find-by-email] lookup failed:",
      err?.message || err,
    );
    return json(500, {
      status: "error",
      message: "Lookup failed",
      result: { found: false },
    });
  }
}

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return json(405, { status: "error", message: "Method not allowed" });
}
