# PDFfiller → Wholesale Practitioner Registration Migration — Analysis & Plan

> **SUPERSEDED (2026-07-23).** The practitioner-migration source is now the
> **Talon Advanced Registration** app — see
> [talon-practitioner-migration-plan.md](talon-practitioner-migration-plan.md)
> and `2Practitioner_Migration_Template.xlsx`. The importer described below is
> built and source-agnostic; only the two provenance columns were renamed
> (`pdffiller_*` → `talon_*`, old names still accepted). This document is kept
> for history — do not use it for a new migration.

Status: **Planning stage.** This document + the accompanying
[PDFfiller_Practitioner_Migration_Template.xlsx](PDFfiller_Practitioner_Migration_Template.xlsx)
are for the project owner to fill in with real PDFfiller export data. The
**Admin Import Interface** (upload → validate dry-run → commit, mirroring
the GoAffPro importer pattern already shipped for CDO Program migration)
is a follow-up build once this template's shape is confirmed — not built yet.

## 1. Goal

Recreate every existing PDFfiller-registered practitioner as a fully
functional record in the new digital registration system — same shape a
practitioner would have if they'd signed up through the live
`registration-form/` flow — so that:

- No practitioner has to re-submit their application, licenses, or W-9 from
  scratch.
- Every migrated practitioner can log in, place wholesale orders, and (once
  a card is on file — see §6, the one hard blocker) be auto-charged /
  auto-invoiced exactly like a native signup.
- Commission payout details (for practitioners who are also CDO Program
  referral partners) carry over so payouts aren't interrupted.
- Nothing PCI-sensitive (raw card numbers) ever touches a spreadsheet or
  this codebase.

## 2. What the new system needs, per data group

Reverse-engineered from `app/models/wholesaleApplication.server.js` (the
single collection — `wholesale_applications` — that backs a practitioner
account) plus the live submit handler `app/api/registration-form.js`, which
shows exactly what a real signup writes. This is the target shape the
template's columns were derived from.

| Data group | Lands in | Key fields |
|---|---|---|
| Identity + business | `wholesale_applications` (root) | `firstName`, `lastName`, `email` (unique, login identity), `phone`, `businessName` |
| Billing / shipping address | `wholesale_applications.billingAddress` / `.shippingAddress` | `line1/2`, `city`, `state`, `zip`, `country`; `shippingSameAsBilling`; `shippingPropertyType` (`Residential`\|`Commercial`) |
| Tax / resale | `wholesale_applications.tax` | `taxIdType` (`ein`\|`ssn`), `taxId`, `salesPermit`, `exemptState`, `itemsToResell`, `businessActivity`; `resellsProducts` |
| Credentials (practice type) | `wholesale_applications.credentials` (freeform object) | One or more of: Acupuncturist, Bio-Energetic Practitioner, Chiropractor, Health Coach, Licensed Medical Professional, Licensed Massage Therapist, Naturopathic Doctor, Nutritionist, QEST4 User, Reflexologist, Traditional Naturopath, Veterinarian, Other — each with its own license file and/or text fields (see `registration-form/src/constants.js CREDENTIALS`) |
| How they heard about us | `wholesale_applications.referrals` (freeform object) | IHHA, QEST4, Practitioner, Other, or None — some with a free-text detail |
| Payment method (how THEY pay US) | `wholesale_applications.payment` + an NMI Customer Vault | `method` (`card`\|`ach`\|`check`), `card.{cardholderName,cardBrand,cardLast4,nmi_billing_id}`, `ach.{achAccountName,achRoutingNumber,achAccountLast4,achAccountType,nmi_billing_id}` — **the vault itself is the hard constraint, see §6** |
| Commission payout (how WE pay THEM, CDO Program only) | `wholesale_applications.commission` | `enabled`, `payoutMethod` (`ach`\|`check`), ACH: `bankAccountName/RoutingNumber/AccountEncrypted/AccountLast4/AccountType`; Check: `check.payableTo`, `check.useBillingAddress`, `check.mailingAddress` |
| IRS Form W-9 | `wholesale_applications.w9` | `legalName`, `taxClassification` (7-way enum), `llcClassification` (LLC only), `otherClassification` (Other only), `exemptPayeeCode`, `fatcaCode`, `signature`, `submittedAt` |
| Terms + signature | `wholesale_applications.termsAccepted`, `.signature`, `.subscribeNews` | One signature (drawn or typed) that legally covers BOTH terms acceptance and the W-9 Part II perjury certification in the live flow |
| Approval state | `wholesale_applications.status/submittedAt/reviewedAt` | `pending`\|`approved`\|`rejected`\|`blocked` — migrated practitioners are, almost by definition, already-approved existing customers |
| Shopify customer | Shopify Admin (`customerCreate`) | Created from the above + tagged `Approved`, `practitioner`; login is via Shopify's own activation-link flow, **not** a migrated password (see §6.4) |
| CDO referral code | `cdo_practitioner_codes` (ns-retail) | Auto-generated post-approval by `generatePractitionerCode()` today — the import should call the same function so migrated practitioners get a code exactly like a fresh signup |

