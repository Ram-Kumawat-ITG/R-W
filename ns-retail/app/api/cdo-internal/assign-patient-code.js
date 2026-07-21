/* eslint-env node */
// POST /api/cdo-internal/assign-patient-code
//
// Server-to-server endpoint the wholesale Practitioner Portal calls when a
// practitioner reassigns a patient's ACTIVE discount code (Patients tab →
// "Change code"). ns-retail owns cdo_applications + the retail Shopify customer,
// so the write must happen here; the wholesale portal only orchestrates the UI.
//
// It:
//   1. Reassigns the patient's canonical active code in cdo_applications
//      (assignPatientCode — validates the code belongs to the practitioner +
//      the patient is already attributed to them).
//   2. Sets the retail Shopify customer `cdo.active_code` metafield the
//      practitioner-discount Function reads (so only the assigned code applies
//      at checkout) + syncs the `code:` customer tag. Both best-effort.
//
// Auth: shared secret `RETAIL_SYNC_SECRET` via `x-sync-secret` header (same as
// the sibling cdo-internal endpoints).
//
// Body: { practitionerId, referredEmail, codeId? , code?, shop, actor? }
//   One of codeId / code is required. `shop` is the retail shop domain.
//
// Returns: { status:'success', result:{ email, code, oldCode } }
//          or { status:'error', message } with an appropriate HTTP code.

import { assignPatientCode } from "../../services/cdo/cdo.service";
import { setCustomerActiveCode } from "../../utils/practitionerMetafields";
import { syncCustomerCodeTag, lookupCustomerByEmail } from "../../utils/customerTags";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function action({ request }) {
  if (request.method !== "POST") {
    return json(405, { status: "error", message: "Method not allowed" });
  }

  // eslint-disable-next-line no-undef
  const expectedSecret = process.env.RETAIL_SYNC_SECRET || "";
  const incomingSecret = request.headers.get("x-sync-secret") || "";
  if (!expectedSecret || incomingSecret !== expectedSecret) {
    console.warn("[cdo-internal/assign-patient-code] auth failed");
    return json(401, { status: "error", message: "Unauthorized" });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { status: "error", message: "Invalid JSON payload" });
  }

  const practitionerId = String(body?.practitionerId || "").trim();
  const referredEmail = String(body?.referredEmail || "").trim();
  const codeId = body?.codeId ? String(body.codeId).trim() : null;
  const code = body?.code ? String(body.code).trim() : null;
  const shop = String(body?.shop || "").trim();
  const actor = String(body?.actor || "practitioner").trim();

  if (!practitionerId) return json(400, { status: "error", message: "practitionerId required" });
  if (!referredEmail) return json(400, { status: "error", message: "referredEmail required" });
  if (!codeId && !code) return json(400, { status: "error", message: "codeId or code required" });
  if (!shop) return json(400, { status: "error", message: "shop required" });

  // 1. Canonical DB reassignment (validates ownership + patient binding).
  let result;
  try {
    result = await assignPatientCode({ practitionerId, referredEmail, codeId, code, actor, shop });
  } catch (err) {
    // Validation failures (wrong practitioner, inactive code, unattributed
    // patient) are request-level → 409; anything else → 500.
    const msg = err?.message || "Assignment failed";
    const isValidation =
      /not found|not active|attributed|required|could not be validated/i.test(msg);
    console.error("[cdo-internal/assign-patient-code] error:", msg);
    return json(isValidation ? 409 : 500, { status: "error", message: msg });
  }

  // 2. Shopify side effects (best-effort — the canonical reassignment already
  //    succeeded; a Shopify hiccup must not fail the whole operation).
  let customerGid = result.customerGid || null;
  if (!customerGid) {
    try {
      customerGid = await lookupCustomerByEmail(shop, result.email);
    } catch (err) {
      console.error(
        `[cdo-internal/assign-patient-code] customer lookup failed for ${result.email}:`,
        err?.message || err,
      );
    }
  }

  if (customerGid) {
    try {
      await setCustomerActiveCode(shop, customerGid, result.code);
    } catch (err) {
      console.error(
        `[cdo-internal/assign-patient-code] set active_code failed for ${customerGid}:`,
        err?.message || err,
      );
    }
    try {
      await syncCustomerCodeTag(shop, customerGid, result.code, result.practitionerEmail);
    } catch (err) {
      console.error(
        `[cdo-internal/assign-patient-code] tag sync failed for ${customerGid}:`,
        err?.message || err,
      );
    }
  } else {
    console.warn(
      `[cdo-internal/assign-patient-code] no Shopify customer resolved for ${result.email} — DB reassigned, but the active_code metafield/tag could not be set (the discount Function needs the metafield to enforce the new code).`,
    );
  }

  return json(200, {
    status: "success",
    result: { email: result.email, code: result.code, oldCode: result.oldCode },
  });
}

export async function loader() {
  return json(405, { status: "error", message: "Method not allowed" });
}
