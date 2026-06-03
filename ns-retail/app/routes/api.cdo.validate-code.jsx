import connectDB from "../db/mongo.server";
import CdoPractitionerCode from "../models/cdoPractitionerCode.server";
import { authenticate } from "../shopify.server";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Same in-process rate limiter as check-email
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

// POST /api/cdo/validate-code   (called via Shopify app proxy from the
// retail storefront signup form when the user clicks the Verify button)
//
// Body: { code: string }
// Returns: { status, result: { valid: boolean, code?: string, practitionerName?: string } }
//   valid:true  → code exists + active. Signup form unlocks submit.
//   valid:false → code not found / inactive. Inline error.
//
// NOTE on case-insensitive lookup: the CdoPractitionerCode schema currently
// has `code: { uppercase: true }` (legacy quirk). Per the CDO Phase 1
// roadmap, codes will be lowercase like `john_xysnke25`. To accept BOTH
// formats during the migration window, we look up case-insensitively.
export async function action({ request }) {
  if (request.method !== "POST") {
    return json(405, { status: "error", message: "Method not allowed" });
  }

  const ip = getClientIp(request);
  if (!checkRateLimit(ip)) {
    return json(429, { status: "error", message: "Too many requests" });
  }

  try {
    await authenticate.public.appProxy(request);
  } catch (e) {
    return json(401, { status: "error", message: "Unauthorized" });
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

  try {
    await connectDB();
    // Case-insensitive exact match, only active codes count.
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const doc = await CdoPractitionerCode.findOne({
      code: { $regex: `^${escaped}$`, $options: "i" },
      status: "active",
    })
      .select("code practitionerName practitionerEmail")
      .lean();

    if (!doc) {
      return json(200, {
        status: "success",
        message: "Code not found",
        result: { valid: false },
      });
    }

    return json(200, {
      status: "success",
      message: "Code valid",
      result: {
        valid: true,
        code: doc.code,
        practitionerName: doc.practitionerName || null,
      },
    });
  } catch (err) {
    console.error("[api.cdo.validate-code] lookup failed:", err?.message || err);
    return json(500, { status: "error", message: "Lookup failed" });
  }
}

export async function loader() {
  return json(405, { status: "error", message: "Method not allowed" });
}
