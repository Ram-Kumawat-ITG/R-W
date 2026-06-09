// Shared guard for all Practitioner Portal endpoints.
//
// The portal frontend is a Customer Account UI extension (full-page). It
// authenticates to this backend with a session-token JWT obtained via
// shopify.sessionToken.get() and sent as `Authorization: Bearer <jwt>`.
//
// portalLoader wraps a loader so every portal request:
//   1. opens the Mongo connection,
//   2. verifies the session token via authenticate.public.customerAccount
//      (validates signature / aud / exp and yields a `cors` helper),
//   3. resolves the token's `sub` (logged-in customer GID) to an APPROVED
//      practitioner, mapping auth failures to the status the SPA branches on:
//        401 → not signed in / sub claim absent → extension shows "sign in"
//        403 → signed in, not a practitioner     → extension shows "restricted"
//
// Handlers receive { ctx, url, sessionToken } where ctx.practitionerId is the
// trusted tenant key. They must scope every query by it — identity is never
// taken from the query/body.
//
// CORS: the extension runs in a null-origin Web Worker and sends an
// Authorization header, so its fetch is "non-simple" and the browser issues
// an OPTIONS preflight (which carries no auth). portalAction answers that
// preflight directly. Success/error JSON responses also carry CORS headers
// (the library `cors` helper on success; sendResponse's wildcard on errors).

import connectDB from "../../db/mongo.server";
import { authenticate } from "../../shopify.server";
import { resolvePractitionerByCustomerGid } from "../../services/cdo/cdo.portal.service";
import {
  sendResponse,
  unauthorized,
  serverError,
  methodNotAllowed,
} from "../../services/APIService/api.service";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("api.portal");

const CORS_PREFLIGHT_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

// Answer the CORS preflight directly — it arrives without the Authorization
// header, so it can't go through authenticate.public.customerAccount.
export function corsPreflight() {
  return new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS });
}

export function portalLoader(handler) {
  return async ({ request }) => {
    // Defensive: GET-only loaders shouldn't receive OPTIONS, but if a runtime
    // routes it here, answer the preflight rather than erroring.
    if (request.method === "OPTIONS") return corsPreflight();

    try {
      await connectDB();
    } catch (e) {
      log.error("db.connect_failed", { err: e?.message || String(e) });
      return serverError("Service temporarily unavailable");
    }

    let sessionToken;
    let cors;
    try {
      ({ sessionToken, cors } = await authenticate.public.customerAccount(request));
    } catch (e) {
      // Missing / invalid / expired session token.
      log.info("auth.token_invalid", { err: e?.message || String(e) });
      return unauthorized("Please sign in to view your practitioner portal.");
    }

    let ctx;
    try {
      // Pass `dest` (the store the portal runs on) so the resolver can bridge
      // to the wholesale application by email when the per-store customer GID
      // doesn't match directly (portal now runs on the ns-retail store).
      ctx = await resolvePractitionerByCustomerGid(
        sessionToken?.sub,
        sessionToken?.dest,
      );
    } catch (e) {
      if (e?.code === resolvePractitionerByCustomerGid.ERR_FORBIDDEN) {
        return sendResponse(
          403,
          "error",
          "Your account is not an approved practitioner.",
          null,
        );
      }
      return unauthorized("Please sign in to view your practitioner portal.");
    }

    try {
      const url = new URL(request.url);
      const res = await handler({ ctx, url, sessionToken });
      // Ensure correct CORS headers for the extension's Web Worker origin.
      return cors(res);
    } catch (e) {
      log.error("handler.failed", {
        practitionerId: ctx.practitionerId,
        err: e?.message || String(e),
      });
      return serverError("Failed to load portal data");
    }
  };
}

// Portal endpoints are read-only. React Router routes non-GET verbs (incl.
// OPTIONS) to the action — answer the CORS preflight, reject everything else.
export function portalAction({ request }) {
  if (request.method === "OPTIONS") return corsPreflight();
  return methodNotAllowed();
}

// Small helpers for parsing common query params off the request URL.
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
