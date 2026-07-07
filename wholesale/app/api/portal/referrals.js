// /api/portal/referrals
//   GET  — referral codes + per-code usage stats (read-only).
//   POST — practitioner self-service: create a code, or pause/resume one.
//          Body: { op: 'create', code, discountPercent }   (discountPercent = integer percent)
//                { op: 'pause'  | 'resume', codeId }
import { portalLoader, portalMutation, pageParams } from "./_guard";
import { ok, badRequest, sendResponse } from "../../services/APIService/api.service";
import {
  getReferralCodes,
  createReferralCode,
  setReferralCodeStatus,
} from "../../services/cdo/cdo.portal.service";

export const loader = portalLoader(async ({ ctx, url }) => {
  return ok("Referral codes", await getReferralCodes(ctx.practitionerId, pageParams(url)));
});

export const action = portalMutation(async ({ ctx, body }) => {
  const op = String(body?.op || "create");

  try {
    if (op === "create") {
      const row = await createReferralCode(
        ctx.practitionerId,
        { code: body?.code, discountPercent: body?.discountPercent },
        { application: ctx.application },
      );
      return ok("Referral code created", row);
    }

    if (op === "pause" || op === "resume") {
      const row = await setReferralCodeStatus(ctx.practitionerId, {
        codeId: body?.codeId,
        status: op === "pause" ? "paused" : "active",
      });
      return ok(op === "pause" ? "Referral code paused" : "Referral code resumed", row);
    }

    return badRequest("Unknown operation.");
  } catch (e) {
    if (e?.code === "INVALID") return badRequest(e.message);
    if (e?.code === "CONFLICT") return sendResponse(409, "error", e.message, null);
    if (e?.code === "DISCOUNT_FAILED") return sendResponse(502, "error", e.message, null);
    throw e;
  }
});
