import { portalLoader, portalAction, pageParams } from "./_guard";
import { ok } from "../../services/APIService/api.service";
import { getOrders } from "../../services/cdo/cdo.clientPortal.service";

export const loader = portalLoader(async ({ ctx, url }) => {
  const result = await getOrders(ctx.customerId, {
    ...pageParams(url),
    financialStatus: url.searchParams.get("financialStatus") || undefined,
    fulfillmentStatus: url.searchParams.get("fulfillmentStatus") || undefined,
  });
  return ok("OK", result);
});

export const action = portalAction;
