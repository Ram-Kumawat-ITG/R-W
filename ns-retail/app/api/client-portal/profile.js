import { portalLoader, portalAction } from "./_guard";
import { ok } from "../../services/APIService/api.service";
import { getProfile } from "../../services/cdo/cdo.clientPortal.service";

export const loader = portalLoader(async ({ ctx }) => {
  return ok("OK", await getProfile(ctx.customerId, ctx.application?.email));
});

export const action = portalAction;
