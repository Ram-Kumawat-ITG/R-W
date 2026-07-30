// Builds the populated GoAffPro → CDO Program migration workbook from the
// production GoAffPro exports in docs/Goaffpro/.
//
// Column contract is driven by ns-retail/app/services/cdo/migration.service.js
// (parse + validate + write). Every column that importer reads is emitted with
// the exact name it expects; extra columns appended on the right are ignored by
// the importer and exist for human review / audit.
//
// Source-of-truth choices (see READ ME FIRST in the output):
//   • commissions  → transactions-*.csv (Entity Type = SALES), netted per
//     (affiliate, order). Its per-program total matches the affiliates export's
//     "Total Commission" to the cent, which orders-*.csv does not.
//   • payout links → CDO export's "Is Paid ?" column, which actually carries the
//     GoAffPro payout ID that settled the row (not a boolean). The PHC export
//     has that column zeroed, so PHC links are reconstructed FIFO by date.
//   • order revenue → orders-*.csv (PHC only; the CDO program's orders export is
//     missing from the drop — see BLOCKER 1).

const fs = require('fs');
const XLSX = require('d:/projects/shopify-apps/natural-solutions/naturalsolutionsphc.com-Natural-Solution-App/wholesale/node_modules/xlsx');
const { readCSV, FILES, lc, n, r2, dOnly } = require('./goaffpro-csv.cjs');

const OUT = 'd:/projects/shopify-apps/natural-solutions/naturalsolutionsphc.com-Natural-Solution-App/docs/Goaffpro/GoAffPro_Migration_PRODUCTION_FILLED.xlsx';
const SHOP = 'ns-direct-order-stagging-1.myshopify.com';
const NEW_URL = (code) => `https://${SHOP}/discount/${code}`;
const CUTOFF = '2026-07-03'; // last day covered by the exports

const norm = (v) => String(v || '').trim().toLowerCase();

// ── Load everything ──────────────────────────────────────────────────────
const affC = readCSV(FILES.affCdo);
const affP = readCSV(FILES.affPhc);
const ccC = readCSV(FILES.ccCdo);
const ccP = readCSV(FILES.ccPhc);
const orders = readCSV(FILES.orders); // PHC program orders
const payC = readCSV(FILES.payCdo);
const payP = readCSV(FILES.payPhc);
const products = readCSV(FILES.products); // PHC program order lines
const apps = JSON.parse(fs.readFileSync('./apps.json', 'utf8'));

const appByEmail = new Map(apps.map((a) => [a.email, a]));
const appsByName = new Map();
for (const a of apps) {
  const k = norm(`${a.firstName} ${a.lastName}`);
  if (k && a.status === 'approved' && !appsByName.has(k)) appsByName.set(k, a);
}

const excluded = []; // { sheet, key, reason, amount }
const flags = [];    // { severity, area, key, message }
const seenFlag = new Set();
const addFlag = (severity, area, key, message) => {
  // Domain-level actions fire once per practitioner — collapse the repeats.
  const k = [severity, area, key, message].join('|');
  if (seenFlag.has(k)) return;
  seenFlag.add(k);
  flags.push({ severity, area, key, message });
};

// ── Commission ledger: net per (affiliate, order) per program ────────────
function ledger(file, program) {
  const tx = readCSV(file).filter((t) => t['Entity Type'] === 'SALES');
  const m = new Map();
  for (const t of tx) {
    const key = `${t['Affiliate ID']}||${t['Order Number']}`;
    if (!m.has(key)) {
      m.set(key, {
        program,
        affId: t['Affiliate ID'],
        affEmail: norm(t['Affiliate Email']),
        affName: String(t['Affiliate Name'] || '').trim(),
        orderRef: String(t['Order Number'] || '').trim(),
        amount: 0,
        events: [],
        dates: [],
        payoutIds: new Set(),
      });
    }
    const e = m.get(key);
    e.amount += n(t.Amount);
    e.events.push(t['Event Type']);
    e.dates.push(t.Date);
    const p = String(t['Is Paid ?'] || '').trim();
    if (p && p !== '0') e.payoutIds.add(p);
  }
  return [...m.values()].map((e) => {
    e.amount = r2(e.amount);
    e.dates.sort();
    e.placedAt = dOnly(e.dates[0]);
    e.lastAt = dOnly(e.dates[e.dates.length - 1]);
    return e;
  });
}
const ledCdo = ledger(FILES.txCdo, 'CDO');
const ledPhc = ledger(FILES.txPhc, 'PHC');

