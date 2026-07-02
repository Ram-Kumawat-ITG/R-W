// POST /api/cdo/checkout-find-by-customer-id
//
// Called by the checkout-ui-code extension when the buyer IS a logged-in
// customer. Shopify's checkout UI extension API does NOT expose
// customer.tags directly (documented limitation flagged July 2024), so we
// query the customer's tags via Shopify Admin GraphQL from the backend.
//
// Flow:
//   1. Extension reads shopify.customer.value.id (requires PCD Level 1)
//   2. Extension POSTs { customerId, shop } here
//   3. We resolve an Admin context for the retail shop via
//      unauthenticated.admin (same pattern as other server-to-server
//      endpoints), query customer.tags, scan for a "code:<x>" tag
//   4. Re-verify the extracted code is still active in cdo_practitioner_codes
//   5. Return { found, code, practitionerName, discountPercent }
//
// CORS-enabled because the request originates from the checkout extension
// sandbox iframe (different origin from our app).

import connectDB from "../../db/mongo.server";
import CdoPractitionerCode from "../../models/cdoPractitionerCode.server";
import { unauthenticated } from "../../shopify.server";

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

// 30/min/IP — same generous limit as the email-fallback endpoint.
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

const CUSTOMER_GID_RE = /^gid:\/\/shopify\/Customer\/\d+$/;
const SHOP_DOMAIN_RE = /^[a-z0-9-]+\.myshopify\.com$/i;
const CODE_TAG_PREFIX = "code:";

const QUERY_CUSTOMER_TAGS = `#graphql
  query GetCustomerTags($id: ID!) {
    customer(id: $id) {
      id
      tags
    }
  }
`;

export async function action({ request }) {
  console.log(
    `[api.cdo.checkout-find-by-customer-id] ${request.method} hit at ${new Date().toISOString()}`,
  );
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return json(405, { status: "error", message: "Method not allowed" });
  }

  const ip = getClientIp(request);
  if (!checkRateLimit(ip)) {
    console.warn(`[api.cdo.checkout-find-by-customer-id] rate-limited ip=${ip}`);
    return json(429, { status: "error", message: "Too many requests" });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { status: "error", message: "Invalid JSON payload" });
  }

  const customerId = String(body?.customerId || "").trim();
  const shop = String(body?.shop || "").trim().toLowerCase();
  console.log(
    `[api.cdo.checkout-find-by-customer-id] lookup shop=${shop} customerId=${customerId}`,
  );

  if (!CUSTOMER_GID_RE.test(customerId)) {
    console.log(
      `[api.cdo.checkout-find-by-customer-id] invalid customerId format → found:false`,
    );
    return json(200, { status: "success", result: { found: false } });
  }
  if (!SHOP_DOMAIN_RE.test(shop)) {
    console.log(
      `[api.cdo.checkout-find-by-customer-id] invalid shop format → found:false`,
    );
    return json(200, { status: "success", result: { found: false } });
  }

  let admin;
  try {
    const ctx = await unauthenticated.admin(shop);
    admin = ctx.admin;
  } catch (err) {
    console.error(
      "[api.cdo.checkout-find-by-customer-id] unauthenticated.admin failed:",
      err?.message || err,
    );
    return json(500, {
      status: "error",
      message: "Admin context unavailable",
      result: { found: false },
    });
  }

  let tags = [];
  try {
    const res = await admin.graphql(QUERY_CUSTOMER_TAGS, {
      variables: { id: customerId },
    });
    const data = await res.json();
    if (data?.errors) {
      console.error(
        "[api.cdo.checkout-find-by-customer-id] graphql errors:",
        JSON.stringify(data.errors),
      );
      return json(500, {
        status: "error",
        message: "GraphQL query failed",
        result: { found: false },
      });
    }
    const customer = data?.data?.customer;
    if (!customer) {
      console.log(
        `[api.cdo.checkout-find-by-customer-id] customer not found in Shopify → found:false`,
      );
      return json(200, { status: "success", result: { found: false } });
    }
    tags = Array.isArray(customer.tags) ? customer.tags : [];
  } catch (err) {
    console.error(
      "[api.cdo.checkout-find-by-customer-id] graphql call failed:",
      err?.message || err,
    );
    return json(500, {
      status: "error",
      message: "Lookup failed",
      result: { found: false },
    });
  }

  const codeTag = tags.find(
    (t) => typeof t === "string" && t.toLowerCase().startsWith(CODE_TAG_PREFIX),
  );
  if (!codeTag) {
    console.log(
      `[api.cdo.checkout-find-by-customer-id] no code:* tag on customer (tags=${JSON.stringify(tags)}) → found:false`,
    );
    return json(200, { status: "success", result: { found: false } });
  }

  const extractedCode = String(codeTag).slice(CODE_TAG_PREFIX.length).trim();
  if (!extractedCode) {
    console.log(
      `[api.cdo.checkout-find-by-customer-id] code:* tag is empty → found:false`,
    );
    return json(200, { status: "success", result: { found: false } });
  }

  try {
    await connectDB();
    const escaped = extractedCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const codeDoc = await CdoPractitionerCode.findOne({
      code: { $regex: `^${escaped}$`, $options: "i" },
      status: "active",
    })
      .select("code practitionerName discountPercent")
      .lean();

    if (!codeDoc) {
      console.log(
        `[api.cdo.checkout-find-by-customer-id] tag code=${extractedCode} not active in cdo_practitioner_codes → found:false`,
      );
      return json(200, {
        status: "success",
        message: "Code from tag is no longer active",
        result: { found: false },
      });
    }

    console.log(
      `[api.cdo.checkout-find-by-customer-id] customerId=${customerId} → found:true code=${codeDoc.code} practitioner=${codeDoc.practitionerName}`,
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
      "[api.cdo.checkout-find-by-customer-id] code validation failed:",
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
