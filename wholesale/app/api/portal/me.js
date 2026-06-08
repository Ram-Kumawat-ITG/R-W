// GET /api/portal/me  (App Proxy: /apps/wholesale-application/api/portal/me)
// Bootstrap endpoint — the SPA calls this first to confirm the visitor is a
// logged-in, approved practitioner before rendering the dashboard.
import { portalLoader, portalAction } from "./_guard";
import { ok } from "../../services/APIService/api.service";
import { getProfile } from "../../services/cdo/cdo.portal.service";

export const loader = portalLoader(async ({ ctx }) => {
  const profile = await getProfile(ctx.practitionerId, ctx.application);
  return ok("Authenticated", profile);
});

export const action = portalAction;
