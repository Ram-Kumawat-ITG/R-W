// /api/portal/patient-code
//   POST — practitioner reassigns a PATIENT's active discount code.
//          Body: { referredEmail, codeId }
//
// The only per-patient write path in the portal. The patient must already be
// attributed to this practitioner (enforced authoritatively in ns-retail); a
// practitioner can only assign one of their own ACTIVE codes. See
// cdo.portal.service.assignPatientCode + ns-retail's cdo-internal/
// assign-patient-code endpoint.
import { portalMutation } from "./_guard";
import { ok, badRequest, sendResponse } from "../../services/APIService/api.service";
import { assignPatientCode } from "../../services/cdo/cdo.portal.service";

export const action = portalMutation(async ({ ctx, body }) => {
  try {
    const row = await assignPatientCode(
      ctx.practitionerId,
      { referredEmail: body?.referredEmail, codeId: body?.codeId },
      { application: ctx.application },
    );
    return ok("Patient discount code updated", row);
  } catch (e) {
    if (e?.code === "INVALID") return badRequest(e.message);
    if (e?.code === "CONFLICT") return sendResponse(409, "error", e.message, null);
    if (e?.code === "DISCOUNT_FAILED") return sendResponse(502, "error", e.message, null);
    throw e;
  }
});
