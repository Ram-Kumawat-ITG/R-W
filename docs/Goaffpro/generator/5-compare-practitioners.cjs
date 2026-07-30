// Compares the Talon practitioner applications against the wholesale Shopify
// customers export and reports who is missing on each side.
//
// Matching is done on TWO keys, not just email:
//   1. email (normalised, lower-cased) — the primary identity
//   2. Talon `shopify_id` ↔ Shopify `Customer ID` — catches a practitioner whose
//      email was changed on one side after the customer was created
// A row counts as present if EITHER key matches, so the "missing" list is
// conservative — it won't claim someone is absent just because an email drifted.
const XLSX = require('d:/projects/shopify-apps/natural-solutions/naturalsolutionsphc.com-Natural-Solution-App/wholesale/node_modules/xlsx');
const { readCSV } = require('./lib.cjs');

const D = 'd:/projects/shopify-apps/natural-solutions/naturalsolutionsphc.com-Natural-Solution-App/docs';
const OUT = D + '/Missing_Practitioners.xlsx';

const lc = (v) => String(v ?? '').trim().toLowerCase();
// Shopify exports guard long numeric ids with a leading apostrophe.
const id = (v) => String(v ?? '').trim().replace(/^'/, '');

const talon = readCSV(D + '/practiitoner_applicaiton_telan_commerce.csv');
const whole = readCSV(D + '/wholesale_practitioner_customers_export.csv');

console.log(`Talon applications : ${talon.length}`);
console.log(`Wholesale customers: ${whole.length}`);

// ── indexes ──
const wByEmail = new Map();
const wById = new Map();
for (const w of whole) {
  const e = lc(w.Email);
  if (e && !wByEmail.has(e)) wByEmail.set(e, w);
  const i = id(w['Customer ID']);
  if (i) wById.set(i, w);
}
const tByEmail = new Map();
const tById = new Map();
for (const t of talon) {
  const e = lc(t.email);
  if (e && !tByEmail.has(e)) tByEmail.set(e, t);
  const i = id(t.shopify_id);
  if (i && i !== 'None') tById.set(i, t);
}

// ── in-file duplicates (worth knowing before trusting any count) ──
const dupes = (rows, keyFn) => {
  const c = new Map();
  rows.forEach((r) => { const k = keyFn(r); if (k) c.set(k, (c.get(k) || 0) + 1); });
  return [...c.entries()].filter(([, n]) => n > 1);
};
const tDup = dupes(talon, (r) => lc(r.email));
const wDup = dupes(whole, (r) => lc(r.Email));
console.log(`\nduplicate emails within Talon      : ${tDup.length}${tDup.length ? ' → ' + tDup.slice(0, 5).map(([e, n]) => `${e} x${n}`).join(', ') : ''}`);
console.log(`duplicate emails within wholesale  : ${wDup.length}${wDup.length ? ' → ' + wDup.slice(0, 5).map(([e, n]) => `${e} x${n}`).join(', ') : ''}`);

// ── A. Talon applications with NO wholesale customer ──
const missingCustomer = [];
for (const t of talon) {
  const e = lc(t.email);
  const sid = id(t.shopify_id);
  const byEmail = e ? wByEmail.get(e) : null;
  const bySid = sid && sid !== 'None' ? wById.get(sid) : null;
  if (byEmail || bySid) continue;
  missingCustomer.push({
    talon_application_id: t.id,
    status: t.status,
    first_name: t.firstName,
    last_name: t.lastName,
    practitioner_name: String(t['Name-of-practitioner'] || '').trim(),
    email: e,
    phone: t.phoneNumber,
    company: t.addressCompany,
    address1: t.addressLine1,
    address2: t.addressLine2,
    city: t.addressCity || '',
    state: t.addressState || t['State-Province'] || '',
    zip: t.addressZip || '',
    country: t.addressCountry,
    talon_shopify_id: sid && sid !== 'None' ? sid : '',
    created: t.created,
    updated: t.updated,
    created_by: t.created_by,
    why_missing: sid && sid !== 'None'
      ? `Talon records shopify_id ${sid}, but no customer with that id OR this email is in the wholesale export — the customer may have been deleted.`
      : 'No shopify_id on the Talon application and no wholesale customer with this email — the Shopify customer was never created.',
  });
}

// ── B. Wholesale customers with NO Talon application ──
const missingApplication = [];
for (const w of whole) {
  const e = lc(w.Email);
  const i = id(w['Customer ID']);
  if ((e && tByEmail.has(e)) || (i && tById.has(i))) continue;
  missingApplication.push({
    shopify_customer_id: i,
    first_name: w['First Name'],
    last_name: w['Last Name'],
    email: e,
    phone: w.Phone || w['Default Address Phone'] || '',
    company: w['Default Address Company'],
    city: w['Default Address City'],
    state: w['Default Address Province Code'],
    zip: w['Default Address Zip'],
    country: w['Default Address Country Code'],
    tags: w.Tags,
    total_orders: w['Total Orders'],
    total_spent: w['Total Spent'],
    why_missing: e
      ? 'Exists as a wholesale Shopify customer but has no Talon application — likely onboarded before Talon, or applied under a different email.'
      : 'Wholesale customer row has NO email — cannot be matched to any application.',
  });
}

// ── C. status disagreements: not approved in Talon, yet an approved customer ──
// This is the one direction that can cost money — a practitioner Talon rejected
// but whose Shopify customer still carries the "Approved" tag can place wholesale
// orders, because the storefront gate and the orders/create approval check both
// read the TAG, not the Talon application.
const statusMismatch = [];
for (const t of talon) {
  if (lc(t.status) === 'approved') continue;
  const e = lc(t.email);
  const sid = id(t.shopify_id);
  const w = (e ? wByEmail.get(e) : null) || (sid && sid !== 'None' ? wById.get(sid) : null);
  if (!w) continue;
  const tags = String(w.Tags || '');
  statusMismatch.push({
    talon_status: t.status,
    email: e,
    first_name: t.firstName,
    last_name: t.lastName,
    shopify_customer_id: id(w['Customer ID']),
    shopify_tags: tags,
    shopify_tagged_approved: /approved/i.test(tags) ? 'YES' : 'no',
    total_orders: w['Total Orders'],
    total_spent: w['Total Spent'],
    risk: /approved/i.test(tags)
      ? `Talon says "${t.status}" but the Shopify customer is tagged Approved — they can place wholesale orders. Decide which system is right, then either approve them in Talon or remove the Approved tag.`
      : `Talon says "${t.status}" and the customer is not tagged Approved — consistent, no action needed.`,
  });
}

// ── summary ──
const byStatus = (rows) => {
  const m = new Map();
  rows.forEach((r) => m.set(r.status, (m.get(r.status) || 0) + 1));
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
console.log(`\n=== A. Talon applications with NO wholesale customer: ${missingCustomer.length}`);
console.log(`      by status: ${JSON.stringify(byStatus(missingCustomer))}`);
console.log(`      of which APPROVED (should exist as customers): ${missingCustomer.filter((r) => lc(r.status) === 'approved').length}`);
console.log(`      with a shopify_id recorded but customer gone : ${missingCustomer.filter((r) => r.talon_shopify_id).length}`);
console.log(`\n=== B. Wholesale customers with NO Talon application: ${missingApplication.length}`);

const matched = talon.length - missingCustomer.length;
console.log(`\n=== matched both ways: ${matched} of ${talon.length} Talon applications (${(matched / talon.length * 100).toFixed(1)}%)`);

// ── workbook ──
function sheet(rows, head) {
  const aoa = [head, ...rows.map((r) => head.map((h) => (r[h] === undefined ? '' : r[h])))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = head.map((h) => ({ wch: Math.min(52, Math.max(12, h.length + 4)) }));
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(1, aoa.length - 1), c: head.length - 1 } }) };
  return ws;
}
const A_HEAD = ['talon_application_id', 'status', 'first_name', 'last_name', 'practitioner_name', 'email', 'phone',
  'company', 'address1', 'address2', 'city', 'state', 'zip', 'country', 'talon_shopify_id', 'created', 'updated', 'created_by', 'why_missing'];
