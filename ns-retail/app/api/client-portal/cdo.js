import { portalLoader, portalAction } from "./_guard";
import { ok } from "../../services/APIService/api.service";
import { getCdoInfo } from "../../services/cdo/cdo.clientPortal.service";

export const loader = portalLoader(async ({ ctx }) => {
  return ok("OK", await getCdoInfo(ctx.customerId));
});

export const action = portalAction;
