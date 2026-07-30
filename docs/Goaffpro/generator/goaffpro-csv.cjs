// Shared CSV helpers for the GoAffPro migration analysis.
const fs = require('fs');

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function readCSV(path) {
  let text = fs.readFileSync(path, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = parseCSV(text);
  const headers = rows[0].map(h => h.trim());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    if (rows[r].every(c => c === '')) continue;
    const o = {};
    headers.forEach((h, i) => {
      // Duplicate header names exist in the affiliates export (e.g. "Coupon Code"
      // twice) — keep the first non-empty value rather than letting a blank
      // later column clobber a populated earlier one.
      const v = rows[r][i] === undefined ? '' : rows[r][i];
      if (o[h] === undefined || o[h] === '') o[h] = v;
    });
    o.__raw = rows[r];
    out.push(o);
  }
  out.headers = headers;
  return out;
}

const BASE = 'd:/projects/shopify-apps/natural-solutions/naturalsolutionsphc.com-Natural-Solution-App/docs/Goaffpro';
const CDO = BASE + '/CDO Affiliate Data (5)';
const PHC = BASE + '/PHC Solution (1)/PHC Solution';

const FILES = {
  affCdo: CDO + '/affiliates-01-Jul-2000-03-Jul-2026.csv',
  affPhc: PHC + '/affiliates-01-Jan-2000-03-Jul-2026 (1).csv',
  ccCdo: CDO + '/connected-customers-01-Jan-2000-03-Jul-2026.csv',
  ccPhc: PHC + '/connected-customers-01-Jan-2000-03-Jul-2026 (1).csv',
  orders: CDO + '/orders-01-Jan-2000-03-Jul-2026.csv',
  payCdo: CDO + '/payouts-01-Jan-2000-03-Jul-2026.csv',
  payPhc: PHC + '/payouts-01-Jan-2000-03-Jul-2026 (1).csv',
  rewCdo: CDO + '/rewards-01-Jan-2000-03-Jul-2026.csv',
  rewPhc: PHC + '/rewards-01-Jan-2000-03-Jul-2026 (1).csv',
  txCdo: CDO + '/transactions-01-Jan-2000-03-Jul-2026.csv',
  txPhc: PHC + '/transactions-01-Jan-2000-03-Jul-2026 (1).csv',
  products: PHC + '/products-01-Jan-2000-03-Jul-2026 (1).csv',
  trafCdo: CDO + '/traffic-01-Jan-2000-03-Jul-2026.csv',
  trafPhc: PHC + '/traffic-01-Jan-2000-03-Jul-2026 (1).csv',

  // ── Storefront order exports (added 2026-07-29) ──
  // These are the ORDER-side sources GoAffPro's own export lacks, and they are
  // used ONLY to enrich the GoAffPro commission rows — never imported as their
  // own cdo_orders rows. See the README's "one row per real order" rule.
  //   shopifyCdo — the CDO storefront (nsdirectorder.com), order names #1006–#2591.
  //                One row per LINE ITEM; only rows carrying a Total are order headers.
  //   wixPhcHdr  — the PHC storefront (naturalsolutionsphc.com) order headers.
  //   wixPhcLine — the same store, one row per line item (wider order coverage).
  shopifyCdo: BASE + '/CDO_shopify_orders_export_1.csv',
  wixPhcLine: BASE + '/Wix-Order-Data/Order-Data/Orders.csv',
  wixPhcHdr: BASE + '/Wix-Order-Data/Order-Data/Orders (1).csv',
};

function w9Files() {
  return fs.readdirSync(CDO).filter(f => /^w9-report/.test(f)).map(f => CDO + '/' + f)
    .concat(fs.readdirSync(PHC).filter(f => /^w9-report/.test(f)).map(f => PHC + '/' + f));
}

const lc = v => String(v || '').trim().toLowerCase();
const n = v => { const x = Number(String(v || '').replace(/[$,]/g, '')); return Number.isFinite(x) ? x : 0; };
const r2 = v => Math.round(v * 100) / 100;
const dOnly = v => (String(v || '').trim().split(' ')[0] || '');

function tally(arr, fn) {
  const m = new Map();
  for (const a of arr) { const k = fn(a); m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

module.exports = { readCSV, FILES, w9Files, lc, n, r2, dOnly, tally, CDO, PHC, BASE };