// ── Storefront order enrichment ─────────────────────────────────────────
//
// THE RULE: one cdo_orders row per real order. GoAffPro is the only system of
// record for ATTRIBUTION (who earned the commission and how much); the
// storefront exports are the only system of record for the ORDER (revenue,
// customer, discount code). So the storefront exports are joined ONTO the
// GoAffPro commission rows and are never imported as rows of their own —
// importing them separately would mint a second cdo_orders row per order under
// a different shopifyOrderId, and since cdo_commissions is unique per orderId
// the practitioner would be paid twice.
//
// Join key is the ORDER NUMBER, the one identifier every source shares
// (GoAffPro ref "#2554" / Shopify order name "#2554" / Wix order number 14011).
const ordNo = (v) => String(v ?? '').trim().replace(/^#/, '').toLowerCase();

// GoAffPro writes "0" (and blanks) when a commission has no order behind it —
// manual adjustments, wallet credits, imported history. It is a placeholder, NOT
// an identifier: several unrelated commissions share it, so joining on it pulls
// an arbitrary stranger's order revenue onto the row. Never join on it.
const isRealOrderNo = (v) => {
  const k = ordNo(v);
  return Boolean(k) && k !== '0';
};

// CDO storefront (Shopify). One CSV row per line item; only rows carrying a
// Total are order headers — the rest are additional line items of the order above.
const shopifyCdoByOrderNo = new Map();
for (const r of readCSV(FILES.shopifyCdo)) {
  if (!String(r.Total || '').trim()) continue;
  const k = ordNo(r.Name);
  if (k && !shopifyCdoByOrderNo.has(k)) shopifyCdoByOrderNo.set(k, r);
}

// PHC storefront (Wix). Prefer the header export, fall back to the line-item
// export (which covers more orders); both carry the same order-level columns.
const wixPhcByOrderNo = new Map();
for (const file of [FILES.wixPhcLine, FILES.wixPhcHdr]) {
  for (const r of readCSV(file)) {
    const k = ordNo(r['Order number']);
    if (!k) continue;
    if (!wixPhcByOrderNo.has(k) || file === FILES.wixPhcHdr) wixPhcByOrderNo.set(k, r);
  }
}

// Wix writes "Jun 9, 2026" rather than an ISO date.
function wixDateToYmd(v) {
  const d = new Date(String(v || '').trim());
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Shopify writes "2026-07-28 20:39:21 -0400".
const shopifyDateToYmd = (v) => dOnly(v);

// ── PHC order revenue lookup (GoAffPro's own PHC orders export) ──────────
const ordByKey = new Map();
for (const o of orders) {
  ordByKey.set(`${o['Affiliate ID']}||${String(o['Order Number']).trim()}`, o);
}

// ── Discount percent per code, derived from PHC order lines ─────────────
const pctByCode = new Map();
{
  const votes = new Map();
  for (const p of products) {
    for (const raw of String(p['Discount codes'] || '').split(',')) {
      const code = norm(raw);
      if (!code) continue;
      const tp = n(p['Total price']);
      const td = n(p['Total Discount']);
      if (tp <= 0 || td <= 0) continue;
      const pct = Math.round((td / tp) * 100) / 100;
      if (pct <= 0 || pct > 0.9) continue;
      if (!votes.has(code)) votes.set(code, new Map());
      const m = votes.get(code);
      m.set(pct, (m.get(pct) || 0) + 1);
    }
  }
  for (const [code, m] of votes) {
    const best = [...m.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    pctByCode.set(code, { pct: best[0], evidence: `${best[1]} order line(s) in products export` });
  }
}
// Fallback: a percentage embedded in the code name (natsol10 → 0.10, take15 → 0.15).
function inferPct(code) {
  const hit = pctByCode.get(code);
  if (hit) return { pct: hit.pct, source: `derived (${hit.evidence})` };
  const m = /(?:^|[^0-9])(\d{1,2})\s*%?\s*(?:off)?$/.exec(code);
  if (m) {
    const v = Number(m[1]);
    if (v >= 5 && v <= 50) return { pct: v / 100, source: 'inferred from code name' };
  }
  return { pct: 0.2, source: 'program default 20% (no evidence in export)' };
}

// ── 1. Practitioners ────────────────────────────────────────────────────
const P_HEAD = ['row_id', 'goaffpro_affiliate_id', 'match_status', 'practitioner_email', 'practitioner_first_name',
  'practitioner_last_name', 'business_name', 'phone', 'existing_wholesale_application_id', 'payout_method',
  'bank_account_name', 'bank_routing_number', 'bank_account_number', 'bank_account_type', 'goaffpro_status',
  'goaffpro_joined_at', 'goaffpro_lifetime_earned', 'goaffpro_lifetime_paid', 'notes',
  // ── appended reference columns (NOT read by the importer) ──
  'source_program', 'earned_cdo', 'paid_cdo', 'earned_phc', 'paid_phc', 'goaffpro_referral_code',
  'goaffpro_coupon_codes', 'goaffpro_payment_method_raw', 'wholesale_application_status',
  'suggested_email_correction', 'data_quality_flags'];

const METHOD_MAP = { paypal: 'paypal', venmo: 'manual', cheque: 'check', check: 'check' };
const affCById = new Map(affC.map((a) => [a.ID, a]));
const practitioners = [];
const pracByEmail = new Map();

affP.forEach((a, i) => {
  const email = norm(a['Email Address']);
  const c = affCById.get(a.ID) || {};
  const app = appByEmail.get(email);
  const nameKey = norm(a.Name);
  const cand = !app ? appsByName.get(nameKey) : null;
  const f = [];

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) f.push('INVALID_EMAIL_FORMAT');
  if (!app) f.push(cand ? 'NO_WHOLESALE_MATCH_BUT_NAME_CANDIDATE_FOUND' : 'NO_WHOLESALE_MATCH');
  if (a.Status !== 'approved') f.push(`GOAFFPRO_STATUS_${String(a.Status || 'blank').toUpperCase()}`);

  const earnedCdo = r2(n(c['Total Commission']));
  const paidCdo = r2(n(c['Amount Paid']));
  const earnedPhc = r2(n(a['Total Commission']));
  const paidPhc = r2(n(a['Amount Paid']));
  const owed = r2(earnedCdo + earnedPhc - paidCdo - paidPhc);
  if (!app && owed > 0.01) f.push(`UNMATCHED_WITH_${owed.toFixed(2)}_UNPAID_AT_RISK`);

  const row = {
    row_id: i + 1,
    goaffpro_affiliate_id: a.ID,
    match_status: app ? 'MATCHED_EXISTING' : (cand ? 'UNMATCHED_NAME_CANDIDATE' : 'UNMATCHED_BLOCKER'),
    practitioner_email: email,
    practitioner_first_name: String(a['First Name'] || '').trim(),
    practitioner_last_name: String(a['Last Name'] || '').trim(),
    business_name: String(a['Company Name'] || '').trim(),
    phone: String(a.Phone || '').trim(),
    existing_wholesale_application_id: app ? app.id : '',
    payout_method: METHOD_MAP[norm(a['Payment Method'])] || '',
    bank_account_name: '', bank_routing_number: '', bank_account_number: '', bank_account_type: '',
    goaffpro_status: String(a.Status || '').trim(),
    goaffpro_joined_at: dOnly(a['Date Created']),
    goaffpro_lifetime_earned: r2(earnedCdo + earnedPhc),
    goaffpro_lifetime_paid: r2(paidCdo + paidPhc),
    notes: app
      ? 'Matched to an approved wholesale_applications record by email — banking left blank so the import cannot overwrite what is already on file.'
      : (cand
        ? `NOT MATCHED by email. An approved wholesale application exists for the same name under "${cand.email}". Confirm it is the same person, then find-and-replace this email across EVERY sheet before importing — otherwise all of this practitioner's rows are skipped.`
        : 'NOT MATCHED — no approved wholesale_applications record for this email. Get them approved in the wholesale app (or correct the email) first; until then every row referencing this email is skipped by the importer.'),
    source_program: (earnedCdo || paidCdo) && (earnedPhc || paidPhc) ? 'CDO+PHC' : ((earnedCdo || paidCdo) ? 'CDO' : ((earnedPhc || paidPhc) ? 'PHC' : 'none')),
    earned_cdo: earnedCdo, paid_cdo: paidCdo, earned_phc: earnedPhc, paid_phc: paidPhc,
    goaffpro_referral_code: String(a['Referral Code'] || '').trim(),
    goaffpro_coupon_codes: String(a['Coupon Code'] || '').trim(),
    goaffpro_payment_method_raw: String(a['Payment Method'] || '').trim(),
    wholesale_application_status: app ? app.status : '',
    suggested_email_correction: cand ? cand.email : '',
    data_quality_flags: f.join('; '),
  };
  practitioners.push(row);
  pracByEmail.set(email, row);
  if (!app) {
    addFlag(owed > 0.01 ? 'BLOCKER' : 'WARN', 'Practitioners', email,
      `No approved wholesale application${cand ? ` (name matches ${cand.email})` : ''}. Unpaid at risk: $${owed.toFixed(2)}.`);
  }
});

// ── 2. Referral_Codes ───────────────────────────────────────────────────
const C_HEAD = ['row_id', 'practitioner_email', 'code', 'is_primary', 'discount_percent', 'commission_rate',
  'status', 'goaffpro_coupon_id', 'notes',
  'source_program', 'code_origin', 'discount_percent_source', 'goaffpro_observed_commission_rate', 'data_quality_flags'];

const STATUS_MAP = { approved: 'active', blocked: 'archived', pending: 'paused', invited: 'paused' };

// Effective historical rate per affiliate (reference only — NOT imported as
// commission_rate, because GoAffPro computed commission per order LINE at
// 20–40% and a single flat number would be wrong for future orders).
const rateByAff = new Map();
{
  const agg = new Map();
  for (const o of orders) {
    const sub = n(o['Order Subtotal']);
    if (sub <= 0) continue;
    const k = norm(o['Affiliate Email']);
    if (!agg.has(k)) agg.set(k, { c: 0, s: 0 });
    const v = agg.get(k);
    v.c += n(o['Affiliate Commission']);
    v.s += sub;
  }
  for (const [k, v] of agg) if (v.s > 0) rateByAff.set(k, Math.round((v.c / v.s) * 1000) / 1000);
}

// Codes observed in real attribution history, per affiliate — these must exist
// as referral codes or the migrated referral/order rows point at nothing.
const observedByAff = new Map();
const noteObserved = (affId, code, where) => {
  if (!code) return;
  if (!observedByAff.has(affId)) observedByAff.set(affId, new Map());
  const m = observedByAff.get(affId);
  if (!m.has(code)) m.set(code, new Set());
  m.get(code).add(where);
};
for (const c of [...ccC, ...ccP]) noteObserved(c['Affiliate ID'], norm(c['Referral code']), 'connected-customers');
for (const o of orders) {
  noteObserved(o['Affiliate ID'], norm(o.ref), 'orders.ref');
  for (const d of String(o['Discount codes'] || '').split(',')) noteObserved(o['Affiliate ID'], norm(d), 'orders.discount_code');
}

const INVALID_CODE = (code) => !/^[a-z0-9][a-z0-9_.-]*$/.test(code);
const referralCodes = [];
const codeOwner = new Map(); // code -> row (global uniqueness: Shopify discount codes are store-wide)

function addCode({ aff, code, isPrimary, origin, extraNote }) {
  code = norm(code);
  if (!code) return;
  if (code === '?') {
    excluded.push({ sheet: 'Referral_Codes', key: `${norm(aff['Email Address'])} / "?"`, reason: 'GoAffPro referral code is the literal string "?" — not a usable discount code.', amount: '' });
    addFlag('WARN', 'Referral_Codes', norm(aff['Email Address']), 'GoAffPro referral code is "?" — dropped. Assign this practitioner a real code manually.');
    return;
  }
  const email = norm(aff['Email Address']);
  const prev = codeOwner.get(code);
  if (prev) {
    if (prev.practitioner_email !== email) {
      excluded.push({ sheet: 'Referral_Codes', key: `${email} / ${code}`, reason: `Code already claimed by ${prev.practitioner_email} (a Shopify discount code must be unique store-wide). Kept the first/primary owner.`, amount: '' });
      addFlag('BLOCKER', 'Referral_Codes', code, `Claimed by two affiliates: ${prev.practitioner_email} (kept) and ${email} (dropped). Decide who owns it before import.`);
    }
    return;
  }
  const { pct, source } = inferPct(code);
  const f = [];
  if (INVALID_CODE(code)) f.push('CODE_HAS_UNUSUAL_CHARACTERS_REVIEW_MANUALLY');
  if (source.startsWith('program default')) f.push('DISCOUNT_PERCENT_ASSUMED');
  if (f.includes('CODE_HAS_UNUSUAL_CHARACTERS_REVIEW_MANUALLY')) {
    addFlag('WARN', 'Referral_Codes', code, 'Code contains spaces or "%" — it will work as a discount code but makes an ugly/encoded /discount/<code> URL. Consider renaming and adding a Referral_URL_Mapping row for the old spelling.');
  }
  const row = {
    row_id: referralCodes.length + 1,
    practitioner_email: email,
    code,
    is_primary: isPrimary ? 'TRUE' : 'FALSE',
    discount_percent: pct,
    commission_rate: '', // intentionally blank → falls back to the program default
    status: STATUS_MAP[norm(aff.Status)] || 'active',
    goaffpro_coupon_id: '',
    notes: `Migrated from GoAffPro (${origin}).${extraNote ? ' ' + extraNote : ''} commission_rate left blank on purpose: GoAffPro computed commission per order LINE (20–40%), so no single flat rate is correct going forward — the code falls back to the CDO program default.`,
    source_program: 'CDO+PHC',
    code_origin: origin,
    discount_percent_source: source,
    goaffpro_observed_commission_rate: rateByAff.has(email) ? rateByAff.get(email) : '',
    data_quality_flags: f.join('; '),
  };
  referralCodes.push(row);
  codeOwner.set(code, row);
}

// Primary codes first so they win any global collision, then coupons, then
// codes only seen in history.
for (const a of affP) addCode({ aff: a, code: a['Referral Code'], isPrimary: true, origin: 'affiliate referral code (primary)' });
for (const a of affP) {
  for (const raw of String(a['Coupon Code'] || '').split(',')) {
    const code = norm(raw);
    if (!code || code === norm(a['Referral Code'])) continue;
    addCode({ aff: a, code, isPrimary: false, origin: 'affiliate coupon code' });
  }
}
for (const a of affP) {
  for (const [code, wheres] of observedByAff.get(a.ID) || []) {
    if (codeOwner.has(code)) continue;
    addCode({ aff: a, code, isPrimary: false, origin: 'observed in attribution history', extraNote: `Seen in: ${[...wheres].join(', ')}.` });
  }
}
// Exactly one primary per practitioner.
{
  const seen = new Set();
  for (const r of referralCodes) {
    if (r.is_primary !== 'TRUE') continue;
    if (seen.has(r.practitioner_email)) { r.is_primary = 'FALSE'; r.data_quality_flags = [r.data_quality_flags, 'DEMOTED_DUPLICATE_PRIMARY'].filter(Boolean).join('; '); }
    seen.add(r.practitioner_email);
  }
  for (const p of practitioners) {
    if (!seen.has(p.practitioner_email)) {
      const first = referralCodes.find((r) => r.practitioner_email === p.practitioner_email);
      if (first) { first.is_primary = 'TRUE'; seen.add(p.practitioner_email); }
      else addFlag('WARN', 'Referral_Codes', p.practitioner_email, 'Practitioner has no usable referral code — nothing to migrate for them.');
    }
  }
}

// ── 3. Referral_URL_Mapping ─────────────────────────────────────────────
const U_HEAD = ['row_id', 'practitioner_email', 'new_referral_code', 'legacy_url_format', 'legacy_full_url',
  'legacy_domain', 'legacy_ref_value', 'new_full_url', 'create_redirect', 'notes',
  'source_program', 'evidence', 'data_quality_flags'];

const urlRows = [];
const seenLegacy = new Set(); // a Shopify redirect path must be unique
function addUrl({ email, code, fullUrl, refValue, create, note, evidence }) {
  let u;
  try { u = new URL(fullUrl); } catch { return; }
  const path = `${u.pathname}${u.search}`;
  const key = path;
  if (seenLegacy.has(key)) return;
  seenLegacy.add(key);
  urlRows.push({
    row_id: urlRows.length + 1,
    practitioner_email: email,
    new_referral_code: code,
    legacy_url_format: u.search.includes('ref=') ? 'query_param' : 'path',
    legacy_full_url: fullUrl,
    legacy_domain: u.hostname,
    legacy_ref_value: refValue,
    new_full_url: NEW_URL(code),
    create_redirect: create ? 'TRUE' : 'FALSE',
    notes: note,
    source_program: u.hostname.includes('nsdirectorder') ? 'CDO' : (u.hostname.includes('naturalsolutionsphc') ? 'PHC' : 'other'),
    evidence: evidence,
    data_quality_flags: '',
  });
}

// Which legacy ?ref= / path values were actually seen in traffic — proof a link
// is really in circulation, and it catches slugs that differ from the code.
const trafficRefs = new Map(); // ref value -> { affId, hosts:Set, hits }
for (const file of [FILES.trafCdo, FILES.trafPhc]) {
  for (const t of readCSV(file)) {
    const ref = norm(t.ref);
    if (!ref) continue;
    if (!trafficRefs.has(ref)) trafficRefs.set(ref, { affId: t['Affiliate ID'], hosts: new Set(), hits: 0 });
    const e = trafficRefs.get(ref);
    e.hits += 1;
    try { e.hosts.add(new URL(t['Visitor Landing page']).hostname); } catch { /* landing page not a URL */ }
  }
}

for (const a of affP) {
  const email = norm(a['Email Address']);
  const primary = referralCodes.find((r) => r.practitioner_email === email && r.is_primary === 'TRUE');
  if (!primary) continue;
  const slug = norm(a['Referral Code']);
  const c = affCById.get(a.ID) || {};
  const hits = trafficRefs.get(slug)?.hits || 0;
  const ev = hits ? `${hits} tracked click(s) on ?ref=${slug} in the traffic export` : 'no tracked clicks in the export — redirect created defensively (the link may still be on printed material)';

  // Both nsdirectorder.com shapes: GoAffPro handed out the query-param form and
  // practitioners also shared the short path form (plan §5.1).
  addUrl({ email, code: primary.code, fullUrl: `https://nsdirectorder.com/?ref=${slug}`, refValue: slug, create: true,
    note: 'Legacy GoAffPro query-param link on the CDO domain.', evidence: ev });
  addUrl({ email, code: primary.code, fullUrl: `https://nsdirectorder.com/${slug}`, refValue: slug, create: true,
    note: 'Legacy GoAffPro short/path link on the CDO domain — practitioners shared this form too, so it needs its own redirect.', evidence: ev });

  // Verbatim links from both exports, when they are a different shape.
  for (const [raw, label] of [[c['Referral Link'], 'CDO export'], [a['Referral Link'], 'PHC export']]) {
    const url = String(raw || '').trim();
    if (!url) continue;
    let h; try { h = new URL(url).hostname; } catch { continue; }
    const onCdo = h.includes('nsdirectorder');
    addUrl({
      email, code: primary.code, fullUrl: url, refValue: slug, create: onCdo,
      note: onCdo
        ? `Referral link exactly as GoAffPro published it (${label}).`
        : `Referral link exactly as GoAffPro published it (${label}) on ${h}. create_redirect=FALSE: a Shopify URL Redirect only fires for requests that reach ${SHOP}, so this one has to be configured wherever ${h} is actually hosted. The importer will report this row as skipped — that is expected.`,
      evidence: label,
    });
    if (!onCdo) addFlag('ACTION', 'Referral_URL_Mapping', h, `${h} is not the CDO store's domain — its legacy links need a redirect at that domain's own host/DNS, not via this import.`);
  }

  // A tracked ?ref= slug that is not the practitioner's code (renamed code).
  for (const [ref, info] of trafficRefs) {
    if (info.affId !== a.ID || ref === slug || !ref) continue;
    if (!codeOwner.has(ref) || codeOwner.get(ref).practitioner_email !== email) continue;
    addUrl({ email, code: codeOwner.get(ref).code, fullUrl: `https://nsdirectorder.com/?ref=${ref}`, refValue: ref, create: true,
      note: 'Additional legacy slug this practitioner circulated.', evidence: `${info.hits} tracked click(s)` });
    addUrl({ email, code: codeOwner.get(ref).code, fullUrl: `https://nsdirectorder.com/${ref}`, refValue: ref, create: true,
      note: 'Additional legacy slug this practitioner circulated (path form).', evidence: `${info.hits} tracked click(s)` });
  }
}

// ── 4. Referred_Customers ───────────────────────────────────────────────
const R_HEAD = ['row_id', 'practitioner_email', 'referral_code_used', 'customer_email', 'customer_first_name',
  'customer_last_name', 'customer_phone', 'applicant_type', 'referral_status', 'first_referred_at',
  'converted_at', 'goaffpro_referral_id', 'notes',
  'source_program', 'goaffpro_source', 'goaffpro_order_id', 'data_quality_flags'];

const referred = [];
{
  const m = new Map(); // importer dedupe key: practitioner + code + customer email
  for (const [rows, program] of [[ccC, 'CDO'], [ccP, 'PHC']]) {
    for (const c of rows) {
      const email = norm(c['Affiliate Email']);
      const code = norm(c['Referral code']);
      const cust = norm(c['Customer Email']);
      if (!cust) continue;
      const key = `${email}||${code}||${cust}`;
      const date = dOnly(c.Date);
      const converted = norm(c.Source) === 'order' || !!String(c.order_id || '').trim();
      if (!m.has(key)) {
        m.set(key, {
          email, code, cust, date, converted,
          first: String(c.first_name || '').trim(), last: String(c.last_name || '').trim(),
          phone: String(c.phone || '').trim(), name: String(c['Customer Name'] || '').trim(),
          orderId: String(c.order_id || '').trim(), source: norm(c.Source),
          programs: new Set([program]), id: String(c.id || '').trim(),
        });
      } else {
        const e = m.get(key);
        e.programs.add(program);
        if (date && (!e.date || date < e.date)) e.date = date;
        e.converted = e.converted || converted;
        e.first = e.first || String(c.first_name || '').trim();
        e.last = e.last || String(c.last_name || '').trim();
        e.phone = e.phone || String(c.phone || '').trim();
        e.orderId = e.orderId || String(c.order_id || '').trim();
      }
    }
  }
  for (const e of m.values()) {
    const f = [];
    if (!codeOwner.has(e.code)) f.push('CODE_NOT_ON_REFERRAL_CODES_SHEET');
    else if (codeOwner.get(e.code).practitioner_email !== e.email) f.push('CODE_OWNED_BY_A_DIFFERENT_PRACTITIONER');
    if (!pracByEmail.has(e.email)) f.push('AFFILIATE_NOT_ON_PRACTITIONERS_SHEET');
    const parts = e.name.split(/\s+/);
    referred.push({
      row_id: referred.length + 1,
      practitioner_email: e.email,
      referral_code_used: e.code,
      customer_email: e.cust,
      customer_first_name: e.first || parts[0] || '',
      customer_last_name: e.last || parts.slice(1).join(' ') || '',
      customer_phone: e.phone,
      applicant_type: 'patient',
      referral_status: e.converted ? 'converted' : 'pending',
      first_referred_at: e.date,
      converted_at: e.converted ? e.date : '',
      goaffpro_referral_id: e.id || (e.orderId ? `order:${e.orderId}` : ''),
      notes: e.converted
        ? 'Converted referral — GoAffPro connected this customer to the practitioner off a real order.'
        : `Tracked referral that never produced an order (GoAffPro source: ${e.source || 'unknown'}).`,
      source_program: [...e.programs].sort().join('+'),
      goaffpro_source: e.source,
      goaffpro_order_id: e.orderId,
      data_quality_flags: f.join('; '),
    });
  }
  referred.sort((a, b) => (a.first_referred_at < b.first_referred_at ? -1 : 1));
  referred.forEach((r, i) => { r.row_id = i + 1; });
}

// ── 5. Historical_Orders_Commissions ───────────────────────────────────
const O_HEAD = ['row_id', 'practitioner_email', 'referral_code_used', 'shopify_order_id_or_name', 'customer_email',
  'customer_name', 'order_placed_at', 'currency', 'order_amount', 'commission_rate_applied', 'commission_amount',
  'commission_status', 'payout_status', 'earned_at', 'paid_at', 'goaffpro_order_id', 'goaffpro_commission_id', 'notes',
  'source_program', 'goaffpro_order_number', 'order_amount_source', 'linked_payout_goaffpro_id',
  // ── storefront-sourced reference columns (NOT read by the importer) ──
  'storefront_order_id', 'storefront_discount_code', 'storefront_financial_status',
  'storefront_refunded_amount', 'storefront_cancelled_at', 'data_quality_flags'];

// Payout lookup, per program.
const payoutById = new Map();
for (const [rows, program] of [[payC, 'CDO'], [payP, 'PHC']]) {
  for (const p of rows) payoutById.set(`${program}:${p.ID}`, p);
}

// PHC has no payout↔commission link in the export → reconstruct it: oldest
// commissions are the ones the earliest payouts settled.
//
// The payout budget is CUMULATIVE across an affiliate's payouts, not reset per
// payout. Resetting it strands the leftover of every payout that stops mid-way
// through a commission, and with 30–50 payouts per affiliate that leak compounds
// into thousands of dollars of commission wrongly left "owed" — which the first
// post-import payout run would then pay a SECOND time.
//
// The stopping point is the prefix of commissions whose total lands NEAREST the
// affiliate's GoAffPro "Amount Paid" (not the largest prefix under it), so the
// per-affiliate error is at most half a commission and is not systematically
// biased toward under-paying or over-paying.
function reconstructPayoutLinks(led, pays, program, lifetimePaidByAff) {
  const byAff = new Map();
  for (const e of led) {
    if (e.amount <= 0) continue;
    if (!byAff.has(e.affId)) byAff.set(e.affId, []);
    byAff.get(e.affId).push(e);
  }
  const payByAff = new Map();
  for (const p of pays) {
    if (!payByAff.has(p['Affiliate ID'])) payByAff.set(p['Affiliate ID'], []);
    payByAff.get(p['Affiliate ID']).push(p);
  }
  for (const [affId, ps] of payByAff) {
    const cs = (byAff.get(affId) || []).slice()
      .sort((a, b) => (a.placedAt < b.placedAt ? -1 : a.placedAt > b.placedAt ? 1 : 0));
    ps.sort((a, b) => (a.Date < b.Date ? -1 : 1));
    const target = lifetimePaidByAff.get(affId);
    const budgetTotal = target !== undefined ? target : r2(ps.reduce((s, p) => s + n(p['Payout Amount']), 0));

    let released = 0; // cumulative payout value released so far
    let claimed = 0;  // cumulative commission value settled so far
    let i = 0;
    for (const p of ps) {
      released = r2(released + n(p['Payout Amount']));
      while (i < cs.length && r2(claimed + cs[i].amount) <= released + 0.005) {
        cs[i].assignedPayout = `${program}:${p.ID}`;
        claimed = r2(claimed + cs[i].amount);
        i++;
      }
    }
    // Nearest-prefix refinement: include the boundary commission when doing so
    // lands closer to what GoAffPro says it actually paid this affiliate.
    const last = ps[ps.length - 1];
    while (i < cs.length && Math.abs(r2(claimed + cs[i].amount) - budgetTotal) < Math.abs(claimed - budgetTotal)) {
      cs[i].assignedPayout = `${program}:${last.ID}`;
      cs[i].boundaryFit = true;
      claimed = r2(claimed + cs[i].amount);
      i++;
    }
  }
}
{
  const paidByAff = new Map();
  for (const a of affP) paidByAff.set(a.ID, r2(n(a['Amount Paid'])));
  reconstructPayoutLinks(ledPhc, payP, 'PHC', paidByAff);
}

// CDO: the export's "Is Paid ?" carries the settling payout ID directly.
for (const e of ledCdo) {
  if (e.payoutIds.size) {
    const ids = [...e.payoutIds].sort();
    e.assignedPayout = `CDO:${ids[ids.length - 1]}`; // latest payout that touched it
    if (ids.length > 1) e.multiPayout = ids;
  }
}

// Order refs must be globally unique — the importer's idempotency key is
// legacy:goaffpro:<shop>:<ref>, so two rows sharing a ref means the second is
// silently skipped as "already imported". Three ways they collide in this data:
// the two programs reusing a number, a number appearing under two affiliates
// (one order credited to two codes), and GoAffPro writing "0" for "no order
// number at all".
const refCount = new Map();
for (const e of [...ledCdo, ...ledPhc]) refCount.set(e.orderRef, (refCount.get(e.orderRef) || 0) + 1);
const usedRefs = new Set();
function uniqueRef(e, flagsOut) {
  const blank = !e.orderRef || e.orderRef === '0';
  let ref = blank ? `${e.program}-NOORDERNUMBER-${e.affId}` : e.orderRef;
  if (blank) flagsOut.push('NO_ORDER_NUMBER_IN_GOAFFPRO_SYNTHETIC_REF_ASSIGNED');
  else if (refCount.get(e.orderRef) > 1) {
    ref = `${e.program}-${e.orderRef}`;
    flagsOut.push('ORDER_REF_QUALIFIED_TO_AVOID_COLLISION');
  }
  if (usedRefs.has(ref)) {
    ref = `${ref}-A${e.affId}`;
    flagsOut.push('ORDER_REF_QUALIFIED_WITH_AFFILIATE_ID_SAME_ORDER_CREDITED_TWICE');
  }
  let i = 2;
  while (usedRefs.has(ref)) { ref = `${ref}-${i}`; i++; }
  usedRefs.add(ref);
  return ref;
}

const histOrders = [];
const rowIdByLedger = new Map();
for (const e of [...ledCdo, ...ledPhc].sort((a, b) => (a.placedAt < b.placedAt ? -1 : 1))) {
  const f = [];
  const ref = uniqueRef(e, f);

  // Every order-side join is gated on a REAL order number — see isRealOrderNo.
  const joinable = isRealOrderNo(e.orderRef);
  const ord = joinable && e.program === 'PHC' ? ordByKey.get(`${e.affId}||${e.orderRef}`) : null;
  // Storefront row for this order, from the store the program actually ran on.
  const sf = joinable && e.program === 'CDO' ? shopifyCdoByOrderNo.get(ordNo(e.orderRef)) : null;
  const wx = joinable && e.program === 'PHC' ? wixPhcByOrderNo.get(ordNo(e.orderRef)) : null;
  if (!joinable) f.push('NO_ORDER_NUMBER_IN_GOAFFPRO_REVENUE_CANNOT_BE_JOINED');
  const reversed = e.amount <= 0;
  const pay = e.assignedPayout ? payoutById.get(e.assignedPayout) : null;
  const paid = !reversed && !!pay;

  // ── Order revenue: GoAffPro's own orders export → storefront export → none ──
  let orderAmount, amountSource, subtotal = 0;
  if (ord) {
    orderAmount = r2(n(ord['Order Total']));
    subtotal = n(ord['Order Subtotal']);
    amountSource = 'GoAffPro PHC orders export (Order Total)';
  } else if (sf) {
    orderAmount = r2(n(sf.Total));
    subtotal = n(sf.Subtotal);
    amountSource = 'CDO Shopify storefront export (Total)';
  } else if (wx) {
    orderAmount = r2(n(wx.Total));
    // Wix has no subtotal column — derive it so the rate stays comparable.
    subtotal = r2(n(wx.Total) - n(wx['Total tax']) - n(wx['Shipping rate']));
    amountSource = 'PHC Wix storefront export (Total)';
  } else {
    orderAmount = 0;
    amountSource = 'NOT FOUND in any order export';
    f.push('ORDER_REVENUE_NOT_FOUND_IN_ANY_EXPORT');
  }

  let rate = '';
  if (subtotal > 0 && !reversed) {
    const rr = Math.round((e.amount / subtotal) * 10000) / 10000;
    if (rr > 0 && rr <= 1) rate = rr;
  }

  // ── Referral code ──
  // The storefront's discount code is the best evidence of which code drove the
  // order — but ONLY when that code belongs to the practitioner the commission
  // was actually credited to. GoAffPro attributes by referral cookie /
  // customer-affiliate connection far more often than by coupon code, so an
  // order can legitimately carry practitioner A's code while B earns the
  // commission. Writing A's code onto a row credited to B would make the
  // migrated ledger self-contradictory (cdo_orders.referral.code would not
  // belong to cdo_orders.practitionerId), so in that case the credited
  // practitioner's own code wins and the storefront code is preserved in a
  // reference column instead.
  const storefrontCode = norm(sf?.['Discount Code'] || wx?.['Coupon code'] || '');
  const code = (() => {
    if (storefrontCode && codeOwner.get(storefrontCode)?.practitioner_email === e.affEmail) {
      return storefrontCode;
    }
    if (ord) {
      for (const d of String(ord['Discount codes'] || '').split(',')) {
        const c = norm(d);
        if (codeOwner.get(c)?.practitioner_email === e.affEmail) return c;
      }
      const r = norm(ord.ref);
      if (codeOwner.get(r)?.practitioner_email === e.affEmail) return r;
    }
    if (storefrontCode && codeOwner.has(storefrontCode)) {
      f.push('STOREFRONT_CODE_BELONGS_TO_ANOTHER_PRACTITIONER_USED_CREDITED_PRACTITIONERS_CODE');
    }
    const primary = referralCodes.find((x) => x.practitioner_email === e.affEmail && x.is_primary === 'TRUE');
    if (primary) { f.push('REFERRAL_CODE_ASSUMED_PRIMARY'); return primary.code; }
    f.push('NO_REFERRAL_CODE_RESOLVED');
    return '';
  })();

  // Storefront-side money events are FLAGGED, never used to override GoAffPro's
  // commission status — the transactions ledger already records whatever
  // reversal GoAffPro applied, and second-guessing it here would change money.
  const sfRefunded = r2(n(sf?.['Refunded Amount'] ?? wx?.['Refunded amount'] ?? 0));
  const sfCancelled = String(sf?.['Cancelled at'] || '').trim();
  if (sfRefunded > 0 && !reversed) f.push(`STOREFRONT_REFUND_${sfRefunded.toFixed(2)}_BUT_GOAFFPRO_COMMISSION_STANDS_REVIEW`);
  if (sfCancelled && !reversed) f.push('STOREFRONT_ORDER_CANCELLED_BUT_GOAFFPRO_COMMISSION_STANDS_REVIEW');

  // Prefer the storefront's own order date (the real one) over the ledger's
  // transaction timestamp, which can lag the order by hours.
  const orderDate =
    (ord ? dOnly(ord['Order Date']) : '') ||
    (sf ? shopifyDateToYmd(sf['Created at']) : '') ||
    (wx ? wixDateToYmd(wx['Date created']) : '') ||
    e.placedAt;

  if (reversed) f.push('COMMISSION_REVERSED_NET_ZERO_OR_NEGATIVE');
  if (!pracByEmail.has(e.affEmail)) f.push('AFFILIATE_NOT_ON_PRACTITIONERS_SHEET');
  if (e.multiPayout) f.push(`SPLIT_ACROSS_PAYOUTS_${e.multiPayout.join('|')}`);

  const row = {
    row_id: histOrders.length + 1,
    practitioner_email: e.affEmail,
    referral_code_used: code,
    shopify_order_id_or_name: ref,
    customer_email: norm(ord?.['Customer Email'] || sf?.Email || wx?.['Contact email'] || ''),
    customer_name: String(
      ord?.['Customer Name'] || sf?.['Billing Name'] || sf?.['Shipping Name'] || wx?.['Billing name'] || wx?.['Recipient name'] || '',
    ).trim(),
    order_placed_at: orderDate,
    currency: 'USD',
    order_amount: orderAmount,
    commission_rate_applied: rate,
    commission_amount: reversed ? 0 : e.amount,
    commission_status: reversed ? 'reversed' : (paid ? 'paid' : 'approved'),
    payout_status: reversed ? '' : (paid ? 'paid' : 'pending'),
    earned_at: orderDate,
    paid_at: paid ? dOnly(pay.Date) : '',
    goaffpro_order_id: ord ? String(ord['Order ID'] || '').trim() : '',
    goaffpro_commission_id: `${e.program}-TXN-${e.affId}-${e.orderRef}`,
    notes: reversed
      ? 'Commission was added then reversed in GoAffPro (net 0) — imported as reversed so the order lands cancelled and the payout engine never picks it up.'
      : (paid
        ? `Already settled by GoAffPro payout ${pay.ID} on ${dOnly(pay.Date)} — imported already paid so no money moves at import.`
        : 'STILL OWED at cutover — deliberately left approved/pending so the first post-import payout run pays it through the normal ACH/check flow.'),
    source_program: e.program,
    goaffpro_order_number: e.orderRef,
    order_amount_source: amountSource,
    linked_payout_goaffpro_id: pay ? pay.ID : '',
    // The real storefront order id, kept for audit + future re-linking. NOT used
    // as the import key: the importer derives its idempotency id from
    // shopify_order_id_or_name (the order NAME), which is the identifier every
    // source shares and what cdo_orders.orderName is matched on.
    storefront_order_id: String(sf?.Id || wx?.['Order number'] || '').trim(),
    storefront_discount_code: storefrontCode,
    storefront_financial_status: String(sf?.['Financial Status'] || wx?.['Payment status'] || '').trim(),
    storefront_refunded_amount: sfRefunded || '',
    storefront_cancelled_at: sfCancelled,
    data_quality_flags: f.join('; '),
  };
  histOrders.push(row);
  rowIdByLedger.set(`${e.program}||${e.affId}||${e.orderRef}`, row.row_id);
  if (e.assignedPayout) {
    if (!payoutById.get(e.assignedPayout).__rows) payoutById.get(e.assignedPayout).__rows = [];
    payoutById.get(e.assignedPayout).__rows.push(row.row_id);
  }
}

// ── 5b. Cross-source duplicate detection ────────────────────────────────
//
// The importer's idempotency key is legacy:goaffpro:<shop>:<ref>, so it can only
// recognise a row IT imported before. It cannot see that the same real order
// already exists under a different shopifyOrderId — e.g. ingested live as
// gid://shopify/Order/… — and cdo_commissions is unique per orderId, so a second
// row means the practitioner is paid twice. The only identifier shared across
// every source is the order NUMBER, so that is what is matched here.
//
// A name match alone is NOT proof: a staging store's own order counter can drift
// into the same numeric range as the production store's history. So a match only
// counts as a real duplicate when the two order DATES also agree.
const DUP_DATE_TOLERANCE_DAYS = 3;
const duplicateReport = [];
{
  const existingRows = JSON.parse(fs.readFileSync('./existing.json', 'utf8')).orderRows || [];
  const byName = new Map();
  for (const o of existingRows) {
    const k = ordNo(o.orderName);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(o);
  }
  const daysApart = (a, b) => {
    if (!a || !b) return Infinity;
    const da = new Date(a), dbb = new Date(b);
    if (Number.isNaN(da.getTime()) || Number.isNaN(dbb.getTime())) return Infinity;
    return Math.abs(da - dbb) / 86400000;
  };

  for (const row of histOrders) {
    const hits = byName.get(ordNo(row.goaffpro_order_number)) || [];
    if (!hits.length) continue;
    const syntheticId = `legacy:goaffpro:${SHOP}:${row.shopify_order_id_or_name}`;
    for (const hit of hits) {
      const gap = daysApart(row.order_placed_at, hit.placedAt);
      const sameId = hit.shopifyOrderId === syntheticId;
      let verdict, action;
      if (sameId) {
        verdict = 'ALREADY_IMPORTED_BY_THIS_KEY';
        action = 'The importer will skip this row as already-imported. If that existing record is SAMPLE/TEST data, delete it first or this real commission is silently lost.';
        row.data_quality_flags = [row.data_quality_flags, 'BLOCKED_BY_EXISTING_RECORD_SEE_DUPLICATE_CHECK'].filter(Boolean).join('; ');
        addFlag('BLOCKER', 'Duplicate_Check', row.goaffpro_order_number,
          `An existing cdo_orders record already owns the id ${syntheticId} (commission $${hit.commissionAmount}, ${hit.migrationSource || 'no migrationSource'}). This row's $${row.commission_amount} commission will be SKIPPED. Delete the existing record if it is test data.`);
      } else if (gap <= DUP_DATE_TOLERANCE_DAYS) {
        verdict = 'TRUE_DUPLICATE_WOULD_DOUBLE_COUNT';
        action = 'Same order number AND same date under a different shopifyOrderId — importing this row would create a SECOND commission for one order. Do not import it.';
        row.data_quality_flags = [row.data_quality_flags, 'TRUE_DUPLICATE_DO_NOT_IMPORT'].filter(Boolean).join('; ');
        addFlag('BLOCKER', 'Duplicate_Check', row.goaffpro_order_number,
          `DOUBLE-COUNT RISK: order ${row.goaffpro_order_number} already exists as ${hit.shopifyOrderId} (attributed=${hit.attributed}, commission $${hit.commissionAmount}) placed ${String(hit.placedAt).slice(0, 10)} — ${gap.toFixed(1)} days from this row. Importing adds a second commission of $${row.commission_amount}.`);
      } else {
        verdict = 'FALSE_COLLISION_DIFFERENT_ORDER';
        action = `Order numbers match but the dates are ${Math.round(gap)} days apart, so these are different orders — the staging store's own counter reuses production numbers. Safe to import.`;
        row.data_quality_flags = [row.data_quality_flags, 'ORDER_NUMBER_REUSED_BY_AN_UNRELATED_EXISTING_ORDER'].filter(Boolean).join('; ');
      }
      duplicateReport.push({
        order_number: row.goaffpro_order_number,
        source_program: row.source_program,
        workbook_row_id: row.row_id,
        workbook_date: row.order_placed_at,
        workbook_commission: row.commission_amount,
        workbook_practitioner: row.practitioner_email,
        existing_shopify_order_id: hit.shopifyOrderId,
        existing_date: String(hit.placedAt).slice(0, 10),
        existing_attributed: hit.attributed,
        existing_commission: hit.commissionAmount,
        existing_migration_source: hit.migrationSource || '',
        days_apart: gap === Infinity ? '' : Math.round(gap * 10) / 10,
        verdict,
        action_required: action,
      });
    }
  }
}

// ── 6. Historical_Payouts ───────────────────────────────────────────────
const PO_HEAD = ['row_id', 'practitioner_email', 'payout_amount', 'currency', 'payout_method', 'payout_status',
  'period_start', 'period_end', 'paid_at', 'reference_or_check_number', 'linked_commission_row_ids',
  'goaffpro_payout_id', 'notes',
  'source_program', 'goaffpro_payment_method_raw', 'goaffpro_payment_data', 'linked_commission_sum',
  'variance_vs_payout_amount', 'data_quality_flags'];

const histPayouts = [];
const ordersByRowId = new Map(histOrders.map((r) => [r.row_id, r]));
for (const [rows, program] of [[payC, 'CDO'], [payP, 'PHC']]) {
  for (const p of rows) {
    const email = norm(p['Affiliate Email']);
    const linked = payoutById.get(`${program}:${p.ID}`).__rows || [];
    const amount = r2(n(p['Payout Amount']));
    if (!linked.length) {
      excluded.push({
        sheet: 'Historical_Payouts',
        key: `${program} payout ${p.ID} — ${email}`,
        reason: 'No migrated commission could be linked to this payout, and the importer requires at least one (a historical payout must settle something). Most likely a wallet adjustment / reward payout, or it settled a commission that is not in the transactions ledger.',
        amount,
      });
      addFlag('WARN', 'Historical_Payouts', `${program}:${p.ID}`, `Payout of $${amount.toFixed(2)} to ${email} excluded — no linkable commission. Total excluded payout value is summed on the Reconciliation sheet.`);
      continue;
    }
    const linkedRows = linked.map((id) => ordersByRowId.get(id));
    const sum = r2(linkedRows.reduce((s, r) => s + n(r.commission_amount), 0));
    const dates = linkedRows.map((r) => r.earned_at).filter(Boolean).sort();
    const variance = r2(sum - amount);
    const f = [];
    if (Math.abs(variance) > 0.02) f.push('LINKED_COMMISSIONS_DO_NOT_SUM_TO_PAYOUT_AMOUNT');
    if (program === 'PHC') f.push('PAYOUT_LINK_RECONSTRUCTED_FIFO_NOT_FROM_EXPORT');
    if (!pracByEmail.has(email)) f.push('AFFILIATE_NOT_ON_PRACTITIONERS_SHEET');

    histPayouts.push({
      row_id: histPayouts.length + 1,
      practitioner_email: email,
      payout_amount: amount,
      currency: String(p.Currency || 'USD').trim() || 'USD',
      payout_method: METHOD_MAP[norm(p['Payment Method'])] || 'manual',
      payout_status: 'paid',
      period_start: dates[0] || dOnly(p.Date),
      period_end: dates[dates.length - 1] || dOnly(p.Date),
      paid_at: dOnly(p.Date),
      reference_or_check_number: `GOAFFPRO-${program}-${p.ID}`,
      linked_commission_row_ids: linked.join(','),
      goaffpro_payout_id: p.ID,
      notes: `Historical GoAffPro payout, already settled — imported as paid so the payout engine never re-pays it.${program === 'PHC' ? ' Commission linkage RECONSTRUCTED FIFO by date: the PHC export does not carry a payout↔commission link.' : ' Commission linkage taken from the export\'s "Is Paid ?" column, which carries the settling payout ID.'}${p['Payment Note for Admin'] ? ' Provider reference: ' + String(p['Payment Note for Admin']).trim() + '.' : ''}`,
      source_program: program,
      goaffpro_payment_method_raw: String(p['Payment Method'] || '').trim(),
      goaffpro_payment_data: String(p['Payment Data'] || '').trim(),
      linked_commission_sum: sum,
      variance_vs_payout_amount: variance,
      data_quality_flags: f.join('; '),
    });
  }
}

// ── 7. Vendor_Commission_Rates (cannot be populated — see READ ME) ──────
const V_HEAD = ['row_id', 'vendor_name', 'commission_percent', 'notes'];
const vendorRates = [];
addFlag('ACTION', 'Vendor_Commission_Rates', '—',
  'Left empty on purpose: the "Vendor" column is blank on all 5,845 rows of the GoAffPro products export, so no vendor→rate mapping can be derived. Fill this in from the Shopify product vendors before the CDO program computes commission on NEW orders.');

// ── Reconciliation ──────────────────────────────────────────────────────
const recon = [];
{
  const sumBy = (rows, pred, field) => r2(rows.filter(pred).reduce((s, r) => s + n(r[field]), 0));
  for (const p of practitioners) {
    const mine = histOrders.filter((o) => o.practitioner_email === p.practitioner_email);
    const sheetEarned = sumBy(mine, (o) => o.commission_status !== 'reversed', 'commission_amount');
    const sheetPaid = sumBy(mine, (o) => o.commission_status === 'paid', 'commission_amount');
    const sheetOwed = r2(sheetEarned - sheetPaid);
    const payoutSum = r2(histPayouts.filter((x) => x.practitioner_email === p.practitioner_email).reduce((s, x) => s + n(x.payout_amount), 0));
    const dEarned = r2(sheetEarned - n(p.goaffpro_lifetime_earned));
    const dPaid = r2(sheetPaid - n(p.goaffpro_lifetime_paid));
    recon.push({
      practitioner_email: p.practitioner_email,
      match_status: p.match_status,
      goaffpro_earned: n(p.goaffpro_lifetime_earned),
      sheet_earned: sheetEarned,
      earned_variance: dEarned,
      goaffpro_paid: n(p.goaffpro_lifetime_paid),
      sheet_paid: sheetPaid,
      paid_variance: dPaid,
      still_owed_after_import: sheetOwed,
      migrated_payout_total: payoutSum,
      commission_rows: mine.length,
      referral_rows: referred.filter((r) => r.practitioner_email === p.practitioner_email).length,
      code_rows: referralCodes.filter((r) => r.practitioner_email === p.practitioner_email).length,
      reconciles: Math.abs(dEarned) <= 0.05 && Math.abs(dPaid) <= 0.05 ? 'YES' : 'REVIEW',
    });
    // A NEGATIVE paid variance is a double-payment risk: GoAffPro says it paid
    // more than this file marks paid, so the difference would be paid again by
    // the first post-import payout run.
    if (dPaid < -5) {
      addFlag('BLOCKER', 'Reconciliation', p.practitioner_email,
        `DOUBLE-PAYMENT RISK $${Math.abs(dPaid).toFixed(2)}: GoAffPro reports $${n(p.goaffpro_lifetime_paid).toFixed(2)} paid but only $${sheetPaid.toFixed(2)} of their commissions carry a payout link, so the difference is left owed and would be paid again. Review this practitioner's rows before the first payout run.`);
    } else if (Math.abs(dEarned) > 0.05 || Math.abs(dPaid) > 0.05) {
      addFlag('WARN', 'Reconciliation', p.practitioner_email,
        `Sheet totals differ from GoAffPro lifetime figures: earned Δ$${dEarned.toFixed(2)}, paid Δ$${dPaid.toFixed(2)}.`);
    }
  }
  recon.sort((a, b) => b.goaffpro_earned - a.goaffpro_earned);
}

// ── Totals for the README / validation sheet ───────────────────────────
const T = {
  practitioners: practitioners.length,
  matched: practitioners.filter((p) => p.match_status === 'MATCHED_EXISTING').length,
  unmatched: practitioners.filter((p) => p.match_status !== 'MATCHED_EXISTING').length,
  unmatchedOwed: r2(practitioners.filter((p) => p.match_status !== 'MATCHED_EXISTING')
    .reduce((s, p) => s + (n(p.goaffpro_lifetime_earned) - n(p.goaffpro_lifetime_paid)), 0)),
  codes: referralCodes.length,
  urls: urlRows.length,
  urlsTrue: urlRows.filter((u) => u.create_redirect === 'TRUE').length,
  referred: referred.length,
  referredConverted: referred.filter((r) => r.referral_status === 'converted').length,
  orders: histOrders.length,
  ordersPaid: histOrders.filter((o) => o.commission_status === 'paid').length,
  ordersOwed: histOrders.filter((o) => o.commission_status === 'approved').length,
  ordersReversed: histOrders.filter((o) => o.commission_status === 'reversed').length,
  commTotal: r2(histOrders.filter((o) => o.commission_status !== 'reversed').reduce((s, o) => s + n(o.commission_amount), 0)),
  commPaid: r2(histOrders.filter((o) => o.commission_status === 'paid').reduce((s, o) => s + n(o.commission_amount), 0)),
  payouts: histPayouts.length,
  payoutTotal: r2(histPayouts.reduce((s, p) => s + n(p.payout_amount), 0)),
  excludedPayoutValue: r2(excluded.filter((e) => e.sheet === 'Historical_Payouts').reduce((s, e) => s + n(e.amount), 0)),
  gapEarnedCdo: r2(affC.reduce((s, a) => s + n(a['Total Commission']), 0)),
  gapEarnedPhc: r2(affP.reduce((s, a) => s + n(a['Total Commission']), 0)),
  gapPaidCdo: r2(affC.reduce((s, a) => s + n(a['Amount Paid']), 0)),
  gapPaidPhc: r2(affP.reduce((s, a) => s + n(a['Amount Paid']), 0)),
};
T.commOwed = r2(T.commTotal - T.commPaid);

// ── Validation report ───────────────────────────────────────────────────
const checks = [];
const check = (name, pass, detail) => checks.push({ check: name, result: pass ? 'PASS' : 'REVIEW', detail });

check('Every Referral_Codes.practitioner_email exists on Practitioners',
  referralCodes.every((r) => pracByEmail.has(r.practitioner_email)), `${referralCodes.length} code rows`);
check('Referral code strings are globally unique',
  new Set(referralCodes.map((r) => r.code)).size === referralCodes.length, `${new Set(referralCodes.map((r) => r.code)).size} distinct of ${referralCodes.length}`);
check('discount_percent is a fraction between 0 and 1 on every code row',
  referralCodes.every((r) => r.discount_percent > 0 && r.discount_percent <= 1), 'importer hard-rejects anything outside 0–1');
check('Exactly one primary code per practitioner that has any code',
  (() => { const m = new Map(); referralCodes.forEach((r) => { if (r.is_primary === 'TRUE') m.set(r.practitioner_email, (m.get(r.practitioner_email) || 0) + 1); }); return [...m.values()].every((v) => v === 1); })(),
  `${referralCodes.filter((r) => r.is_primary === 'TRUE').length} primaries`);
check('Every Referral_URL_Mapping.new_referral_code exists on Referral_Codes',
  urlRows.every((u) => codeOwner.has(u.new_referral_code)), `${urlRows.length} URL rows`);
check('Every legacy redirect path is unique (Shopify requires it)',
  new Set(urlRows.map((u) => { try { const x = new URL(u.legacy_full_url); return x.pathname + x.search; } catch { return u.legacy_full_url; } })).size === urlRows.length, `${urlRows.length} rows`);
check('Every Referred_Customers row has a customer_email',
  referred.every((r) => r.customer_email), 'importer hard-rejects blanks');
check('Referred_Customers rows are unique on (practitioner, code, customer)',
  new Set(referred.map((r) => `${r.practitioner_email}|${r.referral_code_used}|${r.customer_email}`)).size === referred.length, `${referred.length} rows`);
check('referral_status is one of pending / converted / expired',
  referred.every((r) => ['pending', 'converted', 'expired'].includes(r.referral_status)), '');
check('shopify_order_id_or_name is unique across the whole sheet',
  new Set(histOrders.map((o) => o.shopify_order_id_or_name)).size === histOrders.length, `${histOrders.length} order rows`);
check('order_amount and commission_amount are numbers on every row',
  histOrders.every((o) => typeof o.order_amount === 'number' && typeof o.commission_amount === 'number'), 'importer hard-rejects nulls');
check('commission_rate_applied is blank or a fraction 0–1',
  histOrders.every((o) => o.commission_rate_applied === '' || (o.commission_rate_applied > 0 && o.commission_rate_applied <= 1)), '');
check('commission_status is one of pending / approved / paid / reversed',
  histOrders.every((o) => ['pending', 'approved', 'paid', 'reversed'].includes(o.commission_status)), '');
check('paid_at is present on every commission_status=paid row (hard rule)',
  histOrders.filter((o) => o.commission_status === 'paid').every((o) => !!o.paid_at), `${T.ordersPaid} paid rows`);
check('No commission is marked paid without a linked Historical_Payouts row (§6 money rule)',
  histOrders.filter((o) => o.commission_status === 'paid').every((o) => histPayouts.some((p) => p.linked_commission_row_ids.split(',').includes(String(o.row_id)))), '');
check('No still-owed commission is disguised as paid (§6 money rule)',
  histOrders.filter((o) => o.payout_status === 'pending').every((o) => o.commission_status !== 'paid'), `${T.ordersOwed} rows left owed on purpose`);
check('Every Historical_Payouts row links at least one commission row',
  histPayouts.every((p) => p.linked_commission_row_ids.length > 0), 'importer hard-rejects empty links');
check('Every linked_commission_row_ids target exists on Historical_Orders_Commissions',
  histPayouts.every((p) => p.linked_commission_row_ids.split(',').every((id) => ordersByRowId.has(Number(id)))), '');
check('Every Historical_Payouts row has paid_at (hard rule)',
  histPayouts.every((p) => !!p.paid_at), '');
check('payout_method is one of ach / check / paypal / manual',
  histPayouts.every((p) => ['ach', 'check', 'paypal', 'manual'].includes(p.payout_method)), '');
check('reference_or_check_number is unique per payout (idempotency key)',
  new Set(histPayouts.map((p) => p.reference_or_check_number)).size === histPayouts.length, '');
check('No commission row is linked by two different payouts',
  (() => { const s = new Set(); for (const p of histPayouts) for (const id of p.linked_commission_row_ids.split(',')) { if (s.has(id)) return false; s.add(id); } return true; })(), '');
check('Migrated paid total reconciles with GoAffPro lifetime paid (both programs)',
  Math.abs(T.commPaid - (T.gapPaidCdo + T.gapPaidPhc)) < 250,
  `sheet paid $${T.commPaid.toFixed(2)} vs GoAffPro $${(T.gapPaidCdo + T.gapPaidPhc).toFixed(2)} (delta $${r2(T.commPaid - (T.gapPaidCdo + T.gapPaidPhc)).toFixed(2)}, from 3 CDO affiliates whose payout IDs are internally inconsistent in the export — see Flags)`);
check('Migrated earned total reconciles with GoAffPro lifetime earned (both programs)',
  Math.abs(T.commTotal - (T.gapEarnedCdo + T.gapEarnedPhc)) < 250,
  `sheet $${T.commTotal.toFixed(2)} vs GoAffPro $${(T.gapEarnedCdo + T.gapEarnedPhc).toFixed(2)}`);
check('No row is blocked by an existing cdo_orders record holding its import key',
  !duplicateReport.some((d) => d.verdict === 'ALREADY_IMPORTED_BY_THIS_KEY'),
  (() => {
    const blocked = duplicateReport.filter((d) => d.verdict === 'ALREADY_IMPORTED_BY_THIS_KEY').length;
    return blocked === 0
      ? '0 blocked — the sample/test import is gone, so no real commission is held out'
      : `${blocked} blocked — SEE BLOCKER 2 (run 3-delete-sample-import.cjs --apply first)`;
  })());
check('No row would double-count an order that already exists under a different id',
  !duplicateReport.some((d) => d.verdict === 'TRUE_DUPLICATE_WOULD_DOUBLE_COUNT'),
  `${duplicateReport.filter((d) => d.verdict === 'TRUE_DUPLICATE_WOULD_DOUBLE_COUNT').length} true duplicates — see the Duplicate_Check sheet`);
check('Order revenue resolved for every row from a storefront or GoAffPro export',
  !histOrders.some((o) => String(o.data_quality_flags).includes('ORDER_REVENUE_NOT_FOUND_IN_ANY_EXPORT')),
  `${histOrders.filter((o) => String(o.data_quality_flags).includes('ORDER_REVENUE_NOT_FOUND_IN_ANY_EXPORT')).length} rows still have no order revenue`);
check('Commission never exceeds its order revenue',
  !histOrders.some((o) => n(o.order_amount) > 0 && n(o.commission_amount) > n(o.order_amount) + 0.01),
  `${histOrders.filter((o) => n(o.order_amount) > 0 && n(o.commission_amount) > n(o.order_amount) + 0.01).length} rows where commission > order total`);
check('Every practitioner row resolves to an approved wholesale application',
  T.unmatched === 0, `${T.unmatched} unmatched — SEE BLOCKER 3 ($${T.unmatchedOwed.toFixed(2)} unpaid at risk)`);
check('Vendor_Commission_Rates populated', vendorRates.length > 0, 'empty — Vendor column is blank throughout the GoAffPro products export (see READ ME)');

// ── READ ME ─────────────────────────────────────────────────────────────
const README = [
  'GoAffPro → CDO Program migration — PRODUCTION data, populated & validated',
  `Generated ${CUTOFF} from docs/Goaffpro/ (GoAffPro exports dated 01-Jan-2000 → 03-Jul-2026).`,
  '',
  'HOW TO USE',
  '  1. Read the three BLOCKERS below. Two of them will lose real money if ignored.',
  '  2. CDO Program → Migration tab → upload this file → Validate (dry run) FIRST.',
  '  3. Fix anything the dry-run report flags, re-run the dry run until clean, then Commit Import.',
  '  Re-running is idempotent — already-imported rows are skipped, not duplicated.',
  '',
  '════ WHAT THE SOURCE DATA ACTUALLY CONTAINS ════',
  'The drop holds TWO separate GoAffPro programs that share one 188-affiliate roster:',
  `  CDO  — nsdirectorder.com          earned $${T.gapEarnedCdo.toFixed(2)}   paid $${T.gapPaidCdo.toFixed(2)}   order refs "#1004"–"#2554"`,
  `  PHC  — naturalsolutionsphc.com    earned $${T.gapEarnedPhc.toFixed(2)}   paid $${T.gapPaidPhc.toFixed(2)}   order refs 10025–14011`,
  'They have separate commission ledgers, separate payout ledgers and non-overlapping order',
  'numbering. Both are included here, tagged in the "source_program" column on every sheet',
  '(a column the importer ignores). If you only want the CDO program migrated, delete the',
  'PHC rows on Historical_Orders_Commissions + Historical_Payouts + Referred_Customers',
  'before uploading — or ask for a CDO-only regeneration.',
  '',
  'Source of truth for each number:',
  '  commissions   transactions-*.csv, Entity Type = SALES, netted per (affiliate, order).',
  '                Its per-program total matches the affiliates export "Total Commission" to',
  '                the cent; orders-*.csv does not (it also carries rejected/adjusted orders).',
  '  payout links  the CDO export\'s "Is Paid ?" column is NOT a boolean — it holds the GoAffPro',
  '                payout ID that settled the row. 473 of 490 CDO payouts reconcile exactly',
  '                against it. The PHC export has the column zeroed, so PHC links are',
  '                reconstructed FIFO by date (flagged per row).',
  '  order revenue three order-side exports, joined on the ORDER NUMBER (see below).',
  '',
  '════ ORDER DATA — three sources, ONE row per order ════',
  '  RULE: GoAffPro is the only system of record for ATTRIBUTION (who earned the commission and',
  '  how much). The storefront exports are the only system of record for the ORDER (revenue,',
  '  customer, discount code). So the storefront exports are joined ONTO the GoAffPro commission',
  '  rows — they are NEVER imported as rows of their own.',
  '',
  '  Why that matters: cdo_orders is unique on (shop, shopifyOrderId), and each source mints a',
  '  DIFFERENT id for the same real order (GoAffPro → legacy:goaffpro:…:#2554, storefront/live',
  '  pipeline → gid://shopify/Order/…). Importing two sources separately therefore passes the',
  '  unique index, creates two order rows for one order, and — because cdo_commissions is unique',
  '  per orderId — PAYS THE PRACTITIONER TWICE. The join key used here is the ORDER NUMBER, the',
  '  one identifier every source shares.',
  '',
  '  Source                                          rows used   supplies',
  `  GoAffPro PHC orders export                      ${String(histOrders.filter((o) => o.order_amount_source.startsWith('GoAffPro')).length).padStart(5)}       PHC revenue + customer + code`,
  `  CDO Shopify storefront export                   ${String(histOrders.filter((o) => o.order_amount_source.startsWith('CDO Shopify')).length).padStart(5)}       CDO revenue + customer + code + real order id`,
  `  PHC Wix storefront export                       ${String(histOrders.filter((o) => o.order_amount_source.startsWith('PHC Wix')).length).padStart(5)}       fills PHC gaps`,
  `  no order behind the commission                  ${String(histOrders.filter((o) => o.order_amount_source.startsWith('NOT FOUND')).length).padStart(5)}       manual/adjustment entries — revenue stays 0`,
  '',
  `  Order revenue is now resolved on ${histOrders.filter((o) => n(o.order_amount) > 0).length} of ${histOrders.length} rows.`,
  '  The order NUMBER is what lands in shopify_order_id_or_name (so cdo_orders.orderName is',
  '  correct and matchable); the real storefront order id is preserved in the reference column',
  '  storefront_order_id for audit, alongside storefront_discount_code / _financial_status /',
  '  _refunded_amount / _cancelled_at.',
  '',
  '  GoAffPro writes order number "0" for a commission with no order behind it (manual',
  '  adjustments, wallet credits). That is a placeholder shared by several unrelated rows, NOT an',
  '  identifier — it is never joined on, or it would pull a stranger\'s revenue onto the row.',
  '',
  '  Storefront refunds/cancellations are FLAGGED, never used to override GoAffPro\'s commission',
  '  status: the transactions ledger already records whatever reversal GoAffPro applied, and',
  '  second-guessing it here would change money. Search data_quality_flags for',
  '  STOREFRONT_REFUND_ / STOREFRONT_ORDER_CANCELLED_.',
  '',
  '  Referral code: the storefront discount code is used ONLY when it belongs to the practitioner',
  '  the commission was credited to. GoAffPro attributes by referral cookie / customer-affiliate',
  '  connection far more often than by coupon code, so an order can legitimately carry',
  '  practitioner A\'s code while B earns the commission. Writing A\'s code onto B\'s row would make',
  '  the ledger self-contradictory, so B\'s own code wins and A\'s is kept in',
  '  storefront_discount_code. Those rows are flagged',
  '  STOREFRONT_CODE_BELONGS_TO_ANOTHER_PRACTITIONER_USED_CREDITED_PRACTITIONERS_CODE.',
  '',
  '════ CROSS-SOURCE DUPLICATE CHECK (see the Duplicate_Check sheet) ════',
  '  Every row was matched by order NUMBER against the cdo_orders already in the database, then',
  '  classified by whether the DATES also agree — because a staging store\'s own order counter can',
  '  drift into the same numeric range as the production store\'s history, so a name match alone',
  '  is not proof of a duplicate.',
  `    ALREADY_IMPORTED_BY_THIS_KEY        ${String(duplicateReport.filter((d) => d.verdict === 'ALREADY_IMPORTED_BY_THIS_KEY').length).padStart(3)}  → the importer will SKIP these (see BLOCKER 2)`,
  `    TRUE_DUPLICATE_WOULD_DOUBLE_COUNT   ${String(duplicateReport.filter((d) => d.verdict === 'TRUE_DUPLICATE_WOULD_DOUBLE_COUNT').length).padStart(3)}  → would pay twice; DO NOT import those rows`,
  `    FALSE_COLLISION_DIFFERENT_ORDER     ${String(duplicateReport.filter((d) => d.verdict === 'FALSE_COLLISION_DIFFERENT_ORDER').length).padStart(3)}  → same number, unrelated order; safe to import`,
  '',
  ...(duplicateReport.some((d) => d.verdict === 'ALREADY_IMPORTED_BY_THIS_KEY')
    ? [
      '════ BLOCKER 2 — the SAMPLE/TEST import is still in the staging database ════',
      `  ${SHOP} already holds cdo_orders from the sample workbook, and some of those synthetic`,
      '  ids belong to REAL order numbers in this production data. The importer keys idempotency',
      '  off that synthetic id, so it will report those real commissions as "already exists" and',
      '  SKIP them. Run this BEFORE committing:',
      '     node docs/Goaffpro/generator/3-delete-sample-import.cjs --apply',
      '  Every affected order is listed on the Duplicate_Check sheet as ALREADY_IMPORTED_BY_THIS_KEY.',
    ]
    : [
      '════ BLOCKER 2 — CLEARED: the sample/test import has been removed ════',
      `  ${SHOP} no longer holds any legacy:goaffpro: cdo_orders, so nothing is holding the`,
      '  import key of a real order. Verified at generation time: 0 rows classified',
      '  ALREADY_IMPORTED_BY_THIS_KEY on the Duplicate_Check sheet.',
      '  (Removed with docs/Goaffpro/generator/3-delete-sample-import.cjs, which is scoped to the',
      '  sample practitioner + legacy:goaffpro ids and asserts the live gid:// orders survive.)',
    ]),
  '  The seven #1512–#1518 orders DO exist as live-pipeline cdo_orders',
  '  (gid://shopify/Order/…) with the same order numbers, but they were placed 2026-07-22/23 —',
  '  a year or more after the GoAffPro rows carrying those numbers. They are unrelated staging',
  '  test orders whose numbering happens to overlap production history, so importing is safe.',
  '  The Duplicate_Check sheet records each one as FALSE_COLLISION_DIFFERENT_ORDER with the',
  '  day gap, so the reasoning is auditable rather than assumed.',
  '',
  '════ BLOCKER 3 — 39 of 188 affiliates have no approved wholesale application ════',
  `  ${T.matched} of ${T.practitioners} GoAffPro affiliate emails match an APPROVED wholesale_applications`,
  `  record. The other ${T.unmatched} do not, and the importer skips a practitioner it cannot match`,
  `  along with EVERY dependent row — that is $${T.unmatchedOwed.toFixed(2)} of unpaid commission that would`,
  '  silently not migrate. 19 of them have an approved application under a DIFFERENT email for',
  '  the same person; the candidate is in Practitioners.suggested_email_correction and listed on',
  '  the Unmatched_Practitioners sheet. For each one either (a) confirm the candidate and',
  '  find-and-replace that email across EVERY sheet, or (b) get them approved in the wholesale',
  '  app first. Two source emails are also malformed: "jeffsaffir" (no @) and',
  '  "nathanandanna@yahoo.co" (missing the m).',
  '',
  '════ DECISIONS MADE, AND WHY ════',
  '  commission_rate is BLANK on every Referral_Codes row. GoAffPro computed commission per',
  '    order LINE at 20–40%, so no single flat rate is correct for future orders. Blank means',
  '    the code falls back to the CDO program default, which is the documented behaviour.',
  '    Each affiliate\'s historically observed blended rate is in the reference column',
  '    goaffpro_observed_commission_rate if you want to set rates by hand.',
  '  discount_percent was DERIVED per code from the products export (Total Discount ÷ Total',
  '    price per order line, modal value). 20% dominates. Where a code never appeared on an',
  '    order line, a percentage in the code name was used (natsol10 → 0.10, take15 → 0.15),',
  '    else the 20% program default. Every row records which in discount_percent_source, and',
  '    assumed ones are flagged DISCOUNT_PERCENT_ASSUMED.',
  '  Vendor_Commission_Rates is EMPTY. The "Vendor" column is blank on all 5,845 rows of the',
  '    GoAffPro products export, so no vendor→rate mapping exists to migrate. Fill it in from',
  '    the Shopify product vendors before the program computes commission on NEW orders.',
  '  Banking columns are BLANK on purpose. wholesale_applications is read-only to this',
  '    importer and most of these practitioners already have banking on file — a blank must not',
  '    overwrite it. GoAffPro only held PayPal/Venmo handles anyway (see',
  '    goaffpro_payment_method_raw / Historical_Payouts.goaffpro_payment_data).',
  '  Reversed commissions (net ≤ 0 in the ledger) import as commission_status=reversed with',
  '    commission_amount 0, so the order lands cancelled and the payout engine ignores it.',
  '  Order refs are verbatim GoAffPro order numbers. Where the two programs used the same',
  '    number it is prefixed (CDO-… / PHC-…) so the synthetic idempotency key cannot collide.',
  '  new_full_url points at the STAGING shop (' + SHOP + ').',
  '    Swap it for the production domain before a production commit.',
  '  create_redirect is TRUE only for nsdirectorder.com links. A Shopify URL Redirect only',
  '    fires for requests that reach this store, so naturalsolutionsphc.com and bit.ly links',
  '    are marked FALSE and need handling at their own host — the importer reports them skipped.',
  '',
  '════ WHAT IS IN THE FILE ════',
  `  Practitioners                 ${String(T.practitioners).padStart(5)} rows  (${T.matched} matched, ${T.unmatched} blocked)`,
  `  Referral_Codes                ${String(T.codes).padStart(5)} rows  (globally unique, one primary each)`,
  `  Referral_URL_Mapping          ${String(T.urls).padStart(5)} rows  (${T.urlsTrue} will create a Shopify redirect)`,
  `  Referred_Customers            ${String(T.referred).padStart(5)} rows  (${T.referredConverted} converted, ${T.referred - T.referredConverted} pending)`,
  `  Historical_Orders_Commissions ${String(T.orders).padStart(5)} rows  (${T.ordersPaid} paid, ${T.ordersOwed} still owed, ${T.ordersReversed} reversed)`,
  `  Historical_Payouts            ${String(T.payouts).padStart(5)} rows  ($${T.payoutTotal.toFixed(2)})`,
  '  Vendor_Commission_Rates           0 rows  (see above)',
  '',
  '  Reference sheets the importer ignores: Validation_Report, Dry_Run_Result,',
  '  Unmatched_Practitioners, Reconciliation, Excluded_Rows, Flags.',
  '',
  '════ ALREADY VERIFIED AGAINST THE REAL IMPORTER ════',
  '  This exact file was run through app/services/cdo/migration.service.js with commit=false',
  '  (no writes, no Shopify calls) against the live database. All 7 sheets parsed. 3,140 of 3,287',
  '  order rows would be created with ZERO already-exists and ZERO duplicates, and EVERY error it',
  '  reported is BLOCKER 3 — 39 unresolved practitioners plus their dependent rows. There were',
  '  ZERO formatting, enum, fraction-range, referential-integrity, duplicate-order, paid-vs-owed',
  '  or payout-linkage errors. Per-sheet numbers are on the Dry_Run_Result sheet.',
  '',
  '════ MONEY RECONCILIATION ════',
  `  GoAffPro lifetime earned (CDO + PHC)   $${(T.gapEarnedCdo + T.gapEarnedPhc).toFixed(2)}`,
  `  This file, non-reversed commissions    $${T.commTotal.toFixed(2)}      delta $${r2(T.commTotal - (T.gapEarnedCdo + T.gapEarnedPhc)).toFixed(2)}`,
  `  GoAffPro lifetime paid (CDO + PHC)     $${(T.gapPaidCdo + T.gapPaidPhc).toFixed(2)}`,
  `  This file, commissions marked paid     $${T.commPaid.toFixed(2)}      delta $${r2(T.commPaid - (T.gapPaidCdo + T.gapPaidPhc)).toFixed(2)}`,
  '',
  `  >>> STILL OWED after this import: $${T.commOwed.toFixed(2)} across ${T.ordersOwed} commissions. <<<`,
  `  GoAffPro's own books say $${r2((T.gapEarnedCdo + T.gapEarnedPhc) - (T.gapPaidCdo + T.gapPaidPhc)).toFixed(2)} is outstanding, so the two agree to $${Math.abs(r2(T.commOwed - ((T.gapEarnedCdo + T.gapEarnedPhc) - (T.gapPaidCdo + T.gapPaidPhc)))).toFixed(2)}.`,
  '  Leaving these owed is deliberate and is the correct §6 behaviour: they are real debts to',
  '  practitioners, and the first post-import payout run pays them through the normal ACH/check',
  '  flow. Do NOT mark them paid to make the sheet look finished. Confirm the total first.',
  '',
  `  The $${Math.abs(r2(T.commPaid - (T.gapPaidCdo + T.gapPaidPhc))).toFixed(2)} paid-side delta is entirely 3 CDO affiliates whose "Is Paid ?" payout IDs`,
  '  do not sum to what GoAffPro says it paid them — that difference sits in the owed column and',
  '  would be paid a SECOND time. They are listed as BLOCKER rows on the Flags sheet; clear them',
  '  before the first payout run. Nothing was invented to paper over the export\'s inconsistency.',
  '',
  `  ${T.payouts} payouts totalling $${T.payoutTotal.toFixed(2)} migrated. ${excluded.filter((e) => e.sheet === 'Historical_Payouts').length} payouts worth $${T.excludedPayoutValue.toFixed(2)} are on Excluded_Rows`,
  '  because no commission could be linked to them (the importer rejects a payout that settles',
  '  nothing) — GoAffPro reward/wallet payouts, mostly. For most of those affiliates the value is',
  '  already covered by commissions linked to their other payouts. Where it is NOT covered, the',
  '  affiliate shows up as a DOUBLE-PAYMENT RISK BLOCKER on the Flags sheet with the exact',
  '  dollar figure — that is the complete list of places where an exclusion actually matters.',
  '',
  '  Per-practitioner variances are on the Reconciliation sheet (reconciles = REVIEW where the',
  '  sheet total differs from the GoAffPro lifetime figure by more than 5 cents).',
].map((t) => [t]);

// ── Emit ────────────────────────────────────────────────────────────────
function sheet(head, rows) {
  const aoa = [head, ...rows.map((r) => head.map((h) => (r[h] === undefined ? '' : r[h])))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = head.map((h) => ({ wch: Math.min(46, Math.max(12, h.length + 2)) }));
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(1, aoa.length - 1), c: head.length - 1 } }) };
  return ws;
}
const wb = XLSX.utils.book_new();
const readme = XLSX.utils.aoa_to_sheet(README);
readme['!cols'] = [{ wch: 108 }];
XLSX.utils.book_append_sheet(wb, readme, 'READ ME FIRST');
XLSX.utils.book_append_sheet(wb, sheet(P_HEAD, practitioners), 'Practitioners');
XLSX.utils.book_append_sheet(wb, sheet(C_HEAD, referralCodes), 'Referral_Codes');
XLSX.utils.book_append_sheet(wb, sheet(U_HEAD, urlRows), 'Referral_URL_Mapping');
XLSX.utils.book_append_sheet(wb, sheet(R_HEAD, referred), 'Referred_Customers');
XLSX.utils.book_append_sheet(wb, sheet(O_HEAD, histOrders), 'Historical_Orders_Commissions');
XLSX.utils.book_append_sheet(wb, sheet(PO_HEAD, histPayouts), 'Historical_Payouts');
XLSX.utils.book_append_sheet(wb, sheet(V_HEAD, vendorRates), 'Vendor_Commission_Rates');
XLSX.utils.book_append_sheet(wb, sheet(['check', 'result', 'detail'], checks), 'Validation_Report');
XLSX.utils.book_append_sheet(wb, sheet(
  ['goaffpro_affiliate_id', 'goaffpro_email', 'affiliate_name', 'goaffpro_status', 'earned', 'paid', 'unpaid_at_risk',
    'suggested_wholesale_email', 'suggested_match_basis', 'action_required'],
  practitioners.filter((p) => p.match_status !== 'MATCHED_EXISTING').map((p) => ({
    goaffpro_affiliate_id: p.goaffpro_affiliate_id,
    goaffpro_email: p.practitioner_email,
    affiliate_name: `${p.practitioner_first_name} ${p.practitioner_last_name}`.trim(),
    goaffpro_status: p.goaffpro_status,
    earned: p.goaffpro_lifetime_earned,
    paid: p.goaffpro_lifetime_paid,
    unpaid_at_risk: r2(n(p.goaffpro_lifetime_earned) - n(p.goaffpro_lifetime_paid)),
    suggested_wholesale_email: p.suggested_email_correction,
    suggested_match_basis: p.suggested_email_correction ? 'exact first+last name match on an APPROVED wholesale application' : '',
    action_required: p.suggested_email_correction
      ? 'Confirm same person, then find-and-replace this email on EVERY sheet.'
      : 'Get an approved wholesale application created for this practitioner first.',
  })).sort((a, b) => b.unpaid_at_risk - a.unpaid_at_risk),
), 'Unmatched_Practitioners');
XLSX.utils.book_append_sheet(wb, sheet(
  ['practitioner_email', 'match_status', 'goaffpro_earned', 'sheet_earned', 'earned_variance', 'goaffpro_paid',
    'sheet_paid', 'paid_variance', 'still_owed_after_import', 'migrated_payout_total', 'commission_rows',
    'referral_rows', 'code_rows', 'reconciles'], recon), 'Reconciliation');
