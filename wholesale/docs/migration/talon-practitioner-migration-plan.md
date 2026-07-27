# Talon Advanced Registration → Wholesale Practitioner Registration — Analysis & Plan

Status: **Admin Import Interface built** (Practitioner Migration page).
Fill in [2Practitioner_Migration_Template.xlsx](2Practitioner_Migration_Template.xlsx),
upload it there, run **Validate (dry run)** first, review the per-sheet
report, then **Commit Import**. Implementation:
`app/services/practitioner/migration.service.js` (parse + validate + write),
`app/routes/app.practitioner-migration.jsx` (the page). Re-running the same
file is safe — a practitioner whose email already has an approved
`wholesale_applications` record is skipped, not duplicated.

> This supersedes `pdffiller-practitioner-migration-plan.md` (the earlier
> PDFfiller-sourced draft). The importer is source-agnostic; only the two
> provenance columns changed (`talon_submission_id` / `talon_form_url`, with
> the legacy `pdffiller_*` names still accepted as a fallback).

## 1. Source: the Talon Advanced Registration app

[Talon Advanced Registration](https://www.taloncommerce.com/apps/advanced-registration/)
is a Shopify B2B/wholesale registration + approval app. What matters for the
migration:

- **Each registration is a Shopify CUSTOMER.** Talon creates/updates a Shopify
  customer per applicant — so every practitioner already has a Shopify customer
  id and (usually) order history.
- **Custom fields live in the customer's METAFIELDS.** VAT/Tax id, EIN, business
  info, licenses, and file/image uploads are stored as customer metafields. The
  exact namespace/keys are **merchant-defined** (you configure the fields in
  Talon), so map *your* store's actual keys → the template columns.
- **Approval is a customer TAG** — e.g. `advanced-registration:approved`.
- **Access/export:** Talon offers a customer-list export (backup); you can also
  read the metafields directly via Shopify Admin or a bulk customer export.

## 2. Goal

Recreate every Talon-registered practitioner as a fully functional record in the
digital registration system — the same shape a practitioner would have if they'd
signed up through the live `registration-form/` flow — with **no data loss** and
**no duplicate Shopify customers**:

- No practitioner re-submits their application, licenses, or W-9.
- Every migrated practitioner can log in and place wholesale orders; ACH-preferred
  practitioners are auto-chargeable immediately (card-preferred import with a
  one-time re-capture step — see §5).
- **Existing Shopify customers + their order history are preserved** — the importer
  LINKS to the existing customer, never creates a duplicate (see §4).

## 3. Field mapping (Talon → template → wholesale_applications)

The template is a normalized intermediate; the importer reads it the same way
regardless of source. Map each Talon field into the matching column:

| Talon source (Shopify customer) | Template sheet → column | Lands in |
|---|---|---|
| Customer email | `Practitioners.email` (match/dedupe key) | `wholesale_applications.email` |
| Customer first/last name, phone | `Practitioners.first_name/last_name/phone` | same |
| Company / business-info metafield | `Practitioners.business_name` | `businessName` |
| Address (customer default / metafields) | `Practitioners.billing_*` / `shipping_*` | `billingAddress` / `shippingAddress` |
| EIN/SSN + Tax/VAT id metafields | `Practitioners.tax_id_type` (`ein`\|`ssn`) + `tax_id` | `tax.*` |
| Resale / sales-permit / activity metafields | `Practitioners.sales_permit / exempt_state / items_to_resell / business_activity` | `tax.*` |
| `advanced-registration:approved` tag | `Practitioners.status = approved` | `status` |
| **Shopify customer id** | `Practitioners.existing_shopify_customer_id` | links (see §4) |
| License / certificate file uploads (metafields) | `Credentials` rows (`credential_id` + `file_url`) | `credentials{}` (files re-hosted) |
| "How did you hear" metafield | `Referral_Sources` rows | `referrals{}` |
| Preferred payment + bank details | `Payment_Setup` row | `payment` (+ NMI vault for ACH) |
| Commission/payout bank details (if any) | `Commission_Payout` row | `commission` |
| W-9 fields + signature | `W9_Tax_Certification` row | `w9` + `signature` |
| Talon registration id / submission link | `Practitioners.talon_submission_id / talon_form_url` | provenance (audit only) |

The **Instructions** sheet inside the workbook is the authoritative per-column
reference (required flags, enums, conditional rules). Read it before data entry.

## 4. Preserve existing Shopify customers (the key rule)

Because every Talon practitioner is already a Shopify customer, set
`existing_shopify_customer_id` to their Shopify customer GID. On commit the
importer resolves the existing customer (explicit id → else email lookup),
updates its tags/note (`Approved`/`Blocked` + `practitioner`), and stores the
id on the new `wholesale_applications` doc — it never `customerCreate`s over a
practitioner who already exists (which would fail "email taken" or orphan order
history). Only a truly new applicant with no Shopify customer is created fresh.

## 5. The one hard limitation — card payment method

A credit-card token **cannot** be produced from a spreadsheet (there is no PCI
Collect.js session outside the live form). So:

- **ACH** migrates directly — NMI accepts raw routing/account numbers
  server-side, so an ACH practitioner gets a working NMI vault at commit.
- **Card / cheque** practitioners import fully but with `needsCardCapture: true`
  and **no working charge vault** until they complete a one-time card re-capture.

`cardholder_name` is always required (name on file); `card_brand`/`card_last4`
are display metadata only.

## 6. Idempotency / re-runs

- Dedupe key is the **email**. A practitioner whose email already has an approved
  `wholesale_applications` record is skipped (never overwritten); `match_status`
  is advisory only — the importer acts on the actual DB state and warns on a
  mismatch.
- **Dry-run (Validate) first** — it performs every check without any Mongo write,
  NMI call, or Shopify call; commit performs the real per-practitioner pipeline.
- File re-hosting (licenses, drawn signatures) is best-effort — a dead URL leaves
  that one file unattached rather than failing the whole practitioner.

## 7. Cutover

1. Freeze new Talon registrations (or note the cutover moment).
2. Export the Talon practitioners (customer list + metafields), including each
   customer's Shopify id.
3. Fill the template (map metafield keys → columns; set
   `existing_shopify_customer_id`; map the approval tag → `status`).
4. Dry-run import, fix flagged rows, re-run until clean.
5. Commit. Spot-check several practitioners' `wholesale_applications` records +
   that they're linked to their existing Shopify customer (order history intact).
6. Have card/cheque practitioners complete the one-time card re-capture when
   convenient (ACH practitioners are already chargeable).

## 8. Data privacy

Bank account numbers (`Payment_Setup` ACH + `Commission_Payout` ACH) are used
once to create the NMI vault / are AES-256-GCM encrypted at rest; only the last 4
are shown anywhere. Treat any filled workbook like a completed W-9: no
unencrypted email, delete local copies after import, never commit to git.
