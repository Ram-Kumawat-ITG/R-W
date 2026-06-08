// GET /api/portal/summary — dashboard summary cards.
import { portalLoader, portalAction } from "./_guard";
import { ok } from "../../services/APIService/api.service";
import { getSummary } from "../../services/cdo/cdo.portal.service";

export const loader = portalLoader(async ({ ctx }) => {
  return ok("Summary", await getSummary(ctx.practitionerId));
});

export const action = portalAction;