## 3. What to pull out of PDFfiller

For **every** submitted practitioner form, active or not:

1. **Identity** — name, email, phone, business name.
2. **Address** — billing address; shipping address if different; whether
   the shipping location is residential or commercial.
3. **Tax / resale details** — EIN or SSN, sales permit number (if any),
   state of tax exemption, what they resell, business activity
   description.
4. **Credential(s) claimed** — which practice type(s) (acupuncturist,
   chiropractor, etc.), any license/certificate files, and any credential-
   specific text fields (e.g. QEST4 serial number).
5. **How they heard about the program** (if PDFfiller captured it —
   otherwise leave blank, it's non-critical).
6. **Payment method on file** — which method they use today (card / ACH /
   check) and, for ACH only, the routing + account number (see §6 for why
   card can't be migrated the same way).
7. **Commission / referral payout details**, if this practitioner is also
   a CDO Program affiliate — bank details or check mailing preference.
8. **W-9 data** — legal name, tax classification, LLC sub-classification,
   exempt payee / FATCA codes if present, and the signed W-9 PDF itself
   (as a reference URL / attachment — see §7).
9. **Signed agreement date** — when they originally signed the terms /
   W-9, so the migrated record carries the true historical date, not
   today's date.
10. **Current status** — is this practitioner still active with us today?
    (Almost all should import as `approved`; a PDFfiller record for
    someone who was rejected or has since been blocked should carry that
    status instead of quietly re-approving them.)

## 4. Field mapping (PDFfiller → template → new system)

| Template sheet | Cardinality | Lands in |
|---|---|---|
| `Practitioners` | 1 row per practitioner | `wholesale_applications` root + address + tax + status |
| `Credentials` | 1+ rows per practitioner | `wholesale_applications.credentials.<id>` |
| `Referral_Sources` | 0+ rows per practitioner | `wholesale_applications.referrals.<id>` |
| `Payment_Setup` | 1 row per practitioner | `wholesale_applications.payment` + NMI Customer Vault (ACH only — see §6) |
| `Commission_Payout` | 0–1 row per practitioner | `wholesale_applications.commission` (only for CDO Program affiliates) |
| `W9_Tax_Certification` | 1 row per practitioner | `wholesale_applications.w9` + `.signature` + `.termsAccepted` |

Every sheet joins back to `Practitioners` via `practitioner_email` (the
same join-key convention as the GoAffPro migration template), and every row
carries a spreadsheet-only `row_id` for cross-sheet reference (never
written to the database).

## 5. Credentials & referral sources are normalized (one row each), not wide columns

`credentials` and `referrals` are freeform objects in the schema, keyed by
id, each with different sub-fields (see `registration-form/src/constants.js`
`CREDENTIALS` / `REFERRALS`). Rather than one enormous wide sheet with a
column pair per possible credential (~12 practice types × 2 fields each),
the template uses a **long/normalized** shape: one row per
practitioner-per-credential-claimed, and one row per
practitioner-per-referral-source. A practitioner with two credentials (e.g.
Chiropractor + Nutritionist) gets two rows on `Credentials`.

`detail_label_1/detail_value_1` + `detail_label_2/detail_value_2` are
generic slots that cover every credential type's specific sub-fields (e.g.
QEST4's serial number + system type both fit in the two slots; most
credentials only use slot 1, for the license file).

## 6. The hard constraint: card payment methods cannot be migrated from a spreadsheet

This is the part most likely to derail the import if not planned for up
front, so it gets its own section — parallel to the GoAffPro plan's §6 on
paid-vs-owed commissions.

### 6.1 Why

Every wholesale account requires a **live NMI Customer Vault** — the
tokenized payment profile the CRON auto-charges against. Looking at how
the live registration flow (`app/api/registration-form.js`) creates it:

- **ACH** (`createCustomerVault` with `achRouting`/`achAccount`) — the raw
  routing + account numbers are sent directly to NMI's API server-side. No
  client-side tokenization is involved. **This path can be replayed from a
  spreadsheet column** — exactly like the live form does, just triggered by
  the importer instead of a browser submit.
- **Card** (`paymentDetails: { paymentToken: ... }`) — the card is
  tokenized **client-side** via NMI's Collect.js *inside a real browser
  session*, specifically so raw card numbers never touch our server (PCI
  scope). **There is no way to produce a valid payment token from a
  spreadsheet cell containing a card number** — and doing so would mean
  handling raw PANs outside a PCI-compliant flow, which this project
  should never do, migration or not.
- Additionally, **every vault gets a card billing on it regardless of
  preferred method** (`check`/`card` customers get one card billing;
  `ach` customers get ACH as billing 1 + card as billing 2 for the "charge
  card on file" fallback). So even a pure-ACH migrated practitioner still
  needs *a* card token eventually if the ACH ever needs a fallback charge —
  though the ACH billing alone is enough to get their account fully
  functional at import time.

### 6.2 What this means for the template & the import

- `Payment_Setup.preferred_payment_method` records what the practitioner
  actually uses today, for reference and so their invoice due-date /
  processing-fee rules land correctly once a real vault exists.
- For **ACH**-preferred practitioners: `ach_routing_number` /
  `ach_account_number` columns let the importer create a real, working NMI
  vault at commit time — identical to what the live form does. These are
  **transient, staging-only columns** — see §9 on handling them like a
  completed W-9 (delete local copies after import, never commit to git).
  No card-fallback billing is created at import for these; a card can be
  added later the same way §6.3 describes.
- For **card** or **check**-preferred practitioners: `needs_card_capture`
  is auto-TRUE — the importer creates the `wholesale_applications` row
  (and, ideally, the Shopify customer) but **cannot** create a working NMI
  vault. `nmiCustomerVaultId` stays null. These practitioners land in a
  clearly-flagged "needs card on file" state until §6.3 happens.

### 6.3 Closing the gap — practitioner re-captures their card, once

The recommended fix (to confirm with the project owner, §11 Q1): a
lightweight **"Complete your payment setup"** self-service page — reusing
the exact same Collect.js card-capture UI already built for Step 3 of
`registration-form/`, just as a standalone follow-up step instead of full
re-registration — emailed to every migrated practitioner whose vault is
incomplete. This is a one-time ask, not a full re-application, and it's
the *only* way to close this gap without asking anyone to type a card
number into a spreadsheet or an admin screen. Until a practitioner
completes it, their invoices behave like today's "cheque/ACH-preferred, no
card on file" case (already a supported state in the live system — see
CLAUDE.md's Order Details "no card on file" banner) — nothing breaks, they
just can't be auto-charged by card yet.

## 7. Credential files & the W-9 document

License/certificate files and the signed W-9 PDF need to end up as
permanent Shopify Files (same as a live submission's
`uploadFileToShopify`), not left on PDFfiller's own servers (which may be
decommissioned same as GoAffPro). Two realistic sourcing options,
confirm with the project owner (§11 Q4):

- **Already re-hosted** — if these documents have already been exported
  from PDFfiller to some accessible location (Google Drive, S3, a shared
  folder), the template's `file_url` columns just need a direct,
  publicly-fetchable (or importer-authenticated) URL; the importer
  downloads the bytes and re-uploads to Shopify Files exactly like the
  live flow does.
- **Still only in PDFfiller** — export them first (PDFfiller supports bulk
  document export); do this as part of preparing the real migration data,
  not as something the importer itself talks to PDFfiller's API for (out
  of scope — no PDFfiller API integration is planned).

