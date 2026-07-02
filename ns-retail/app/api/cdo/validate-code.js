import connectDB from "../../db/mongo.server";
import CdoPractitionerCode from "../../models/cdoPractitionerCode.server";
import { authenticate } from "../../shopify.server";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Same in-process rate limiter pattern as check-email.
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

// POST /api/cdo/validate-code   (Shopify app proxy → retail signup form Verify button)
//
// Body: { code: string }
// Returns: { status, result: { valid: boolean, code?: string, practitionerName?: string } }
//   valid:true  → code exists + active. Signup form unlocks submit.
//   valid:false → code not found / inactive. Inline error.
//
// Case-insensitive lookup: the CdoPractitionerCode schema currently has
// `uppercase: true` on the code field (legacy quirk). Locked CDO Phase 1
// format is lowercase like `john_xysnke25`. We accept BOTH formats during
// the migration window by looking up via regex.
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
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // ── DIAGNOSTIC: log the exact value + length + char codes so we can
    //    catch invisible characters (zero-width space, NBSP, trailing tab)
    //    when the code visibly matches in Compass but the lookup fails.
    console.log(
      `[api.cdo.validate-code] received raw="${raw}" length=${raw.length} ` +
        `charCodes=[${[...raw].map((c) => c.charCodeAt(0)).join(",")}]`,
    );

    const doc = await CdoPractitionerCode.findOne({
      code: { $regex: `^${escaped}$`, $options: "i" },
      status: "active",
    })
      .select("code practitionerName practitionerEmail status shop")
      .lean();

    // ── DIAGNOSTIC: confirm what came back. If null but a doc EXISTS in
    //    Compass with this code, the query path / connection / DB-name
    //    is wrong.
    if (!doc) {
      // Fallback diagnostic — try cross-status lookup so we can tell whether
      // the issue is "row missing entirely" vs "row exists but not active".
      const anyStatus = await CdoPractitionerCode.findOne({
        code: { $regex: `^${escaped}$`, $options: "i" },
      })
        .select("code status shop")
        .lean();
      console.log(
        `[api.cdo.validate-code] no active row for "${raw}". cross-status lookup: ` +
          (anyStatus
            ? `FOUND with status="${anyStatus.status}" shop="${anyStatus.shop}"`
            : "ALSO NULL — code is not in cdo_practitioner_codes from this app's Mongo connection"),
      );
      return json(200, {
        status: "success",
        message: "Code not found",
        result: { valid: false },
      });
    }

    console.log(
      `[api.cdo.validate-code] matched code="${doc.code}" status="${doc.status}" shop="${doc.shop}"`,
    );

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
