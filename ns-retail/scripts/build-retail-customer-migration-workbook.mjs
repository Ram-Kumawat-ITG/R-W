/* eslint-env node */
// Transforms the raw production exports —
//   ../docs/shopify_retail_customers_export.csv   (Shopify customers)
//   ../docs/wix_retail_customer_contacts.csv       (Wix contacts)
// — into a FILLED migration workbook that matches
// docs/migration/Retail_Customer_Migration_Template.xlsx exactly, ready to
// run through the Customer Migration admin page (Validate → Commit).
//
// - Column order is taken from the blank TEMPLATE (authoritative — can't drift).
// - De-dupes by lower-cased email ACROSS both stores (Shopify wins on collision).
// - Wix wide format: uses Email 1 / Phone 1 / Address 1 as primary.
// - Referral/CDO attribution is NOT mapped (Phase 2). Wix "Practitioner" is
//   preserved in `notes` so it isn't lost, but referral_* columns stay blank.
//
// Run from ns-retail/:  node scripts/build-retail-customer-migration-workbook.mjs
//   optional args: --shopify=<path> --wix=<path> --out=<path>

import XLSX from "xlsx";
import { mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : dflt;
}
const SHOPIFY_CSV = resolve(__dirname, "..", arg("shopify", "../docs/shopify_retail_customers_export.csv"));
const WIX_CSV = resolve(__dirname, "..", arg("wix", "../docs/wix_retail_customer_contacts.csv"));
const TEMPLATE = resolve(__dirname, "../docs/migration/Retail_Customer_Migration_Template.xlsx");
const OUT = resolve(__dirname, "..", arg("out", "docs/migration/Retail_Customer_Migration_FILLED.xlsx"));

