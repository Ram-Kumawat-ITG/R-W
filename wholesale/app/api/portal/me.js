// GET /api/portal/me — bootstrap endpoint. The Practitioner Portal calls
// this first (via the wholesale storefront's App Proxy) to confirm the
// visitor is a logged-in, approved practitioner before rendering the
// dashboard.
import { portalLoader } from "./_guard";
import { ok, methodNotAllowed } from "../../services/APIService/api.service";
import { getProfile } from "../../services/cdo/cdo.portal.service";

export const loader = portalLoader(async ({ ctx }) => {
  const profile = await getProfile(ctx.practitionerId, ctx.application);
  return ok("Authenticated", profile);
});

export const action = () => methodNotAllowed();
