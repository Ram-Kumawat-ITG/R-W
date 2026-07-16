# GoAffPro → CDO Program Migration — Analysis & Plan

Status: **Admin Import Interface built (CDO Program → Migration tab).**
Fill in [GoAffPro_Migration_Template.xlsx](GoAffPro_Migration_Template.xlsx),
upload it there, run **Validate (dry run)** first, review the per-sheet
report, then **Commit Import**. Implementation: `app/services/cdo/migration.service.js`
(parse + validate + write), `app/models/cdoMigrationRun.server.js` (audit
log of committed runs), `app/routes/app.cdo-program.migration.jsx` (the
page). Re-running the same file is safe — every write path checks for an
already-imported row first and skips it rather than duplicating.

**Known deviations from this plan, as actually shipped** (read before your
first real import):
- **Practitioners are matched, never created.** `WholesaleApplication` is
  read-only from ns-retail (§13 Q2 in this doc) — a `CREATE_NEW`/unmatched
  practitioner row is reported and every dependent row for that email is
  skipped, not invented. Get every practitioner approved in the wholesale
  app first.
- **Historical orders get a synthetic `shopifyOrderId`**
  (`legacy:goaffpro:<shop>:<order ref>`), not a real Shopify order lookup —
  see the comment at the top of `migration.service.js` for why (no line
  items/addresses in the sheet; avoids a hard live-Shopify dependency for
  what could be hundreds of rows). This only affects `cdo_orders`'
  internal bookkeeping/idempotency key, not the commission/payout numbers
  themselves.
- **The redirect-CSV export described in §5.3 was not built** — the
  interface instead creates real Shopify `UrlRedirect`s directly via
  GraphQL (`urlRedirectCreate`) for every `Referral_URL_Mapping` row with
  `create_redirect=TRUE`, during Commit Import. Functionally equivalent
  (same end state), just done as a live API call instead of a CSV you'd
  import by hand in Shopify Admin.

## 1. Goal

Move every piece of GoAffPro referral-program data that has a business
meaning in the CDO Program into `ns-retail`'s own collections, so GoAffPro
can be fully decommissioned with:

- No practitioner losing their referral code or having to re-share a new one.
- No commission — paid or still-owed — lost, duplicated, or double-paid.
- No referred-customer / attribution history lost (needed for reporting and
  for future orders from returning customers to keep attributing correctly).

## 2. What the CDO Program needs, per collection