const B_HEAD = ['shopify_customer_id', 'first_name', 'last_name', 'email', 'phone', 'company', 'city', 'state', 'zip',
  'country', 'tags', 'total_orders', 'total_spent', 'why_missing'];

const README = [
  ['Missing practitioners — Talon applications vs wholesale Shopify customers'],
  [''],
  [`Generated from docs/practiitoner_applicaiton_telan_commerce.csv (${talon.length} applications)`],
  [`             and docs/wholesale_practitioner_customers_export.csv (${whole.length} customers)`],
  [''],
  ['MATCHING: a practitioner counts as PRESENT if EITHER the email matches (lower-cased) OR the'],
  ["Talon shopify_id matches the Shopify Customer ID. Two keys, not one, so a practitioner whose"],
  ['email changed on one side is not wrongly reported missing. The lists below are therefore'],
  ['conservative — if anything they UNDER-report.'],
  [''],
  ['SHEET "Missing_Shopify_Customer"'],
  [`  ${missingCustomer.length} Talon applications with no wholesale Shopify customer.`],
  [`  ${missingCustomer.filter((r) => lc(r.status) === 'approved').length} of them are APPROVED — those are the ones that should exist and do not.`],
  [`  ${missingCustomer.filter((r) => r.talon_shopify_id).length} carry a shopify_id in Talon yet no matching customer exists (customer likely deleted).`],
  ['  Statuses present: ' + JSON.stringify(byStatus(missingCustomer))],
  ['  A rejected/pending application having no customer is EXPECTED, not a defect.'],
  [''],
  ['SHEET "Missing_Talon_Application"'],
  [`  ${missingApplication.length} wholesale Shopify customers with no Talon application.`],
  ['  Expected for anyone onboarded before Talon was adopted, or who applied under another email.'],
  [''],
  ['SHEET "Status_Mismatch"'],
  ['  ' + statusMismatch.length + ' practitioners NOT approved in Talon that still have a wholesale customer.'],
  ['  ' + statusMismatch.filter((r) => r.shopify_tagged_approved === 'YES').length + ' of them are tagged Approved in Shopify — they CAN place wholesale orders today, because the'],
  ['  storefront gate and the orders/create approval check both read the TAG, not the Talon status.'],
  ['  Decide which system is authoritative, then either approve them in Talon or drop the tag.'],
  [''],
  ['NOTE ON COUNTS: the wholesale CSV contains embedded newlines inside quoted fields, so a raw'],
  [`  line count (6,650) overstates it — the real row count is ${whole.length}.`],
];

const wb = XLSX.utils.book_new();
const rm = XLSX.utils.aoa_to_sheet(README);
rm['!cols'] = [{ wch: 104 }];
XLSX.utils.book_append_sheet(wb, rm, 'READ ME');
XLSX.utils.book_append_sheet(wb, sheet(missingCustomer, A_HEAD), 'Missing_Shopify_Customer');
XLSX.utils.book_append_sheet(wb, sheet(missingApplication, B_HEAD), 'Missing_Talon_Application');
XLSX.utils.book_append_sheet(wb, sheet(statusMismatch, ['talon_status', 'email', 'first_name', 'last_name', 'shopify_customer_id', 'shopify_tags', 'shopify_tagged_approved', 'total_orders', 'total_spent', 'risk']), 'Status_Mismatch');
XLSX.writeFile(wb, OUT);
console.log(`\nWROTE ${OUT}`);
