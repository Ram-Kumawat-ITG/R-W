// Shared guard for the Practitioner Portal endpoints (Theme App Extension
// version, wholesale storefront).
//
// The portal frontend is a plain fetch() from
// /apps/<PORTAL_PROXY_BASE>/api/portal/* — Shopify's App Proxy verifies the
// request signature at the edge and forwards it here with a
// `logged_in_customer_id` query param when a storefront customer is logged
// in (absent when anonymous). There is NO session-token JWT and NO CORS
// handling to do — App Proxy requests are server-to-server; the browser
// never talks directly to this app's origin.
//
// Distinct from `api/portal/profile.js` in this same directory — that
// endpoint is a different feature (Customer Account JWT-based profile
// editing) and is untouched by this guard.
//
// portalLoader/portalMutation wrap a handler so every portal request:
//   1. opens the Mongo connection,
//   2. verifies the App Proxy signature via authenticate.public.appProxy,
//   3. resolves `logged_in_customer_id` to an APPROVED practitioner, mapping
//      auth failures to the status the frontend branches on:
//        401 → not logged in (or no customer id)  → shows "sign in"
//        403 → logged in, not a practitioner       → shows "restricted"
//
// Handlers receive { ctx, url } (loaders) or { ctx, request, body }
// (mutations), where ctx.practitionerId is the trusted tenant key. They
// must scope every query by it — identity is never taken from the
// query/body.

import connectDB from "../../services/APIService/mongo.service";
import { authenticate } from "../../shopify.server";
import { resolvePractitionerByCustomerId } from "../../services/cdo/cdo.portal.service";
import {
  sendResponse,
  unauthorized,
  serverError,
  methodNotAllowed,
} from "../../services/APIService/api.service";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("api.portal");

// Shared auth + tenant resolution for every portal request (loaders AND the
// mutation action). Opens Mongo, verifies the App Proxy signature, and
// resolves `logged_in_customer_id` to an approved practitioner.
async function resolvePortalContext(request) {
  try {
    await connectDB();
  } catch (e) {
    log.error("db.connect_failed", { err: e?.message || String(e) });
    return { ok: false, response: serverError("Service temporarily unavailable") };
  }

  try {
    await authenticate.public.appProxy(request);
  } catch (e) {
    log.info("auth.app_proxy_invalid", { err: e?.message || String(e) });
    return { ok: false, response: unauthorized("Invalid request.") };
  }

  const url = new URL(request.url);
  const rawCustomerId = url.searchParams.get("logged_in_customer_id");
  const customerId = rawCustomerId ? `gid://shopify/Customer/${rawCustomerId}` : null;

  let ctx;
  try {
    ctx = await resolvePractitionerByCustomerId(customerId);
  } catch (e) {
    if (e?.code === resolvePractitionerByCustomerId.ERR_FORBIDDEN) {
      return {
        ok: false,
        response: sendResponse(
          403,
          "error",
          "Your account is not an approved practitioner.",
          null,
        ),
      };
    }
    return {
      ok: false,
      response: unauthorized("Please sign in to view your practitioner portal."),
    };
  }

  return { ok: true, ctx };
}

export function portalLoader(handler) {
  return async ({ request }) => {
    const auth = await resolvePortalContext(request);
    if (!auth.ok) return auth.response;
    const { ctx } = auth;

    try {
      const url = new URL(request.url);
      return await handler({ ctx, url });
    } catch (e) {
      log.error("handler.failed", {
        practitionerId: ctx.practitionerId,
        err: e?.message || String(e),
      });
      return serverError("Failed to load portal data");
    }
  };
}

// Mutation guard for the referral self-service write path:
// POST /api/portal/referrals. The handler receives { ctx, request, body }
// and returns a Response (use ok/badRequest/sendResponse from api.service).
// Typed validation/conflict errors should be RETURNED by the handler as the
// right status; anything THROWN becomes a 500 (mirrors portalLoader).
export function portalMutation(handler) {
  return async ({ request }) => {
    if (request.method !== "POST") return methodNotAllowed();

    const auth = await resolvePortalContext(request);
    if (!auth.ok) return auth.response;
    const { ctx } = auth;

    let body = {};
    try {
      body = (await request.json()) || {};
    } catch {
      body = {};
    }

    try {
      return await handler({ ctx, request, body });
    } catch (e) {
      log.error("mutation.failed", {
        practitionerId: ctx.practitionerId,
        err: e?.message || String(e),
      });
      return serverError("Failed to process your request");
    }
  };
}

export function pageParams(url) {
  return {
    page: url.searchParams.get("page"),
    pageSize: url.searchParams.get("pageSize"),
  };
}

export function dateRangeParams(url) {
  return {
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
  };
}
