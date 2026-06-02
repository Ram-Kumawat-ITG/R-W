import { authenticate } from "../shopify.server";

// Simple in-memory rate limiter: 10 requests / minute / IP.
// Resets on process restart. Acceptable for single-instance deploys; move
// to Redis or Mongo if horizontally scaled. Mirrors the rate-limit pattern
// in wholesale/app/api/auth/check-email.js.
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

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// POST /api/auth/check-email   (called via Shopify app proxy from the
// retail storefront signup form)
//
// Body: { email: string }
// Returns: { status, result: { exists: boolean } }
//   exists:true  → there's already a retail Shopify customer with this email
//                  (signup form blocks submit and prompts user to log in)
//   exists:false → safe to proceed with signup
export async function action({ request }) {
  if (request.method !== "POST") {
    return json(405, { status: "error", message: "Method not allowed" });
  }

  const ip = getClientIp(request);
  if (!checkRateLimit(ip)) {
    return json(429, { status: "error", message: "Too many requests" });
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

  const email = String(body?.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return json(400, { status: "error", message: "Invalid email format" });
  }

  try {
    const res = await admin.graphql(
      `query checkCustomerEmail($q: String!) {
        customers(first: 1, query: $q) {
          edges { node { id email } }
        }
      }`,
      { variables: { q: `email:${email}` } },
    );
    const data = await res.json();
    const found = data?.data?.customers?.edges?.[0]?.node;

    return json(200, {
      status: "success",
      message: found ? "Email already registered" : "Email available",
      result: { exists: Boolean(found) },
    });
  } catch (err) {
    console.error("[api.auth.check-email] lookup failed:", err?.message || err);
    return json(500, {
      status: "error",
      message: "Lookup failed",
      result: { exists: false },
    });
  }
}

export async function loader() {
  return json(405, { status: "error", message: "Method not allowed" });
}