// ── helpers ──
const S = (v) => (v === null || v === undefined ? "" : String(v).trim());
const LC = (v) => S(v).toLowerCase();
const stripLeadingQuote = (v) => S(v).replace(/^'/, "");

function toYmd(v) {
  const raw = S(v);
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function firstNonEmpty(row, keys) {
  for (const k of keys) {
    const v = S(row[k]);
    if (v) return v;
  }
  return "";
}
function readCsv(path) {
  const wb = XLSX.readFile(path, { raw: true });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
}

// Authoritative column order + the Instructions sheet from the blank template.
const tplWb = XLSX.readFile(TEMPLATE);
const HEADER = XLSX.utils.sheet_to_json(tplWb.Sheets["Customers"], { header: 1, defval: "" })[0];

function blankRow() {
  const o = {};
  for (const h of HEADER) o[h] = "";
  return o;
}

// ── source mappers ──
function mapShopify(r) {
  const o = blankRow();
  o.source = "shopify";
  o.source_customer_id = stripLeadingQuote(r["Customer ID"]);
  o.applicant_type = "patient";
  o.first_name = S(r["First Name"]);
  o.last_name = S(r["Last Name"]);
  o.email = LC(r["Email"]);
  o.phone = firstNonEmpty(r, ["Phone", "Default Address Phone"]);
  o.business_name = S(r["Default Address Company"]);
  o.status = "approved";
  o.accepts_marketing = LC(r["Accepts Email Marketing"]) === "yes" ? "TRUE" : "FALSE";
  o.billing_line1 = S(r["Default Address Address1"]);
  o.billing_line2 = S(r["Default Address Address2"]);
  o.billing_city = S(r["Default Address City"]);
  o.billing_state = S(r["Default Address Province Code"]);
  o.billing_zip = S(r["Default Address Zip"]);
  o.billing_country = S(r["Default Address Country Code"]);
  o.shipping_same_as_billing = "TRUE";
  o.extra_tags = S(r["Tags"]);
  o.notes = S(r["Note"]);
  return o;
}

function mapWix(r) {
  const o = blankRow();
  o.source = "wix";
  o.source_customer_id = S(r["Serial Number"]);
  o.applicant_type = "patient";
  o.first_name = S(r["First Name"]);
  o.last_name = S(r["Last Name"]);
  o.email = LC(firstNonEmpty(r, ["Email 1", "Email 2", "Email 3", "Email 4"]));
  o.phone = firstNonEmpty(r, ["Phone 1", "Phone 2", "Phone 3", "Phone 4", "Phone 5", "Phone 6"]);
  o.business_name = S(r["Company"]);
  o.status = "approved";
  o.accepts_marketing = S(r["Email subscriber status"]) === "Subscribed" ? "TRUE" : "FALSE";
  o.billing_line1 = S(r["Address 1 - Street"]);
  o.billing_line2 = S(r["Address 1 - Street Line 2"]);
  o.billing_city = S(r["Address 1 - City"]);
  o.billing_state = S(r["Address 1 - State/Region"]);
  o.billing_zip = S(r["Address 1 - Zip"]);
  o.billing_country = S(r["Address 1 - Country"]);
  o.shipping_same_as_billing = "TRUE";
  o.source_created_at = toYmd(r["Created At (UTC+0)"]);
  o.extra_tags = S(r["Labels"]);
  // Preserve Phase-2 signals in notes rather than dropping them (referral_*
  // columns stay blank — attribution is a separate phase).
  const noteBits = [];
  const prac = S(r["Practitioner"]);
  const sys = S(r["System Name"]);
  if (prac) noteBits.push(`Wix Practitioner: ${prac}`);
  if (sys) noteBits.push(`Wix System: ${sys}`);
  o.notes = noteBits.join(" | ");
  return o;
}

// ── build ──
const shopifyRows = readCsv(SHOPIFY_CSV);
const wixRows = readCsv(WIX_CSV);

const out = [];
const byEmail = new Map(); // email → index in `out`
const report = {
  shopifyTotal: shopifyRows.length,
  wixTotal: wixRows.length,
  shopifyImported: 0,
  wixImported: 0,
  wixSkippedNoEmail: 0,
  duplicateEmailInBoth: 0, // wix email that already came from shopify
  duplicateWithinSource: 0,
  missingName: 0,
};

function push(row, { store }) {
  const email = row.email;
  if (!email) {
    if (store === "wix") report.wixSkippedNoEmail += 1;
    return;
  }
  if (byEmail.has(email)) {
    // Shopify was loaded first, so a later collision is Shopify-wins.
    if (store === "wix") report.duplicateEmailInBoth += 1;
    else report.duplicateWithinSource += 1;
    return;
  }
  if (!row.first_name || !row.last_name) report.missingName += 1;
  byEmail.set(email, out.length);
  out.push(row);
  if (store === "shopify") report.shopifyImported += 1;
  else report.wixImported += 1;
}

// Shopify FIRST (precedence on email collision), then Wix.
for (const r of shopifyRows) push(mapShopify(r), { store: "shopify" });
for (const r of wixRows) push(mapWix(r), { store: "wix" });

// Assign sequential row_ids.
out.forEach((row, i) => { row.row_id = String(i + 1); });

// ── write workbook (Instructions + Customers[filled] + Mapping_Report) ──
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, tplWb.Sheets["Instructions"], "Instructions");

const customersAoa = [HEADER, ...out.map((row) => HEADER.map((h) => row[h] ?? ""))];
const customersSheet = XLSX.utils.aoa_to_sheet(customersAoa);
customersSheet["!freeze"] = { xSplit: 0, ySplit: 1 };
XLSX.utils.book_append_sheet(wb, customersSheet, "Customers");

const reportAoa = [
  ["Retail Customer Migration — mapping report"],
  [""],
  ["Shopify rows in export", report.shopifyTotal],
  ["Wix rows in export", report.wixTotal],
  ["", ""],
  ["Shopify customers imported", report.shopifyImported],
  ["Wix customers imported (unique, not already in Shopify)", report.wixImported],
  ["TOTAL rows in Customers sheet", out.length],
  ["", ""],
  ["Wix skipped — no email (cannot create a customer)", report.wixSkippedNoEmail],
  ["Wix skipped — email already came from Shopify (Shopify wins)", report.duplicateEmailInBoth],
  ["Skipped — duplicate email within a single source", report.duplicateWithinSource],
  ["Rows missing first/last name (imported email-only — WARNING, not blocked)", report.missingName],
  ["", ""],
  ["De-dupe rule", "By lower-cased email. Shopify loaded first, so on a Shopify+Wix email collision the Shopify record is kept."],
  ["applicant_type", "Defaulted to 'patient' for every row."],
  ["Referral / CDO attribution", "NOT mapped (Phase 2). Wix 'Practitioner' / 'System Name' preserved in the notes column for later."],
  ["existing_shopify_customer_id", "Left blank — these are PRODUCTION source ids, not staging ids. The importer matches by email, else creates. Source ids are in source_customer_id."],
];
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(reportAoa), "Mapping_Report");

mkdirSync(dirname(OUT), { recursive: true });
XLSX.writeFile(wb, OUT);

console.log(`Wrote ${OUT}`);
console.log(report);
console.log(`Customers sheet: ${out.length} rows, ${HEADER.length} columns`);
