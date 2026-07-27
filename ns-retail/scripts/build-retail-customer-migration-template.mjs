/* eslint-env node */
// Generates the BLANK retail customer-data migration template
// (docs/migration/Retail_Customer_Migration_Template.xlsx).
//
// Scope: PHASE 1 — retail CUSTOMER data only (identity, contact, address,
// account type). Source data comes from a production Shopify store AND a Wix
// store; both map into this one normalized column set (the `source` column
// distinguishes them). CDO + Referral-program data (codes, attribution,
// commissions, payouts, metafield bindings) is a SEPARATE later phase — the
// referral columns here are reference-only and NOT imported in Phase 1.
//
// Target model (ns-retail): a Shopify customer + a `cdo_applications` doc
//   (applicantType retailer|patient, keyed by email, linked via customerId).
//
// Run:  node scripts/build-retail-customer-migration-template.mjs
// (xlsx@0.18.x is already a dependency; ESM workspace.)

import * as XLSX from "xlsx";
import { mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../docs/migration/Retail_Customer_Migration_Template.xlsx");

// ── Column dictionary ────────────────────────────────────────────────────
// Each column: key, required (Phase 1), imported (Phase 1), allowed values,
// the matching Shopify customer-export column, the matching Wix contacts-export
// column, and transform/notes. This same list drives BOTH the Instructions
// sheet and the header-only Customers sheet, so they can never drift.
const COLUMNS = [
  {
    key: "row_id",
    required: "Recommended",
    imported: "No (spreadsheet only)",
    allowed: "any unique value",
    shopify: "—",
    wix: "—",
    notes: "Your own unique row number. Used only to correlate errors/warnings in the import report. Never written to the database.",
  },
  {
    key: "source",
    required: "Yes",
    imported: "Yes → migrationSource",
    allowed: "shopify | wix",
    shopify: "(enter 'shopify')",
    wix: "(enter 'wix')",
    notes: "Which source store this customer came from. Stored for provenance.",
  },
  {
    key: "source_customer_id",
    required: "Recommended",
    imported: "Yes → migrationSourceId",
    allowed: "text/number",
    shopify: "ID",
    wix: "Contact ID",
    notes: "The customer's id in the SOURCE system. Enables idempotent re-runs + provenance. NOT the staging-store id.",
  },
  {
    key: "existing_shopify_customer_id",
    required: "No",
    imported: "Yes (adopt link)",
    allowed: "numeric id or gid://shopify/Customer/123",
    shopify: "(staging id, if already present)",
    wix: "—",
    notes: "If this person ALREADY exists in the STAGING Shopify store, put their id here → the importer ADOPTS them (links + updates tags) instead of creating a duplicate, preserving order history. Leave blank to create new; if blank the importer still tries to match by email first.",
  },
  {
    key: "applicant_type",
    required: "Yes",
    imported: "Yes → applicantType",
    allowed: "patient | retailer",
    shopify: "—",
    wix: "—",
    notes: "'patient' = a retail consumer (the common case; default). 'retailer' = a business/retailer account — then business_name is expected.",
  },
  {
    key: "first_name",
    required: "Yes",
    imported: "Yes → firstName + Shopify",
    allowed: "text",
    shopify: "First Name",
    wix: "First Name",
    notes: "Required — Shopify customer creation and the app both need a name.",
  },
  {
    key: "last_name",
    required: "Yes",
    imported: "Yes → lastName + Shopify",
    allowed: "text",
    shopify: "Last Name",
    wix: "Last Name",
    notes: "Required.",
  },
  {
    key: "email",
    required: "Yes",
    imported: "Yes → email + Shopify (key)",
    allowed: "valid email",
    shopify: "Email",
    wix: "Email",
    notes: "The dedupe key — must be unique per customer. Lower-cased on import. One row per email.",
  },
  {
    key: "phone",
    required: "No",
    imported: "Yes → phone + Shopify",
    allowed: "phone number",
    shopify: "Phone",
    wix: "Phone",
    notes: "Optional. Normalized to E.164 (+1XXXXXXXXXX for US). A bare 10-digit US number is assumed +1. Unparseable numbers are dropped — the customer is still created.",
  },
  {
    key: "business_name",
    required: "If retailer",
    imported: "Yes → businessName",
    allowed: "text",
    shopify: "Company",
    wix: "Company",
    notes: "Retailer accounts only; leave blank for patients.",
  },
  {
    key: "status",
    required: "No",
    imported: "Yes → status",
    allowed: "pending | approved | rejected",
    shopify: "—",
    wix: "—",
    notes: "Default 'approved' (migrated existing customers are already active accounts).",
  },
  {
    key: "accepts_marketing",
    required: "No",
    imported: "Yes → email marketing consent",
    allowed: "TRUE | FALSE",
    shopify: "Accepts Email Marketing",
    wix: "(subscriber status)",
    notes: "Default FALSE. Maps to the Shopify customer email-marketing consent state.",
  },
  // ── Billing address (optional) ──
  { key: "billing_line1", required: "No", imported: "Yes → billingAddress.line1", allowed: "text", shopify: "Default Address Address1", wix: "Address Line 1", notes: "Optional. Collected later / at checkout if omitted." },
  { key: "billing_line2", required: "No", imported: "Yes → billingAddress.line2", allowed: "text", shopify: "Default Address Address2", wix: "Address Line 2", notes: "" },
  { key: "billing_city", required: "No", imported: "Yes → billingAddress.city", allowed: "text", shopify: "Default Address City", wix: "City", notes: "" },
  { key: "billing_state", required: "No", imported: "Yes → billingAddress.state", allowed: "2-letter code preferred", shopify: "Default Address Province Code", wix: "State/Region", notes: "2-letter code preferred (e.g. 'CA'); full state names are accepted too." },
  { key: "billing_zip", required: "No", imported: "Yes → billingAddress.zip", allowed: "text", shopify: "Default Address Zip", wix: "Zip/Postal Code", notes: "" },
  { key: "billing_country", required: "No", imported: "Yes → billingAddress.country", allowed: "full name or ISO code", shopify: "Default Address Country Code", wix: "Country", notes: "e.g. 'United States' or 'US'." },
  // ── Shipping address (optional) ──
  { key: "shipping_same_as_billing", required: "No", imported: "Yes", allowed: "TRUE | FALSE", shopify: "—", wix: "—", notes: "Default TRUE. When TRUE the shipping_* columns are ignored and billing is used." },
  { key: "shipping_line1", required: "No", imported: "Yes → shippingAddress.line1", allowed: "text", shopify: "—", wix: "—", notes: "Only when shipping_same_as_billing = FALSE." },
  { key: "shipping_line2", required: "No", imported: "Yes → shippingAddress.line2", allowed: "text", shopify: "—", wix: "—", notes: "" },
  { key: "shipping_city", required: "No", imported: "Yes → shippingAddress.city", allowed: "text", shopify: "—", wix: "—", notes: "" },
  { key: "shipping_state", required: "No", imported: "Yes → shippingAddress.state", allowed: "2-letter code preferred", shopify: "—", wix: "—", notes: "" },
  { key: "shipping_zip", required: "No", imported: "Yes → shippingAddress.zip", allowed: "text", shopify: "—", wix: "—", notes: "" },
  { key: "shipping_country", required: "No", imported: "Yes → shippingAddress.country", allowed: "full name or ISO code", shopify: "—", wix: "—", notes: "" },
  // ── Provenance / misc ──
  {
    key: "source_created_at",
    required: "No",
    imported: "Yes → submittedAt",
    allowed: "ISO date (YYYY-MM-DD)",
    shopify: "(not in standard export)",
    wix: "Created Date",
    notes: "Original account-creation date in the source. Stored as submittedAt. NOTE: Shopify cannot backdate the customer's own 'created' date — this is app-side metadata only.",
  },
  {
    key: "extra_tags",
    required: "No",
    imported: "Yes → Shopify tags",
    allowed: "comma-separated",
    shopify: "Tags",
    wix: "Labels",
    notes: "Extra Shopify tags to preserve from the source (e.g. VIP,newsletter). The importer ALWAYS adds a 'Migrated' provenance tag. Do NOT put referral 'code:*' tags here — those belong to Phase 2.",
  },
  {
    key: "notes",
    required: "No",
    imported: "Yes → migrationNotes (doc)",
    allowed: "text",
    shopify: "Note",
    wix: "(notes)",
    notes: "Free-text internal note stored on the cdo_applications doc. (Retail has no structured Shopify customer-note format.)",
  },
  // ── Phase 2 (CDO / referral) — reference only, NOT imported now ──
  {
    key: "referral_code",
    required: "No (Phase 2)",
    imported: "NO — Phase 2",
    allowed: "text",
    shopify: "—",
    wix: "—",
    notes: "LEAVE BLANK for the customer migration. Referral/CDO attribution is a SEPARATE later phase. You MAY capture it here now if known, but it is NOT imported in Phase 1 (no code tag, no cdo.active_code / cdo.practitioner_id metafield, no referral snapshot is written).",
  },
  {
    key: "referred_by_practitioner_email",
    required: "No (Phase 2)",
    imported: "NO — Phase 2",
    allowed: "email",
    shopify: "—",
    wix: "—",
    notes: "LEAVE BLANK for the customer migration (Phase 2 reference only).",
  },
];

// ── Overview lines (top of the Instructions sheet) ───────────────────────
const OVERVIEW = [
  ["Retail Customer Data Migration Template — PHASE 1 (customers only)"],
  [""],
  ["Purpose: migrate production RETAIL customer data (from a Shopify store AND a Wix store) into the STAGING retail Shopify store + the ns-retail app database (cdo_applications)."],
  [""],
  ["What Phase 1 creates per row:"],
  ["  • a Shopify customer in the staging store (or ADOPTS an existing one — see existing_shopify_customer_id)"],
  ["  • a cdo_applications document (applicantType = patient | retailer), linked to that Shopify customer"],
  ["  • a 'Migrated' provenance tag (+ any extra_tags you supply)"],
  [""],
  ["What Phase 1 does NOT do (handled in a SEPARATE later phase, do not attempt here):"],
  ["  • referral / CDO attribution: no code:* tag, no cdo.active_code / cdo.practitioner_id metafield, no referral snapshot"],
  ["  • orders, commissions, payouts, practitioner codes"],
  ["  → the referral_code / referred_by_practitioner_email columns are REFERENCE ONLY and are ignored by the Phase-1 importer."],
  [""],
  ["How to fill it:"],
  ["  1. Put ONE customer per row on the 'Customers' sheet (below the header row)."],
  ["  2. Map each source export column into the normalized columns using the 'Shopify export column' / 'Wix export column' guides below."],
  ["  3. Set 'source' to shopify or wix on every row. Combine both stores into this one sheet."],
  ["  4. De-duplicate by email BEFORE import (one row per email). If the same person exists in both Shopify and Wix, keep one row (prefer the richer/Shopify record) — the email is the identity key."],
  ["  5. If a customer already exists in the STAGING store, set existing_shopify_customer_id so they are adopted (order history preserved), not duplicated."],
  [""],
  ["Hard-required columns: source, applicant_type, first_name, last_name, email. Everything else is optional (or conditionally required, e.g. business_name for retailers)."],
  [""],
  ["Import sheets: the 'Customers' sheet is the ONLY sheet the importer reads. 'Samples (reference only)' is IGNORED — it exists just to show example rows; delete or leave it, it is never imported."],
  [""],
  ["Column dictionary:"],
];

// ── Sample rows (reference only) ─────────────────────────────────────────
const SAMPLE_ROWS = [
  {
    row_id: "1", source: "shopify", source_customer_id: "6203847263", existing_shopify_customer_id: "",
    applicant_type: "patient", first_name: "Jane", last_name: "Doe", email: "jane.doe@example.com",
    phone: "+15551234567", business_name: "", status: "approved", accepts_marketing: "TRUE",
    billing_line1: "123 Main St", billing_line2: "Apt 4", billing_city: "Austin", billing_state: "TX",
    billing_zip: "78701", billing_country: "United States", shipping_same_as_billing: "TRUE",
    shipping_line1: "", shipping_line2: "", shipping_city: "", shipping_state: "", shipping_zip: "", shipping_country: "",
    source_created_at: "2023-05-14", extra_tags: "newsletter", notes: "", referral_code: "", referred_by_practitioner_email: "",
  },
  {
    row_id: "2", source: "wix", source_customer_id: "wix-88fa21", existing_shopify_customer_id: "",
    applicant_type: "retailer", first_name: "Acme", last_name: "Wellness", email: "buyer@acmewellness.com",
    phone: "5559876543", business_name: "Acme Wellness LLC", status: "approved", accepts_marketing: "FALSE",
    billing_line1: "9 Commerce Blvd", billing_line2: "", billing_city: "Denver", billing_state: "CO",
    billing_zip: "80202", billing_country: "US", shipping_same_as_billing: "FALSE",
    shipping_line1: "9 Commerce Blvd", shipping_line2: "Dock B", shipping_city: "Denver", shipping_state: "CO",
    shipping_zip: "80202", shipping_country: "US",
    source_created_at: "2022-11-02", extra_tags: "VIP,wholesale-lead", notes: "Imported from Wix contacts", referral_code: "", referred_by_practitioner_email: "",
  },
  {
    row_id: "3", source: "shopify", source_customer_id: "6203999111", existing_shopify_customer_id: "gid://shopify/Customer/7788990011",
    applicant_type: "patient", first_name: "Sam", last_name: "Rivera", email: "sam.rivera@example.com",
    phone: "", business_name: "", status: "approved", accepts_marketing: "FALSE",
    billing_line1: "", billing_line2: "", billing_city: "", billing_state: "", billing_zip: "", billing_country: "",
    shipping_same_as_billing: "TRUE", shipping_line1: "", shipping_line2: "", shipping_city: "", shipping_state: "", shipping_zip: "", shipping_country: "",
    source_created_at: "", extra_tags: "", notes: "Already exists in staging → adopt via existing_shopify_customer_id", referral_code: "", referred_by_practitioner_email: "",
  },
];

// ── Build ────────────────────────────────────────────────────────────────
function autoWidth(aoa, min = 10, max = 80) {
  const widths = [];
  for (const row of aoa) {
    row.forEach((cell, i) => {
      const len = String(cell ?? "").length;
      widths[i] = Math.min(max, Math.max(min, widths[i] || 0, len + 2));
    });
  }
  return widths.map((w) => ({ wch: w }));
}

const wb = XLSX.utils.book_new();

// 1) Instructions sheet
const instrAoa = [
  ...OVERVIEW,
  ["Column", "Required (Phase 1)", "Imported (Phase 1)", "Allowed values", "Shopify export column", "Wix export column", "Notes / transform"],
  ...COLUMNS.map((c) => [c.key, c.required, c.imported, c.allowed, c.shopify, c.wix, c.notes]),
];
const instrSheet = XLSX.utils.aoa_to_sheet(instrAoa);
instrSheet["!cols"] = autoWidth(instrAoa);
XLSX.utils.book_append_sheet(wb, instrSheet, "Instructions");

// 2) Customers sheet (header-only import sheet)
const header = COLUMNS.map((c) => c.key);
const customersSheet = XLSX.utils.aoa_to_sheet([header]);
customersSheet["!cols"] = autoWidth([header]);
customersSheet["!freeze"] = { xSplit: 0, ySplit: 1 };
XLSX.utils.book_append_sheet(wb, customersSheet, "Customers");

// 3) Samples sheet (reference only — ignored by importer)
const sampleAoa = [header, ...SAMPLE_ROWS.map((r) => header.map((k) => r[k] ?? ""))];
const samplesSheet = XLSX.utils.aoa_to_sheet(sampleAoa);
samplesSheet["!cols"] = autoWidth(sampleAoa);
XLSX.utils.book_append_sheet(wb, samplesSheet, "Samples (reference only)");

mkdirSync(dirname(OUT), { recursive: true });
XLSX.writeFile(wb, OUT);
console.log(`Wrote ${OUT}`);
console.log(`Sheets: ${wb.SheetNames.join(", ")}`);
console.log(`Customers columns (${header.length}): ${header.join(", ")}`);
