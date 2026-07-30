// Pure parsing of a referral code off a Shopify order payload. Shared by the
// orders/create, orders/paid, and orders/updated webhook handlers so they
// resolve attribution the same way. No I/O — payload parsing only.

// Customer-tag convention, e.g. "CODE:DURGESH10" / "REFERRAL:DURGESH10".
export const TAG_CODE_PATTERN = /^\s*(?:code|referral)\s*:\s*(.+?)\s*$/i;

// Returns { code, source } where source is "note_attribute" |
// "discount_code" | null.
//
// NOTE: the discount_codes fallback intentionally does NOT shape-check the
// code (e.g. against the auto-generated "<name>_<8hex>" pattern) — a
// practitioner code entered directly into Shopify's native discount field
// (bypassing the custom widget's note_attribute) can be any custom name an
// admin chose (e.g. "durtest11", "SUMMER-PRACTITIONER"). The real gate is
// resolvePractitionerReferral()'s catalogue lookup downstream, which safely
// returns null for any code — practitioner-shaped or not — that isn't
// actually in cdo_practitioner_codes, so a genuine unrelated public
// discount code never falsely attributes.
export function extractPractitionerCode(order) {
  // 1. Preferred: the cart attribute the checkout UI extension stamps on the
  //    order before discount apply.
  const noteAttrs = order?.note_attributes || [];
  for (const attr of noteAttrs) {
    if (attr?.name === "cdo_practitioner_code" && attr?.value) {
      const v = String(attr.value).trim();
      if (v) return { code: v, source: "note_attribute" };
    }
  }
  // 2. Fallback: any discount code on the order — validated against the
  //    real catalogue downstream, not by shape here.
  const dcs = order?.discount_codes || [];
  for (const dc of dcs) {
    const c = String(dc?.code || "").trim();
    if (c) return { code: c, source: "discount_code" };
  }
  return { code: null, source: null };
}

// Scan a customer's Shopify tags for a referral code ("CODE:x" / "REFERRAL:x").
export function extractCodeFromTags(tags) {
  for (const t of tags || []) {
    const m = String(t).match(TAG_CODE_PATTERN);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}