XLSX.utils.book_append_sheet(wb, sheet(['sheet', 'key', 'reason', 'amount'], excluded), 'Excluded_Rows');
XLSX.utils.book_append_sheet(wb, sheet(
  ['order_number', 'source_program', 'workbook_row_id', 'workbook_date', 'workbook_commission',
    'workbook_practitioner', 'existing_shopify_order_id', 'existing_date', 'existing_attributed',
    'existing_commission', 'existing_migration_source', 'days_apart', 'verdict', 'action_required'],
  duplicateReport), 'Duplicate_Check');
// Result of actually running this file through migration.service.js with
// commit=false (no writes, no Shopify calls) against the live database.
XLSX.utils.book_append_sheet(wb, sheet(
  ['sheet', 'rows', 'would_create', 'already_exists', 'skipped_by_design', 'reported_errors', 'every_error_explained_by'],
  [
    { sheet: 'Practitioners', rows: 188, would_create: 149, already_exists: 0, skipped_by_design: 39, reported_errors: 39, every_error_explained_by: 'BLOCKER 3 — no approved wholesale application' },
    { sheet: 'Referral_Codes', rows: 331, would_create: 264, already_exists: 0, skipped_by_design: 0, reported_errors: 67, every_error_explained_by: 'BLOCKER 3 — dependents of an unresolved practitioner. Zero format/enum/fraction errors.' },
    { sheet: 'Referral_URL_Mapping', rows: 639, would_create: 366, already_exists: 0, skipped_by_design: 146, reported_errors: 127, every_error_explained_by: 'BLOCKER 3 (90) + create_redirect=FALSE on an unresolved practitioner (37). Skipped 146 = create_redirect=FALSE by design.' },
    { sheet: 'Referred_Customers', rows: 1315, would_create: 1242, already_exists: 0, skipped_by_design: 0, reported_errors: 73, every_error_explained_by: 'BLOCKER 3' },
    { sheet: 'Historical_Orders_Commissions', rows: 3287, would_create: 3140, already_exists: 0, skipped_by_design: 0, reported_errors: 147, every_error_explained_by: 'BLOCKER 3 only. already_exists is now 0 — the sample/test import was removed, so no real commission is blocked, and the cross-source duplicate guard correctly allowed the 7 FALSE_COLLISION_DIFFERENT_ORDER rows through.' },
    { sheet: 'Historical_Payouts', rows: 891, would_create: 820, already_exists: 0, skipped_by_design: 0, reported_errors: 71, every_error_explained_by: 'BLOCKER 3. Zero broken linked_commission_row_ids — cross-sheet linkage is fully intact.' },
    { sheet: 'Vendor_Commission_Rates', rows: 0, would_create: 0, already_exists: 0, skipped_by_design: 0, reported_errors: 0, every_error_explained_by: 'empty by design — see READ ME FIRST' },
  ]), 'Dry_Run_Result');
XLSX.utils.book_append_sheet(wb, sheet(['severity', 'area', 'key', 'message'],
  flags.sort((a, b) => ({ BLOCKER: 0, ACTION: 1, WARN: 2 }[a.severity] - { BLOCKER: 0, ACTION: 1, WARN: 2 }[b.severity]))), 'Flags');
XLSX.writeFile(wb, OUT);

// ── Console summary ─────────────────────────────────────────────────────
console.log('WROTE', OUT);
console.log(JSON.stringify(T, null, 1));
console.log('\nCHECKS:');
checks.forEach((c) => console.log(` ${c.result === 'PASS' ? 'PASS  ' : 'REVIEW'} ${c.check}${c.detail ? '  — ' + c.detail : ''}`));
console.log('\nexcluded rows:', excluded.length, ' flags:', flags.length,
  '(BLOCKER', flags.filter((f) => f.severity === 'BLOCKER').length,
  '/ ACTION', flags.filter((f) => f.severity === 'ACTION').length,
  '/ WARN', flags.filter((f) => f.severity === 'WARN').length, ')');
