// Shared guard for the Client Portal endpoints (Theme App Extension,
// ns-retail storefront).
//
// The portal frontend is a plain fetch() from
// /apps/<subpath>/api/client-portal/* — Shopify's App Proxy verifies the
// request signature at the edge and forwards it here with a
// `logged_in_customer_id` query param when a storefront customer is logged
// in (absent when anonymous). There is NO session-token JWT and NO CORS
// handling to do — App Proxy requests are server-to-server; the browser
// never talks directly to this app's origin.
//
// Distinct from app/api/portal/_guard.js — that guard is a different
// transport/audience (Customer Account JWT, for the practitioner-facing
// Referral Portal) and is untouched by this file.
//
// Unlike the practitioner guard, there is no approval gate here: any
// logged-in retail customer is authorized, so the only failure modes are
// 401 (not signed in / bad App Proxy signature) and 500.
//
// portalLoader wraps a handler so every request:
//   1. opens the Mongo connection,
//   2. verifies the App Proxy signature via authenticate.public.appProxy,
//   3. resolves `logged_in_customer_id` into a customer-scoped context.
//
// Handlers receive { ctx, url }, where ctx.customerId is the trusted tenant
// key. They must scope every query by it — identity is never taken from
// the query string.

import connectDB from "../../db/mongo.server";
import { authenticate } from "../../shopify.server";
import { resolveClientContext } from "../../services/cdo/cdo.clientPortal.service";
import { unauthorized, serverError, methodNotAllowed } from "../../services/APIService/api.service";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("api.client-portal");

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
  if (!rawCustomerId) {
    return { ok: false, response: unauthorized("Please sign in to view your account.") };
  }
  const customerId = `gid://shopify/Customer/${rawCustomerId}`;

  let ctx;
  try {
    ctx = await resolveClientContext(customerId);
  } catch (e) {
    log.error("context.resolve_failed", { err: e?.message || String(e) });
    return { ok: false, response: serverError("Failed to load your account") };
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
      log.error("handler.failed", { customerId: ctx.customerId, err: e?.message || String(e) });
      return serverError("Failed to load portal data");
    }
  };
}

// No writes in this feature (Profile is read-only) — every route's action
// export is just this 405.
export function portalAction() {
  return methodNotAllowed();
}

export function pageParams(url) {
  return {
    page: url.searchParams.get("page"),
    pageSize: url.searchParams.get("pageSize"),
  };
}
