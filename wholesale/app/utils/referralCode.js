// Canonical referral-code normalization — the SINGLE source of truth for how a
// referral / discount code string is shaped before it is stored, looked up, or
// compared. Lowercase + trimmed, matching the shared `cdo_practitioner_codes`
// schema (`code: { lowercase: true }`) — ns-retail has an identical copy of
// this file for the same reason (both apps write/read that collection).
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
