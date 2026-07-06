// GET /api/portal/commissions?status&payoutStatus&patient&from&to&page&pageSize&pendingOnly
// Commission summary + paginated list. `pendingOnly=1` powers the
// "Pending commissions" view (earned but not yet paid out). `patient` (email)
// and `payoutStatus` are the Commission Summary filters.
import { portalLoader, pageParams, dateRangeParams } from "./_guard";
import { ok, methodNotAllowed } from "../../services/APIService/api.service";
import { getCommissions } from "../../services/cdo/cdo.portal.service";

export const loader = portalLoader(async ({ ctx, url }) => {
  const data = await getCommissions(ctx.practitionerId, {
    status: url.searchParams.get("status"),
    payoutStatus: url.searchParams.get("payoutStatus"),
    patient: url.searchParams.get("patient"),
    pendingOnly: url.searchParams.get("pendingOnly") === "1",
    ...dateRangeParams(url),
    ...pageParams(url),
  });
  return ok("Commissions", data);
});

export const action = () => methodNotAllowed();
