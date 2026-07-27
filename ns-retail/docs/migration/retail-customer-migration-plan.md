# Retail Customer Data Migration — Phase 1 (customers only)

Migrate **production retail customer data** from a **Shopify** store **and** a **Wix**
store into the **staging retail Shopify store** + the ns-retail app database
(`cdo_applications`), without touching existing functionality.

**Template (blank):** [`Retail_Customer_Migration_Template.xlsx`](./Retail_Customer_Migration_Template.xlsx)
**Template builder:** [`scripts/build-retail-customer-migration-template.mjs`](../../scripts/build-retail-customer-migration-template.mjs)
**Filled workbook (mapped from real exports):** [`Retail_Customer_Migration_FILLED.xlsx`](./Retail_Customer_Migration_FILLED.xlsx)
**Transformer:** [`scripts/build-retail-customer-migration-workbook.mjs`](../../scripts/build-retail-customer-migration-workbook.mjs)

## Filled workbook (from the 2026-07-27 exports)

`build-retail-customer-migration-workbook.mjs` reads the raw exports
(`../docs/shopify_retail_customers_export.csv`,
`../docs/wix_retail_customer_contacts.csv`), normalizes both into the
`Customers` columns, de-dupes by lower-cased email (Shopify wins on a
cross-store collision), assigns sequential `row_id`s, and writes
`Retail_Customer_Migration_FILLED.xlsx` (Instructions + filled Customers +
a **Mapping_Report** sheet). Latest run:

- Shopify export: 1,110 → **1,110 imported**
- Wix export: 3,889 → **3,726 imported** (unique; 162 already in Shopify → Shopify kept; 1 skipped, no email)
- **Total: 4,836 rows**, **0 validation errors**, **544 warnings** (email-only — no name; imported, name filled later)

Source mapping specifics: Shopify `Customer ID` → `source_customer_id` (leading
`'` stripped); Wix wide format uses `Email 1`/`Phone 1`/`Address 1` as primary;
Wix `Email subscriber status = Subscribed` → `accepts_marketing`; Wix
`Created At` → `source_created_at`; Wix `Practitioner`/`System Name` preserved
in `notes` (Phase-2 signal, not imported as attribution). Re-run the
transformer any time the exports change; then Validate → Commit the filled file.

## Scope

**Phase 1 (this doc)** creates, per row:
- a Shopify customer in the staging store (or **adopts** an existing one), and
- a `cdo_applications` doc (`applicantType: patient | retailer`, keyed by `email`,
  linked to Shopify via `customerId`), plus a `Migrated` provenance tag.

**Explicitly NOT in Phase 1** (a separate later phase — see the note at the end):
referral/CDO attribution (`code:*` tag, `cdo.active_code` + `cdo.practitioner_id`
metafields, the `referral` snapshot), orders, commissions, payouts, and
practitioner codes. The `referral_code` / `referred_by_practitioner_email`
columns are **reference-only** and ignored by the Phase-1 importer.

## Target data model (source of truth)

`cdo_applications` (`ns-retail/app/models/cdoApplication.server.js`, `strict:false`):
`applicantType` (req, `retailer|patient`), `firstName`, `lastName`, `email`
(key — no unique index, callers dedupe by email), `businessName`, `phone`,
`billingAddress`/`shippingAddress` (embedded), `status` (`pending|approved|rejected`,
default `pending`), `submittedAt`, `customerId` (Shopify GID). The `referral`
snapshot + `referralHistory` are Phase 2.

Shopify `customerCreate` on retail (`ns-retail/app/api/signup-form.js`) sends
`firstName`, `lastName`, `email`, `tags`, `emailMarketingConsent` — **no note,
no metafields, no phone/address at creation** (retail uses passwordless OTP
accounts; Shopify sends its own activation email — see the email note below).

## Hard-required vs optional

- **Required:** `source`, `applicant_type`, `first_name`, `last_name`, `email`.
- **Conditionally required:** `business_name` when `applicant_type = retailer`.
- **Optional / deferred:** phone, all address fields, status (default `approved`),
  marketing, tags, notes, dates.

## Source → template mapping

The template is source-agnostic; set `source = shopify | wix` per row and map:

