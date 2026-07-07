// GET /api/portal/payouts?status&from&to&page&pageSize — payout history.
import { portalLoader, pageParams, dateRangeParams } from "./_guard";
import { ok, methodNotAllowed } from "../../services/APIService/api.service";
import { getPayouts } from "../../services/cdo/cdo.portal.service";

export const loader = portalLoader(async ({ ctx, url }) => {
  const data = await getPayouts(ctx.practitionerId, {
    status: url.searchParams.get("status"),
    ...dateRangeParams(url),
    ...pageParams(url),
  });
  return ok("Payouts", data);
});

export const action = () => methodNotAllowed();
