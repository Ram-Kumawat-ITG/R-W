import { portalLoader, portalAction, pageParams } from "./_guard";
import { ok } from "../../services/APIService/api.service";
import { getPaymentHistory } from "../../services/cdo/cdo.clientPortal.service";

export const loader = portalLoader(async ({ ctx, url }) => {
  return ok("OK", await getPaymentHistory(ctx.customerId, pageParams(url)));
});

export const action = portalAction;