| Template column | Shopify customer export | Wix contacts export |
|---|---|---|
| first_name / last_name / email / phone | First/Last Name, Email, Phone | First/Last Name, Email, Phone |
| business_name | Company | Company |
| billing_* | Default Address Address1/2, City, Province Code, Zip, Country Code | Address Line 1/2, City, State/Region, Zip, Country |
| accepts_marketing | Accepts Email Marketing | subscriber status |
| extra_tags | Tags | Labels |
| source_customer_id | ID | Contact ID |
| source_created_at | (not in std export) | Created Date |

Full per-column dictionary lives in the workbook's **Instructions** sheet.

## Transforms the importer will apply

- `email` → lower-cased; the dedupe key (one row per email).
- `phone` → E.164 (`+1` assumed for bare 10-digit US numbers); an unparseable
  number is **dropped**, the customer is still created (learned from the
  wholesale migration — a bad phone must never abort a customer create).
- `billing_country` → ISO code when a known country name is given (else passed
  through); `billing_state` → 2-letter code preferred, full names tolerated.
- An **all-empty address is skipped** (never sent to Shopify — an empty
  `MailingAddressInput` is rejected; also learned from the wholesale migration).
- Always adds a `Migrated` tag; never adds `Signup-Self` (that means self-signup)
  and never adds `code:*` (Phase 2).

## De-duplication (Shopify + Wix)

Combine both stores into the one `Customers` sheet, then de-dupe **by email
before import** (one row per email; prefer the richer/Shopify record when a
person exists in both). On import, each row is matched in this order:
`existing_shopify_customer_id` → else Shopify `customerByEmail` → else create.
An existing match is **adopted** (linked + tags updated, order history
preserved), never duplicated. Re-runs are idempotent (match by
`source`+`source_customer_id` and email).

## ⚠️ Email during migration

Shopify `customerCreate` for passwordless (new) customer accounts triggers
Shopify's **own OTP/activation email** — this is NOT gated by the app's global
email kill switch (that only covers app-sent SMTP/QBO/Shopify-invite mail).
Before running the import, confirm whether the staging store should email real
customers; if not, disable customer-account activation emails in the staging
store's notification settings (or run against test addresses).

## The importer (built)

- **Service:** `app/services/cdo/customerMigration.service.js` —
  `parseCustomerMigrationWorkbook(data)` (reads the `Customers` sheet only) +
  `runCustomerMigrationImport({ parsed, admin, shop, actor, commit, migrationRunId })`.
  `commit=false` = true dry run (full validation + Shopify READ lookups, no
  writes). Per row it: validates the required fields; resolves the Shopify
  customer (explicit `existing_shopify_customer_id` → else `customerByEmail` →
  else create); **adopts** an existing customer (adds `Migrated` +
  `migrated:<source>` + `extra_tags`, preserves everything else) or creates a
  new one; then upserts the `cdo_applications` doc (email-keyed, shop-scoped),
  stamped `{ migrationSource:'retail_customer', migrationRunId, migrationSourceStore, migrationSourceId }`,
  `referral:null` (Phase 2 owns attribution).
- **Reliability:** every Shopify call is throttle-aware (classifies a 200-with-
  `THROTTLED` as retryable) + retried with backoff, and rows are paced — the
  fix for the wholesale bulk-throttle failure. Bad phone → dropped (+warning);
  address rejected by Shopify → customer created without it, address kept in
  our DB (+warning); `email already taken` on create → adopt by email.
- **Report:** `{ dryRun, migrationType:'retail_customer', customers:{ total,
  created, adopted, appCreated, appUpdated, alreadyLinked, skipped, errors[],
  warnings[] } }`. **errors** block a row; **warnings** import + flag.
- **UI:** `app/routes/app.customer-migration.jsx` (nav: **Customer Migration**)
  — upload → **Validate (dry run)** → review errors/warnings → **Commit Import**
  (Commit stays disabled until the exact file passes a clean validate).
- **Audit:** one `cdo_migration_runs` doc per commit (`report.migrationType =
  'retail_customer'`); dry runs write nothing. Re-running the same file is
  idempotent (adopt/update, never duplicate).
