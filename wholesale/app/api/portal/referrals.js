// GET /api/portal/referrals — referral codes + per-code usage stats.
import { portalLoader, portalAction } from "./_guard";
import { ok } from "../../services/APIService/api.service";
import { getReferralCodes } from "../../services/cdo/cdo.portal.service";

export const loader = portalLoader(async ({ ctx }) => {
  return ok("Referral codes", await getReferralCodes(ctx.practitionerId));
});

export const action = portalAction;