Reverse-engineered from the current schema (`app/models/cdo*.server.js` +
`wholesaleApplication.server.js`'s `commission` subdocument). This is the
target shape the Excel template's columns were derived from.

| Target collection | Owns | Key fields |
|---|---|---|
| `wholesale_applications` (wholesale repo, practitioner identity) | The practitioner record itself | `email`, `firstName`/`lastName`, `businessName`, `phone`, `commission.payoutMethod` (`ach`\|`check`), `commission.bankAccountName/RoutingNumber/AccountNumber/AccountType` (ACH — account number AES-256-GCM encrypted at rest), `commission.check.*` (check payouts) |
| `cdo_practitioner_codes` | Referral codes (the coupon a practitioner shares) | `practitionerId`, `code` (lowercase), `isPrimary` (one per practitioner), `discountPercent` (fraction), `commissionRate` (fraction, nullable → falls back to the program default), `status` (`active`\|`paused`\|`archived`) |
| `cdo_applications` / `cdo_referrals` | A referred person, and each use of a code | practitioner link, referred email/name, `status` (`pending`\|`converted`\|`expired`), `referredAt`, `convertedAt` |
| `cdo_orders` | Every attributed Shopify order (the referral revenue ledger) | `shopifyOrderId` (idempotency key), practitioner + referral snapshot, `amount`, `commissionAmount`, `placedAt` |
| `cdo_commissions` | One row per attributed order's earned commission | `orderId` (unique, idempotency key), `amount`, `rate`, `status` (`pending`\|`approved`\|`paid`\|`reversed`), `payoutStatus`, `earnedAt`, `payoutId` |
| `cdo_payouts` | A disbursement batch already paid (or to be paid) | `practitionerId`, `amount`, `method`, `status`, `commissionIds[]`, `periodStart/End`, `paidAt` |
| `cdo_settings.vendorCommissions[]` | Per-Shopify-vendor commission rate (commission is vendor-driven, not affiliate-driven, in this system) | `vendor`, `commissionPercent` |

The single biggest structural difference from GoAffPro: **commission here is
computed per order LINE from the product's Shopify `vendor` field**, not a
flat affiliate-level percentage. If GoAffPro paid a flat rate per affiliate,
that rate becomes each affiliate's `cdo_practitioner_codes.commissionRate`
(used going forward for new orders); historical order-level commission
amounts are imported as already-computed numbers from GoAffPro directly
(`Historical_Orders_Commissions.commission_amount`), not recomputed.

## 3. What to pull out of GoAffPro

Export (CSV/API, whatever GoAffPro's admin offers) for **every** affiliate,
not just active ones:

1. **Affiliates** — name, email, status, join date, payout method + banking/
   PayPal details on file, lifetime earned, lifetime paid.
2. **Coupons / referral codes** — code string, owning affiliate, discount %,
   commission %, active/paused.
3. **Referrals** — every tracked click/signup, whether or not it converted,
   with the referred person's email + which code they used + timestamps.
4. **Orders / commissions (transactions)** — every commission-bearing order:
   order id, affiliate, order amount, commission amount, commission status,
   order date.
5. **Payouts** — every historical disbursement: affiliate, amount, date,
   method, reference/check number, and **which commissions/orders it
   covered** (critical — see §6).
6. **Every legacy referral URL** a practitioner has ever shared — check
   marketing emails, business cards, social media bios, printed materials —
   not just whatever GoAffPro's dashboard shows as "the" link. See §5.

If GoAffPro's export doesn't cleanly give you #5's "which orders this payout
covered" link, reconstruct it by matching payout date windows against the
commission list, or treat unpaid vs. paid commissions as the only distinction
that matters (see below) and let `Historical_Payouts` be a single summary
row per affiliate with all their paid commission `row_id`s listed.

## 4. Field mapping (GoAffPro → template → CDO Program)

| GoAffPro concept | Template sheet | Lands in |
|---|---|---|
| Affiliate | `Practitioners` | `wholesale_applications` (matched by email) + banking on `commission.*` |
| Coupon / referral code | `Referral_Codes` | `cdo_practitioner_codes` |
| Referral (click/signup) | `Referred_Customers` | `cdo_referrals` (+ optionally `cdo_applications` if the person needs a full portal account) |
| Order + its commission | `Historical_Orders_Commissions` | `cdo_orders` (attributed) + `cdo_commissions` |
| Payout | `Historical_Payouts` | `cdo_payouts` (status `paid`, historical) |
| Legacy referral link (`?ref=` / path style) | `Referral_URL_Mapping` | A Shopify URL Redirect (or domain-level redirect) → the new `/discount/<code>` URL — see §5 |
| Affiliate flat commission % (if GoAffPro used one) | `Referral_Codes.commission_rate` | `cdo_practitioner_codes.commissionRate` — used for FUTURE orders only |
| Per-product commission rate (if GoAffPro tracked it) | `Vendor_Commission_Rates` | `cdo_settings.vendorCommissions[]` |

## 5. Referral URL migration — redirecting legacy GoAffPro links

GoAffPro links looked like:

- `https://nsdirectorder.com/?ref=test123` (query-param format)
- `https://nsdirectorder.com/test123` (path format)

The new system generates links like:

- `https://ns-direct-order-stagging-1.myshopify.com/discount/durg15`
  (production will use the real production shop domain, not the staging one)

These are a different domain **and** a different path shape. **Old links do
not automatically work once GoAffPro is decommissioned** — every one that a
practitioner has shared anywhere (email signature, business card, Instagram
bio, printed flyer) needs a redirect set up, or that practitioner silently
stops getting credit for referrals from people using their old link.

### 5.1 Capturing the mapping

The `Referral_URL_Mapping` sheet in the template is one row per legacy URL
**variant** (a practitioner may have shared both the query-param and the
path form, so they get two rows pointing at the same new code):

| Column | Meaning |
|---|---|
| `practitioner_email` | Join key back to `Practitioners` |
| `new_referral_code` | Join key to `Referral_Codes.code` — the code this old link now resolves to (note: this can legitimately differ from the old ref value if a code was renamed during migration — see the `drjones` example row) |
| `legacy_url_format` | `query_param` or `path` |
| `legacy_full_url` | The exact old URL as shared, verbatim |
| `legacy_domain` | The domain the old URL used (almost certainly `nsdirectorder.com`) |
| `legacy_ref_value` | The raw old code/slug pulled out of the URL |
| `new_full_url` | The real destination URL to redirect to |
| `create_redirect` | Whether a redirect should actually be created for this row (default TRUE) |

### 5.2 Is `nsdirectorder.com` our own domain, or GoAffPro's?

This determines who configures the redirect, and needs to be confirmed
before doing this work (see §13 open questions):

- **If `nsdirectorder.com` is a custom domain already pointed at this
  Shopify store** (likely, given the name) — Shopify's own **URL
  Redirects** feature (Shopify Admin → Online Store → Navigation → URL
  Redirects) can create an exact redirect from the old path straight to the
  new one, and it supports **bulk CSV import** natively. This is the
  recommended approach: no new app code, no new infrastructure, just data
  entry Shopify already has a UI + CSV importer for.
- **If `nsdirectorder.com` is hosted separately by GoAffPro** (a tracking
  domain GoAffPro provisioned, not actually pointed at Shopify) — the
  redirect has to be configured at whatever hosts that domain (GoAffPro's
  own domain/DNS settings, or wherever its DNS currently points), redirecting
  to the new full Shopify URL. This needs to happen **before** cancelling
  the GoAffPro subscription, since cancelling might tear down that hosting
  entirely and the domain would need to be repointed at Shopify (or
  wherever) directly instead.

### 5.3 Generating the Shopify redirect CSV

Shopify's bulk-import format for URL Redirects is two columns: `Redirect
from` (a path, e.g. `/test123` or `/?ref=test123`) and `Redirect to` (a
path or a full URL). Once `nsdirectorder.com` is confirmed to be this
store's own domain, the `Referral_URL_Mapping` sheet has everything needed
to generate that CSV directly — for each row where `create_redirect=TRUE`:

```
Redirect from: <path + query extracted from legacy_full_url>
Redirect to:   <path extracted from new_full_url, e.g. /discount/drjones10>
```

The Admin Import Interface should offer a **"Download Shopify redirect
CSV"** action from this sheet's data (in addition to writing the
`cdo_practitioner_codes` rows), so this becomes a two-click operation
(download, then upload it in Shopify Admin) rather than manual
transcription of dozens of rows.

### 5.4 Attribution is preserved by redirecting to the real new URL

The new link format (`/discount/<code>`) is Shopify's own native
auto-apply-discount route — landing there is functionally identical to a
customer typing the link in directly, so the existing checkout-attribution
pipeline (discount code on the order → `cdo.service` ingestion →
`cdo_orders`/`cdo_commissions`) picks it up exactly the same way. A plain
redirect to this exact URL loses nothing; **do not** redirect to a generic
homepage or a page that requires the customer to re-enter the code by hand.

### 5.5 Verification before decommissioning

After redirects are live, test a handful of the actual old URLs (not just
the new ones) in an incognito browser window and confirm: (a) the browser
lands on the new discount URL, (b) the discount visibly applies in the
cart, (c) a subsequent test order attributes correctly to the practitioner.
Do this **before** cancelling GoAffPro — if `nsdirectorder.com` turns out to
be GoAffPro-hosted, cancelling first would take the domain down before the
redirect could ever be configured.

## 6. The critical design decision: paid vs. still-owed commissions

This is the part most likely to cause a real-money mistake, so it gets its
own section.

- A commission GoAffPro **already paid out** → import with
  `commission_status = paid`, `payout_status = paid`, and it MUST link to a
  row in `Historical_Payouts` (via `linked_commission_row_ids`). The importer
  will create the `cdo_commissions` row already `paid`, linked to a
  `cdo_payouts` row that's also already `paid` with the historical
  `paidAt` — so the automated payout engine (`buildPayoutBatch` /
  `executeApprovedPayout`) never touches it again. **No money moves during
  import for these.**
- A commission GoAffPro had **approved but not yet paid** (or still pending
  approval) as of the cutover moment → import with `commission_status =
  approved` (or `pending`) and `payout_status = pending`, with **no** linked
  payout row. This is intentional: these commissions will automatically be
  picked up by the very next scheduled `buildPayoutBatch` run in the CDO
  Program after import, batched, and paid through the normal ACH/check flow
  — this is the correct way for practitioners to receive money they're
  already owed, without writing a special one-off disbursement path.
- **Do not** mark an unpaid GoAffPro commission as `paid` to make the sheet
  "look done" — that would silently write off a real debt to the
  practitioner.
- **Do not** import a commission that both lacks a linked payout AND is
  marked `paid` — the import validator should hard-reject this combination.

## 7. Idempotency / duplicate-prevention

- `cdo_orders` has a unique index on `(shop, shopifyOrderId)`; `cdo_commissions`
  has a unique partial index on `orderId`. The importer must resolve
  `shopify_order_id_or_name` to the real Shopify order GID and check both
  collections before inserting — an order already ingested by the live
  pipeline (e.g. because it was placed after cutover but a stale GoAffPro
  export still lists it) must be skipped, not duplicated.
- Every sheet's `row_id` is a spreadsheet-only cross-reference (for linking
  rows across sheets) — it is never written to the database verbatim.
- Run the whole import in a **dry-run / preview mode first** (validate +
  show a diff of what would be created, per practitioner) before committing
  any writes. This is a hard requirement for the Admin Import Interface, not
  optional.

## 8. Formatting gotchas (already called out in the template's README)

- Rates/percentages are **fractions** (`0.10` for 10%) everywhere in this
  system — `cdo_practitioner_codes.discountPercent`,
  `.commissionRate`, `cdo_commissions.rate`, `cdo_settings.defaultCommissionRate`
  all follow this convention. GoAffPro may export `10` for 10% — must be
  divided by 100 during data entry or at import time. This is the single
  most common source of a 100x commission bug.
- Money fields are plain numbers, no currency symbols.
- Dates should be unambiguous (`YYYY-MM-DD`), not locale-formatted.

## 9. Data privacy — bank account numbers

`wholesale_applications.commission.bankAccountNumber`/`bankAccountEncrypted`
is AES-256-GCM encrypted at rest in the real system; only the last 4 digits
are ever shown in plaintext anywhere in the app. The migration template's
`Practitioners.bank_account_number` column is a **transient staging field**
for practitioners whose ACH banking isn't already on file — treat that
column, and any spreadsheet containing it, like a completed W-9: no
unencrypted email, delete local copies after import, never commit to git.
**Most practitioners migrating from GoAffPro will already be approved
wholesale practitioners with banking already on file** — leave those cells
blank; the import must NOT overwrite existing banking with a blank/stale
value.

## 10. Reconciliation

After each practitioner's rows are prepared (and again after import), sum:

```
sum(Historical_Orders_Commissions.commission_amount WHERE commission_status='paid')
  should ≈ Practitioners.goaffpro_lifetime_paid

sum(Historical_Orders_Commissions.commission_amount) [all statuses]
  should ≈ Practitioners.goaffpro_lifetime_earned
```

Flag any practitioner where these don't reconcile within a small tolerance
(rounding) — it usually means a missing order row or a transcription error,
not a real discrepancy.

## 11. Cutover plan

1. Pick a cutover timestamp. Freeze GoAffPro (stop new attributions there —
   e.g. remove its tracking script / disable its checkout integration).
2. Export final GoAffPro data **as of that timestamp**.
3. Fill in the template (by hand, or by scripting it from the GoAffPro export
   once its shape is known).
4. Dry-run import, review, fix flagged rows, re-run dry-run until clean.
5. Commit the real import.
6. Set up the Shopify (or domain-level) redirects for every
   `Referral_URL_Mapping` row and verify a sample of the actual old URLs
   (see §5.5) BEFORE the next step.
7. Verify: spot-check several practitioners' CDO Program pages (Referral
   codes, Commission history, Upcoming Payout) against their GoAffPro
   history.
8. Only then fully decommission GoAffPro (cancel the app/subscription).
9. Practitioners should NOT need to re-share their referral link/code — old
   links keep working via the redirects set up in step 6, and the codes
   themselves migrate as-is (see §12 on Shopify discount recreation).

## 12. One thing the template alone can't do: recreating the Shopify discount

Every live `cdo_practitioner_codes` row is expected to have a matching
Shopify discount (`shopifyDiscountId`/`shopifyDiscountUrl`,
see `cdo.service.createShopifyDiscount`) so the code actually applies a
discount at checkout. The Admin Import Interface must call that same
discount-creation path for every imported `Referral_Codes` row — the
spreadsheet only carries `discount_percent`, not a Shopify discount id.
This should happen automatically as part of import, not as a manual
follow-up step, otherwise a migrated code will look active in the admin but
silently fail to discount anything at checkout.

## 13. Open questions for the project owner (please confirm before data entry begins)

1. **Does GoAffPro track a flat commission rate per affiliate, or per
   order/product?** This determines whether `Referral_Codes.commission_rate`
   is populated from a real per-affiliate rate, or left blank (falling back
   to the program default) with historical amounts imported as raw numbers.
2. **Do all migrating practitioners already have an approved
   `wholesale_applications` record?** If some don't, they need to go through
   (or be manually created via) the normal wholesale application/approval
   flow BEFORE their referral codes/commissions can be migrated, since
   `cdo_practitioner_codes.practitionerId` must point at a real
   `wholesale_applications._id`.
3. **Is there a reliable payout↔commission link in GoAffPro's export**, or
   will payouts need to be reconstructed by matching amounts/dates?
4. **Cutover date** — when does GoAffPro stop being the system of record?
5. **Do any GoAffPro affiliates need a `cdo_applications` (portal-login)
   record**, or is `cdo_referrals` (event history only, no login) sufficient
   for referred customers?
6. **Is `nsdirectorder.com` this store's own custom domain (pointed at
   Shopify), or a separate domain GoAffPro hosts/controls?** (§5.2) This
   decides whether the legacy-link redirects are created via Shopify's own
   URL Redirects feature or need to be configured wherever that domain's
   DNS/hosting actually lives — and whether it's safe to let the GoAffPro
   subscription lapse before or only after the redirects are confirmed
   working.

## 14. Next step (after this document + template are reviewed)

Once the project owner has filled in real data (or confirmed the sample
rows' shape is right) and answered §13, the next phase of work is the
**Admin Import Interface**: an upload page under CDO Program → Settings
that parses this workbook, runs the validations described above (referential
integrity across sheets, enum whitelists, fraction-range checks on rate
columns, duplicate-order detection against existing `cdo_orders`), shows a
dry-run preview grouped by practitioner, commits the writes transactionally
per practitioner (so one bad practitioner's data doesn't block everyone
else's import), and offers the "Download Shopify redirect CSV" export
described in §5.3 for the `Referral_URL_Mapping` sheet.
