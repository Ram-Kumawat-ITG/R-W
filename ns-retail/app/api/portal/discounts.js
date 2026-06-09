// GET /api/portal/discounts — discounts/promotions derived from the
// practitioner's referral codes (type, value, status, usage count).
import { portalLoader, portalAction } from "./_guard";
import { ok } from "../../services/APIService/api.service";
import { getDiscounts } from "../../services/cdo/cdo.portal.service";

export const loader = portalLoader(async ({ ctx }) => {
  return ok("Discounts", await getDiscounts(ctx.practitionerId));
});

export const action = portalAction;
