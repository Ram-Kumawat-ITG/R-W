// GET /api/portal/customers?search&page&pageSize — referred customers (patients).
import { portalLoader, pageParams } from "./_guard";
import { ok, methodNotAllowed } from "../../services/APIService/api.service";
import { getReferredCustomers } from "../../services/cdo/cdo.portal.service";

export const loader = portalLoader(async ({ ctx, url }) => {
  const data = await getReferredCustomers(ctx.practitionerId, {
    search: url.searchParams.get("search"),
    ...pageParams(url),
  });
  return ok("Referred customers", data);
});

export const action = () => methodNotAllowed();
