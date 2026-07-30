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

## Run it from the terminal, not the admin page (2026-07-29)

**Use the CLI for this workbook.** The admin page is fine for a few hundred rows
and is kept for spot fixes, but it runs the whole import inside one HTTP action
at roughly one row per second, so 4,836 rows cannot finish before the request is
cut off.

```sh
npm run migrate:retail-customers                 # dry run — shows exactly what remains
npm run migrate:retail-customers:apply           # migrate; safe to re-run any time
npm run migrate:retail-customers:apply -- --only-failed=docs/migration/logs/<failures>.csv
```

Script: [`scripts/migrate-retail-customers.js`](../../scripts/migrate-retail-customers.js).
It does not reimplement the import — it drives the same
`runCustomerMigrationImport()` in checkpointed chunks, so there is no second
copy of the business logic to drift.

| Flag | Meaning |
|---|---|
| `--apply` | actually write (**dry run by default**) |
| `--file=<path>` | workbook (default `docs/migration/Retail_Customer_Migration_FILLED.xlsx`) |
| `--chunk=<n>` | rows per checkpoint (default 25) |
| `--pacing=<ms>` | delay between rows (default 200) |
| `--limit=<n>` | only the first n outstanding rows — good for a smoke test |
| `--only-failed=<csv>` | re-run just the emails in a failures CSV |
| `--retry-passes=<n>` | extra passes over failed rows (default 1) |
| `--no-resume` | re-verify every row instead of skipping linked ones |
| `--verify-shopify` | confirm each linked customer still exists before trusting it |

**Resume is derived from the database, not a checkpoint file** — any email
already in `cdo_applications` with a `customerId` is skipped without spending a
Shopify call. That is correct even after a hard kill, and it is what makes
re-running a finished 4,836-row file take seconds. Ctrl-C stops at the next row
boundary, flushes the logs, and the next run continues from there.

Failures go to `docs/migration/logs/retail-customers-failed-<ts>.csv` (git-ignored
— it holds real customer emails) with the row id, email, source, pass and reason,
plus a `…-events-<ts>.jsonl` per-row trace. Previously-failed rows are retried
automatically once before the run ends. The audit doc is rewritten after **every
chunk**, so progress survives a kill.

### What was actually wrong (root cause, 2026-07-29)

The first three attempts left 3,549 of 4,836 rows migrated with no record of why:

1. **The killed-request bug.** The route wrote its report only *after* the loop,
   so all three `cdo_migration_runs` docs contained nothing but
   `{ migrationType }` — no progress, no error, no failed-row list. The customers
   already created persisted, which is why each retry silently started over and
   got further (1,259 → 2,290 docs). Of the 1,287 rows left, **1,179 were one
   contiguous block at the tail** — the signature of a timeout, not bad data.
   *Fixed:* the CLI has no request timeout, and the route now checkpoints
   `report.progress` every 50 rows and marks `complete: true/false`, so a killed
   run leaves a readable record.
2. **`Phone has already been taken`** — the other 109 failures, scattered
   through the sheet. **Shopify enforces phone uniqueness across customers**, so
   the second real person sharing a number (spouses, a household, a
   practitioner's number reused on patient records) failed `customerCreate`
   outright. The service already had this fallback shape for addresses but not
   for phones, so the row was lost. *Fixed:* a phone user-error now strips the
   phone and retries — customer created, phone still kept on the
   `cdo_applications` doc, warning raised. This is why those rows were invisible:
   the error existed but the report carrying it was never saved.

Not a cause: duplicates. 3,549 applications resolved to 3,549 **distinct**
Shopify customer ids, and a `--no-resume` re-run over already-migrated rows
reports `created 0 / adopted 3` with the store count unchanged — adoption works.
