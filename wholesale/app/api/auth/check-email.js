import { authenticate } from "../../shopify.server";
import {
  sendResponse,
  ok,
  badRequest,
  methodNotAllowed,
  unauthorized,
  serverError,
} from "../../services/APIService/api.service";
import { QUERY_CUSTOMER_BY_EMAIL } from "../../services/shopify/shopify.queries";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("api.auth.check_email");

// Simple in-memory rate limiter — 10 requests/min/IP. Resets on process
// restart (acceptable for single-instance deploys; move to Redis/Mongo if
// horizontally scaled).
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const APPROVED_TAG = "Approved";

// POST /api/auth/check-email   (storefront proxied via /apps/wholesale-application/...)
//
// Body: { email: string }
// Returns: { exists: boolean, status: 'approved'|null }
//
// Verification is tag-based — only customers tagged "Approved" in Shopify
// are considered registered wholesale customers. Customers without the tag
// are treated as new (they'll be deleted by the customers/create webhook
// shortly after creation if they didn't come through the registration form).
//
// Frontend branches on this:
//   exists:false                 → registration form
//   exists:true                  → Shopify OTP login URL (with login_hint)
export async function action({ request }) {
  if (request.method !== "POST") return methodNotAllowed();

  const ip = getClientIp(request);
  if (!checkRateLimit(ip)) {
    log.warn("rate_limit.exceeded", { ip });
    return sendResponse(429, "error", "Too many requests", null);
  }

  let admin;
  try {
    const auth = await authenticate.public.appProxy(request);
    admin = auth.admin;
  } catch (e) {
    log.error("auth.failed", { err: e?.message || String(e) });
    return unauthorized();
  }

  if (!admin) {
    log.error("admin_client.unavailable");
    return serverError("Admin client unavailable");
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid JSON payload");
  }

  const email = String(body?.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return badRequest("Invalid email format");
  }

  try {
    const res = await admin.graphql(QUERY_CUSTOMER_BY_EMAIL, {
      variables: { q: `email:${email}` },
    });
    const json = await res.json();
    const found = json?.data?.customers?.edges?.[0]?.node;

    if (!found) {
      log.info("not_found", { email });
      return ok("Not found", { exists: false, status: null });
    }

    const tags = Array.isArray(found.tags) ? found.tags : [];
    const hasApprovedTag = tags.some(
      (t) => String(t).trim().toLowerCase() === APPROVED_TAG.toLowerCase(),
    );

    if (!hasApprovedTag) {
      // Customer exists in Shopify but doesn't have the Approved tag.
      // Treat as new — they probably tried to log in via Shopify OTP directly
      // (bypassing the registration form). The customers/create webhook will
      // delete this customer shortly. Send them through the registration form.
      log.info("found.no_approved_tag", { email, tags });
      return ok("Not found (no approved tag)", {
        exists: false,
        status: null,
      });
    }

    log.info("found.approved", { email });
    return ok("Found", {
      exists: true,
      status: "approved",
    });
  } catch (err) {
    log.error("lookup.failed", { email, err: err?.message || String(err) });
    return serverError("Lookup failed");
  }
}

export async function loader() {
  return methodNotAllowed();
}
