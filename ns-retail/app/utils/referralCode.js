// Canonical referral-code normalization — the SINGLE source of truth for how a
// referral / discount code string is shaped before it is stored, looked up, or
// compared. Lowercase + trimmed, matching the cdo_practitioner_codes schema
// (`code: { lowercase: true }`), so every creation path (admin + portal), the
// cdo_applications referral snapshot, and every lookup agree on one canonical
// form. Keeping this consistent means the case-insensitive regex some lookups
// still use is belt-and-suspenders robustness, not a load-bearing requirement —
// so the link between an application and its code can't silently break if that
// regex is ever simplified.
//
// PURE (no DB, no process.env) — safe to import from services, routes, models.

export function normalizeReferralCode(raw) {
  return String(raw || "").trim().toLowerCase();
}

// Escape a string for literal use inside a RegExp — for the exact,
// case-insensitive code lookups that must still tolerate any legacy
// mixed-case data written before normalization was unified.
export function escapeRegexLiteral(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
