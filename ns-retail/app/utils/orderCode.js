// Pure parsing of a referral code off a Shopify order payload. Shared by the
// orders/create, orders/paid, and orders/updated webhook handlers so they
// resolve attribution the same way. No I/O — payload parsing only.

// Canonical practitioner-code shape: <firstname>_<8-char-hex>.
const CODE_PATTERN = /^[a-z]+_[a-f0-9]{8}$/i;

// Customer-tag convention, e.g. "CODE:DURGESH10" / "REFERRAL:DURGESH10".
export const TAG_CODE_PATTERN = /^\s*(?:code|referral)\s*:\s*(.+?)\s*$/i;

// Returns { code, source } where source is "note_attribute" |
// "discount_code" | null.
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
  // 2. Fallback: a discount code on the order that matches the code shape.
  const dcs = order?.discount_codes || [];
  for (const dc of dcs) {
    const c = String(dc?.code || "").trim();
    if (c && CODE_PATTERN.test(c)) return { code: c, source: "discount_code" };
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
