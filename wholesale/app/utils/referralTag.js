// Referral-source → tag mapping.
//
// A practitioner picks one or more referral sources on registration step 1
// ("How did you hear about us?"). Each selection becomes a tag that must read
// identically everywhere it lands: the Shopify customer, the Shopify order, the
// QBO customer, and the QBO invoice — so referral reporting joins across all
// four systems on the same string.
//
//   ihha          → "IHHA Referral"
//   qest4-ref     → "QEST4 Referral by <referrer name>"
//   practitioner  → "Practitioner Referral by <referrer name>"
//   other-ref     → "Other - <entered value>"
//   none          → (no tag at all)
//
// The name in the QEST4 / Practitioner tags is the value typed into that
// option's field — "Name of who referred you" / "e.g., Dr. Jane Smith" — i.e.
// the REFERRING practitioner, not the registrant (the registrant's own name is
// already on the customer record, so tagging it would carry no information).
//
// PURE + isomorphic: no env, no I/O, no Shopify/QBO imports. Safe to import
// from a service, a webhook, a loader, or client render code.
//
// Two Shopify constraints are enforced here rather than at each call site:
//
//   1. ORDER tags are capped at 40 characters (customer/product tags allow 255).
//      We cap EVERYTHING at 40 so the customer tag, order tag, and both QBO
//      records carry the byte-identical string — a value that differed per
//      system would defeat the point of the mapping.
//   2. A comma is Shopify's tag SEPARATOR, so a comma inside a value would
//      silently split one tag into two. Commas are stripped.

// Shopify's per-tag limit for ORDER / draft-order tags. The tightest of the
// tag limits, so it's the one we build to.
export const MAX_TAG_LENGTH = 40

// Referral option id → how its tag reads. `withDetail` builds the tag from the
// entered value; `fallback` is used when no value was captured (possible for
// migrated practitioners — the importer deliberately allows a referral with no
// detail_value — and for any legacy doc predating field validation).
const REFERRAL_TAG_SPECS = {
  ihha: { plain: 'IHHA Referral' },
  'qest4-ref': {
    withDetail: (name) => `QEST4 Referral by ${name}`,
    fallback: 'QEST4 Referral',
  },
  practitioner: {
    withDetail: (name) => `Practitioner Referral by ${name}`,
    fallback: 'Practitioner Referral',
  },
  'other-ref': {
    withDetail: (value) => `Other - ${value}`,
    fallback: 'Other Referral',
  },
  // "None" is explicitly NOT tagged — see the requirement. Present here so the
  // id is recognised rather than falling through as unknown.
  none: { plain: null },
}

// Normalize a user-entered detail value into something tag-safe: collapse
// whitespace, drop commas (Shopify's tag separator), and trim.
function cleanDetail(raw) {
  if (raw === null || raw === undefined) return ''
  return String(raw).replace(/,/g, ' ').replace(/\s+/g, ' ').trim()
}

// Clamp to Shopify's 40-char tag limit, preferring a word boundary so a
// truncated name reads as a name rather than being cut mid-word. Falls back to
// a hard cut when there's no usable space (e.g. one very long token).
export function clampTag(tag) {
  const value = cleanDetail(tag)
  if (value.length <= MAX_TAG_LENGTH) return value
  const hardCut = value.slice(0, MAX_TAG_LENGTH)
  const lastSpace = hardCut.lastIndexOf(' ')
  // Prefer a word boundary ONLY when it's within a few characters of the limit
  // (i.e. we'd just be dropping a stray partial word). A generous threshold
  // would throw away most of a long referrer name — "Practitioner Referral by
  // Dr." tells you nothing, whereas a mid-word cut still identifies the person.
  if (lastSpace >= MAX_TAG_LENGTH - 4) return hardCut.slice(0, lastSpace).trim()
  return hardCut.trim()
}

// Build the referral tag for ONE selection. Returns null when the option
// carries no tag (None) or the id isn't recognised.
export function buildReferralTag(id, detail) {
  const spec = REFERRAL_TAG_SPECS[String(id || '').trim()]
  if (!spec) return null
  if (spec.plain !== undefined) return spec.plain ? clampTag(spec.plain) : null
  const value = cleanDetail(detail)
  return clampTag(value ? spec.withDetail(value) : spec.fallback)
}

// Build every referral tag for an application-shaped object.
//
// `referrals` is the Mixed map stored on WholesaleApplication (and posted by the
// registration form): { [optionId]: { selected: boolean, value?: string } }.
// Multiple sources can be selected — the form is "Select all that apply" — so
// this returns an array, in the canonical option order, de-duplicated.
//
// Returns [] for: no referrals, only "None" selected, or an unrecognised id.
export function buildReferralTags(referrals) {
  const refs = referrals && typeof referrals === 'object' ? referrals : {}
  const tags = []
  for (const id of Object.keys(REFERRAL_TAG_SPECS)) {
    const entry = refs[id]
    if (!entry || entry.selected !== true) continue
    const tag = buildReferralTag(id, entry.value)
    if (tag && !tags.includes(tag)) tags.push(tag)
  }
  return tags
}

// Resolve an application/customer-map doc's referral tags, preferring the
// PERSISTED `referralTags` array and falling back to deriving them from the
// raw `referrals` map. The fallback is what makes this work for practitioners
// who registered BEFORE the tags were persisted (no backfill required).
export function resolveReferralTags(doc) {
  if (!doc) return []
  if (Array.isArray(doc.referralTags) && doc.referralTags.length > 0) {
    return doc.referralTags.map((t) => clampTag(t)).filter(Boolean)
  }
  return buildReferralTags(doc.referrals)
}

// Human-readable one-liner for the QBO records, which have free-text note
// fields rather than tags. Returns '' when there are no referral tags, so
// callers can skip writing anything.
export function formatReferralNote(tags) {
  const list = (Array.isArray(tags) ? tags : []).filter(Boolean)
  if (list.length === 0) return ''
  return `Referral: ${list.join('; ')}`
}