A practitioner with a credential that doesn't require a file (e.g. QEST4,
Bio-Energetic — text-only fields, see `constants.js`) simply has no
`file_url` on that row.

## 8. Idempotency / duplicate-prevention

- `wholesale_applications.email` is the practitioner's login identity —
  the importer must check every incoming email against existing records
  first. An email that **already exists** is reported and skipped (not
  overwritten) unless the row is explicitly flagged for a review/update
  pass — migrating stale PDFfiller data over a live, already-registered
  practitioner's current details would be actively harmful.
- Re-running the same file is safe: already-imported practitioners
  (matched by email) are skipped on a second pass, mirroring the GoAffPro
  importer's re-run safety.
- Run in **dry-run / preview mode first** (validate + show a diff of what
  would be created, per practitioner) before committing any writes — same
  hard requirement as the GoAffPro importer.

## 9. Data privacy

- **ACH bank details** (`ach_routing_number`/`ach_account_number` on
  `Payment_Setup`, and the equivalent on `Commission_Payout`) are
  transient staging columns. The production system never stores a raw ACH
  account number in Mongo — only the last 4 digits, plus (for payment) the
  NMI vault's billing id, or (for commission payout) an AES-256-GCM
  encrypted value (`utils/crypto.utils.js`, key derived from
  `SHOPIFY_API_SECRET`). Treat any spreadsheet containing these columns
  like a completed W-9: no unencrypted email, delete local copies after
  import, never commit to git.
