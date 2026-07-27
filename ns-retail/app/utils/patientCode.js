// Single, consistent writer for a patient's active practitioner code across
// the TWO Shopify surfaces that must always agree:
//
//   • the `cdo.active_code` customer METAFIELD — what the practitioner-discount
//     Shopify Function reads at checkout to decide whether a code is allowed.
//   • the `code:<code>` customer TAG — what the storefront auto-apply reads to
//     decide which code to apply.
//
// If these two drift (e.g. one write succeeds and the other fails, or a caller
// updated only the tag), the auto-apply applies a code the Function then
// DECLINES → a silent "no discount". This helper makes the two move together:
// it writes the enforcement metafield FIRST, then the tag, and on a tag failure
// it REVERTS the metafield to its previous value so the pair can never be left
// in a harmful tag ≠ active_code state.
//
// Best-effort by contract (never throws) so it's a drop-in for the existing
// fire-and-forget callers — it returns a result object callers can log/surface.

import { syncCustomerCodeTag } from "./customerTags";
import { setCustomerActiveCode, getCustomerActiveCode } from "./practitionerMetafields";
import { createLogger } from "./logger.utils";

const log = createLogger("patientCode");

// Write the active code to BOTH the metafield and the tag, consistently.
// Returns { ok, metafieldOk, tagOk, reverted, reason, error }.
export async function syncPatientCode(shop, customerGid, code, { practitionerEmail = null } = {}) {
  if (!shop || !customerGid || !code) {
    return { ok: false, reason: "missing_args" };
  }

  // Capture the previous enforcement value so we can revert on a tag failure.
  let prev = null;
  try {
    prev = await getCustomerActiveCode(shop, customerGid);
  } catch (err) {
    // Non-fatal — worst case we can't revert; the writes below still run.
    log.warn("active_code.read_failed", { customerGid, err: err?.message || err });
  }

  // 1. Enforcement metafield first. If this fails we change NOTHING else, so
  //    the tag stays consistent with whatever the metafield already was.
  try {
    await setCustomerActiveCode(shop, customerGid, code);
  } catch (err) {
    log.error("active_code.write_failed", { customerGid, code, err: err?.message || err });
    return { ok: false, metafieldOk: false, tagOk: false, reason: "active_code_failed", error: err?.message || String(err) };
  }

  // 2. Tag (what the auto-apply reads). On failure, revert the metafield to
  //    `prev` so the two stay in agreement (never tag ≠ active_code in a way
  //    that makes the Function decline a code the block just applied).
  try {
    await syncCustomerCodeTag(shop, customerGid, code, practitionerEmail);
  } catch (err) {
    log.error("code_tag.write_failed", { customerGid, code, err: err?.message || err });
    let reverted = false;
    if (prev) {
      try {
        await setCustomerActiveCode(shop, customerGid, prev);
        reverted = true;
      } catch (e2) {
        log.error("active_code.revert_failed", { customerGid, prev, err: e2?.message || e2 });
      }
    }
    // prev === null → first assignment: metafield now set, no tag. The block
    // reads no tag and does nothing (no WRONG code applied) — a safe degrade.
    return { ok: false, metafieldOk: true, tagOk: false, reverted, reason: "tag_failed", error: err?.message || String(err) };
  }

  log.info("patient_code.synced", { customerGid, code: String(code).toLowerCase() });
  return { ok: true, metafieldOk: true, tagOk: true, code: String(code).toLowerCase() };
}
