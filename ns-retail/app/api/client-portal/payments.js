import { portalLoader, portalAction, pageParams } from "./_guard";
import { ok } from "../../services/APIService/api.service";
import { getPaymentHistory } from "../../services/cdo/cdo.clientPortal.service";

export const loader = portalLoader(async ({ ctx, url }) => {
  const result = await getPaymentHistory(ctx.customerId, {
    ...pageParams(url),
    financialStatus: url.searchParams.get("financialStatus") || undefined,
    dateFrom: url.searchParams.get("dateFrom") || undefined,
    dateTo: url.searchParams.get("dateTo") || undefined,
  });
  return ok("OK", result);
});

export const action = portalAction;