- **Card numbers must never appear anywhere in this migration** — not in
  the spreadsheet, not typed into an admin screen. See §6.
- **Tax ID (SSN/EIN)** is equally sensitive — same handling rule as the
  bank columns.

## 10. Reconciliation

After preparing the real data (and again after import), spot-check:

- Every practitioner who should still be active today has `status:
  'approved'` on the `Practitioners` sheet, not a stale PDFfiller-era
  status.
- Every practitioner with a CDO Program referral code today (check
  `cdo_practitioner_codes` in ns-retail) has a matching row on
  `Commission_Payout` if they're owed payouts, or is deliberately left off
  it if they aren't a CDO participant.
- Every ACH-preferred practitioner's routing/account numbers are current —
  a stale bank account fails silently at the practitioner's bank, not
  loudly at import time, so this is worth a manual confirmation pass with
  each practitioner if there's any doubt.

## 11. Open questions for the project owner (please confirm before data entry begins)

1. **How should the card-payment gap (§6) be closed?** — the recommended
   "Complete your payment setup" self-service re-capture page, or a
   different approach (e.g. temporarily allowing check/manual invoicing
   for migrated practitioners until they call in with a card)?
2. **Cutover date** — when does PDFfiller stop being the system of
   record for new/updated practitioner data?
3. **Are all migrating practitioners still active/approved today**, or
   does the PDFfiller archive include practitioners who should import as
   `pending`, `rejected`, or `blocked` instead of `approved`?
4. **Where do the credential/W-9 files live right now** — already
   re-hosted somewhere fetchable, or only inside PDFfiller (requiring an
   export pass first)? See §7.
5. **Should migrated practitioners get the "your application has been
   approved" welcome/activation email** (same as a live approval), or a
   distinct "your account has been migrated — set your password" email?
   The mechanism is the same either way (Shopify's `customerSendInvite`
   activation link); this is purely a copy/tone question.
6. **Do any migrated practitioners need a CDO Program referral code
   retroactively generated** even though they weren't a GoAffPro affiliate
   (i.e., they should get a *brand-new* code now, not a migrated one)? If
   so the import should call the same `generatePractitionerCode()` used
   at live signup for every approved row, matching what a fresh signup
   gets automatically today.

## 12. Next step (after this document + template are reviewed)

Once the project owner has filled in real data (or confirmed the sample
rows' shape is right) and answered §11, the next phase of work is the
**Admin Import Interface** — following the exact pattern already shipped
for the GoAffPro → CDO Program migration
(`app/services/cdo/migration.service.js` in ns-retail): an upload page
under an admin "Migration" section that parses this workbook, runs the
validations described above (referential integrity across sheets, enum
whitelists, duplicate-email detection against existing
`wholesale_applications`, the card/ACH constraint from §6), shows a
dry-run preview grouped by practitioner, and commits per-practitioner
(so one bad row never blocks everyone else's import) — creating the
`WholesaleApplication` doc, the NMI vault (ACH only), the Shopify customer
+ invite, and the CDO referral code, in that order, mirroring
`app/api/registration-form.js`'s own step order and rollback behavior.
