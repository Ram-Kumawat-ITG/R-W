// GET /api/portal/commissions?status&from&to&page&pageSize&pendingOnly
// Commission summary + paginated list. `pendingOnly=1` powers the
// "Pending commissions" view (earned but not yet paid out).
import { portalLoader, portalAction, pageParams, dateRangeParams } from "./_guard";
import { ok } from "../../services/APIService/api.service";
import { getCommissions } from "../../services/cdo/cdo.portal.service";

export const loader = portalLoader(async ({ ctx, url }) => {
  const data = await getCommissions(ctx.practitionerId, {
    status: url.searchParams.get("status"),
    pendingOnly: url.searchParams.get("pendingOnly") === "1",
    ...dateRangeParams(url),
    ...pageParams(url),
  });
  return ok("Commissions", data);
});

export const action = portalAction;
