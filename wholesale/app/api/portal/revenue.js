// GET /api/portal/revenue?from&to — revenue totals (month/last/year/lifetime + range).
import { portalLoader, dateRangeParams } from "./_guard";
import { ok, methodNotAllowed } from "../../services/APIService/api.service";
import { getRevenue } from "../../services/cdo/cdo.portal.service";

export const loader = portalLoader(async ({ ctx, url }) => {
  return ok("Revenue", await getRevenue(ctx.practitionerId, dateRangeParams(url)));
});

export const action = () => methodNotAllowed();
