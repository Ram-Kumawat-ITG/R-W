// Rebuilds docs/Mapping Sheet.xlsx with the full CDO Program field mapping.
//
// Keeps the operator's existing two columns exactly as they are (A "Our App
// Columns", B "Goaffpro Columns") so their cross-check still works, and adds
// three more that the mapping genuinely needs:
//   C  Source export   — WHICH file the value comes from (there are 6 order/
//                        affiliate exports across 2 GoAffPro programs + 2
//                        storefronts, so "Goaffpro Columns" alone is ambiguous)
//   D  How it's derived — many columns are NOT a 1:1 GoAffPro field (netted,
//                        joined, inferred, or deliberately blank)
//   E  Lands in         — the cdo_* collection.field the importer writes
//
// Source of truth: docs/Goaffpro/generator/2-build-workbook.cjs (how each column
// is populated) + ns-retail/app/services/cdo/migration.service.js (where it lands).
const XLSX = require('d:/projects/shopify-apps/natural-solutions/naturalsolutionsphc.com-Natural-Solution-App/wholesale/node_modules/xlsx');
const OUT = 'd:/projects/shopify-apps/natural-solutions/naturalsolutionsphc.com-Natural-Solution-App/docs/Mapping Sheet.xlsx';

const HEAD = ['Our App Columns', 'Goaffpro Columns', 'Source export', "How it's derived / notes", 'Lands in (DB field)'];

// Shorthand for the export files.
const AFF = 'affiliates-*.csv (both programs)';
const AFFC = 'CDO affiliates-*.csv';
const AFFP = 'PHC affiliates-*.csv';
const CC = 'connected-customers-*.csv (both)';
const TX = 'transactions-*.csv (both)';
const PAY = 'payouts-*.csv (both)';
const ORD = 'PHC orders-*.csv';
const SHOP = 'CDO_shopify_orders_export_1.csv';
const WIX = 'Wix-Order-Data/Orders*.csv';
const PROD = 'PHC products-*.csv';
const TRAF = 'traffic-*.csv (both)';
const NONE = '— none —';
const DB = '(read-only lookup)';

const SECTION = (label) => ['', '', '', `── ${label} ──`, ''];

const sheets = {};

// ── 1. Practitioners ─────────────────────────────────────────────────────
sheets.Practitioners = [
  ['row_id', NONE, NONE, 'Generated sequence. Used by the importer to label errors in its report; never persisted to the DB.', '(error reporting only, not stored)'],
  ['goaffpro_affiliate_id', 'ID', AFF, 'Same affiliate ID in both programs — the roster is shared.', '(reference only)'],
  ['match_status', NONE, DB, 'DERIVED, not a GoAffPro field. Matches practitioner_email against wholesale_applications (status=approved). MATCHED_EXISTING / UNMATCHED_NAME_CANDIDATE / UNMATCHED_BLOCKER.', '(reference only)'],
  ['practitioner_email', 'Email Address', AFF, 'THE join key for every other sheet. Must match an APPROVED wholesale_applications record or the practitioner and all their rows are skipped.', 'matched → wholesale_applications._id'],
  ['practitioner_first_name', 'First Name', AFF, '', 'cdo_*.practitionerName (combined)'],
  ['practitioner_last_name', 'Last Name', AFF, '', 'cdo_*.practitionerName (combined)'],
  ['business_name', 'Company Name', AFF, '', '(reference only)'],
  ['phone', 'Phone', AFF, '', '(reference only)'],
  ['existing_wholesale_application_id', NONE, DB, 'DERIVED — the matched wholesale_applications._id, for your reference. NOT read by the importer (verified: the string does not appear in migration.service.js). practitionerId is taken from the LIVE email match (String(app._id)), so editing this cell changes nothing — fix practitioner_email instead.', '(reference only — practitionerId comes from the live email match)'],
  ['payout_method', 'Payment Method', AFF, 'Mapped: PayPal→paypal, Venmo→manual, Cheque→check. NOT IMPORTED — wholesale_applications is read-only to this importer.', 'NOT IMPORTED'],
  ['bank_account_name', NONE, NONE, 'Deliberately BLANK. GoAffPro only held PayPal/Venmo handles, and a blank must never overwrite banking already on file.', 'NOT IMPORTED'],
  ['bank_routing_number', NONE, NONE, 'Deliberately BLANK — see above.', 'NOT IMPORTED'],
  ['bank_account_number', NONE, NONE, 'Deliberately BLANK — see above.', 'NOT IMPORTED'],
  ['bank_account_type', NONE, NONE, 'Deliberately BLANK — see above.', 'NOT IMPORTED'],
  ['goaffpro_status', 'Status', AFF, 'approved / blocked / pending / invited.', '(reference only)'],
  ['goaffpro_joined_at', 'Date Created', AFF, 'Date part only (YYYY-MM-DD).', '(reference only)'],
  ['goaffpro_lifetime_earned', 'Total Commission', `${AFFC} + ${AFFP}`, 'SUM of BOTH programs: CDO "Total Commission" + PHC "Total Commission".', '(reference only)'],
  ['goaffpro_lifetime_paid', 'Amount Paid', `${AFFC} + ${AFFP}`, '*** CORRECTED: this is "Amount Paid", NOT "Total Commission" (the earlier sheet had it as Total Commission). SUM of both programs. ***', '(reference only)'],
  ['notes', NONE, NONE, 'Generated explanatory text per row.', '(reference only)'],
  SECTION('reference columns below — appended by the builder, IGNORED by the importer'),
  ['source_program', NONE, `${AFFC} + ${AFFP}`, 'CDO / PHC / CDO+PHC / none — which program(s) this affiliate earned in.', '(reference only)'],
  ['earned_cdo', 'Total Commission', AFFC, 'CDO program only.', '(reference only)'],
  ['paid_cdo', 'Amount Paid', AFFC, 'CDO program only.', '(reference only)'],
  ['earned_phc', 'Total Commission', AFFP, 'PHC program only.', '(reference only)'],
  ['paid_phc', 'Amount Paid', AFFP, 'PHC program only.', '(reference only)'],
  ['goaffpro_referral_code', 'Referral Code', AFF, 'The affiliate\'s link slug.', '(reference only)'],
  ['goaffpro_coupon_codes', 'Coupon Code', AFF, 'Verbatim; may be a comma-separated list.', '(reference only)'],
  ['goaffpro_payment_method_raw', 'Payment Method', AFF, 'Unmapped original value.', '(reference only)'],
  ['wholesale_application_status', NONE, DB, 'Status of the matched wholesale application.', '(reference only)'],
  ['suggested_email_correction', NONE, DB, 'An APPROVED application with the same first+last name under a DIFFERENT email — a candidate fix for an unmatched row. Confirm the person, then find-and-replace on EVERY sheet.', '(reference only)'],
  ['data_quality_flags', NONE, NONE, 'e.g. NO_WHOLESALE_MATCH, INVALID_EMAIL_FORMAT, UNMATCHED_WITH_<amount>_UNPAID_AT_RISK.', '(reference only)'],
];

// ── 2. Referral Codes ────────────────────────────────────────────────────
sheets['Referral Codes'] = [
  ['row_id', NONE, NONE, 'Generated sequence. Used by the importer to label errors in its report; never persisted to the DB.', '(error reporting only, not stored)'],
  ['practitioner_email', 'Email Address', AFF, 'Join key back to Practitioners.', 'cdo_practitioner_codes.practitionerEmail'],
  ['code', 'Referral Code / Coupon Code', `${AFF}, ${CC}, ${ORD}`, 'THREE origins, in priority order: (1) "Referral Code" = the primary; (2) each "Coupon Code" (comma-split) that differs; (3) any code seen in real attribution history (connected-customers, orders "Discount codes"/ref) not already claimed. Lowercased. Must be globally unique — a Shopify discount code is store-wide.', 'cdo_practitioner_codes.code'],
  ['is_primary', NONE, NONE, 'DERIVED — TRUE for the affiliate\'s "Referral Code", FALSE for coupons/observed codes. Exactly one per practitioner.', 'cdo_practitioner_codes.isPrimary'],
  ['discount_percent', NONE, PROD, 'DERIVED — NOT a GoAffPro field. Per code: modal (Total Discount ÷ Total price) across that code\'s order lines → else a percentage in the code name (natsol10→0.10, take15→0.15) → else the 20% program default. Stored as a FRACTION (0.20 = 20%); the importer rejects anything outside 0–1.', 'cdo_practitioner_codes.discountPercent'],
  ['commission_rate', NONE, NONE, 'Deliberately BLANK. GoAffPro computed commission per order LINE at 20–40%, varying within one affiliate, so no single flat rate is correct going forward. Blank → falls back to the CDO program default.', 'cdo_practitioner_codes.commissionRate (null)'],
  ['status', 'Status', AFF, 'Mapped: approved→active, blocked→archived, pending→paused, invited→paused.', 'cdo_practitioner_codes.status'],
  ['goaffpro_coupon_id', NONE, NONE, 'Not present in the GoAffPro export — always blank.', '(reference only)'],
  ['notes', NONE, NONE, 'Generated explanatory text. NOT imported — the importer hardcodes note: "Migrated from GoAffPro" (migration.service.js:313).', '(reference only)'],
  SECTION('reference columns'),
  ['source_program', NONE, NONE, 'Always CDO+PHC — the roster and codes are shared.', '(reference only)'],
  ['code_origin', NONE, NONE, 'Which of the three origins above produced this code.', '(reference only)'],
  ['discount_percent_source', NONE, NONE, 'derived (N order lines) / inferred from code name / program default 20%.', '(reference only)'],
  ['goaffpro_observed_commission_rate', 'Affiliate Commission ÷ Order Subtotal', ORD, 'The affiliate\'s historically blended rate — reference for setting rates by hand. NOT imported.', '(reference only)'],
  ['data_quality_flags', NONE, NONE, 'CODE_HAS_UNUSUAL_CHARACTERS_REVIEW_MANUALLY, DISCOUNT_PERCENT_ASSUMED, DEMOTED_DUPLICATE_PRIMARY.', '(reference only)'],
  SECTION('SIDE EFFECT: every imported code also creates a real Shopify discount on the retail store (cdo.discount.service.createShopifyDiscount)'),
];

// ── 3. Referral URL Mapping ──────────────────────────────────────────────
sheets['Referral URL Mapping'] = [
  ['row_id', NONE, NONE, 'Generated sequence. Used by the importer to label errors in its report; never persisted to the DB.', '(error reporting only, not stored)'],
  ['practitioner_email', 'Email Address', AFF, 'Join key back to Practitioners, for YOUR reference. NOT read by the importer on this sheet — verified: the Referral_URL_Mapping block reads only new_referral_code, legacy_full_url, new_full_url and create_redirect. The row is resolved via the CODE, so a redirect is created even if this cell is wrong; fix new_referral_code instead.', '(reference only — resolved via the code, not the email)'],
  ['new_referral_code', NONE, NONE, "DERIVED — the practitioner's PRIMARY code from Referral_Codes. Must exist there or the row is skipped.", '(resolution only)'],
  ['legacy_url_format', NONE, NONE, 'DERIVED from the URL shape: query_param if it contains ?ref=, else path.', '(reference only)'],
  ['legacy_full_url', 'Referral Link', `${AFFC} + ${AFFP}`, 'Both programs\' verbatim links, PLUS both nsdirectorder.com shapes synthesized per practitioner (https://nsdirectorder.com/?ref=<slug> AND /<slug>) because practitioners shared both forms. Deduplicated on path — a Shopify redirect path must be unique.', '→ UrlRedirect.path (path+query)'],
  ['legacy_domain', NONE, NONE, 'DERIVED — hostname of legacy_full_url.', '(reference only)'],
  ['legacy_ref_value', 'Referral Code', AFF, 'The raw old slug from the URL.', '(reference only)'],
  ['new_full_url', NONE, NONE, 'GENERATED — https://<retail shop>/discount/<code>. Currently points at the STAGING shop; swap before a production run.', '→ UrlRedirect.target'],
  ['create_redirect', NONE, NONE, 'DERIVED — TRUE only for nsdirectorder.com. A Shopify URL Redirect fires only for requests reaching THIS store, so naturalsolutionsphc.com and bit.ly links are FALSE and must be handled at their own host. FALSE rows are reported skipped by design.', '(controls whether a redirect is created)'],
  ['notes', NONE, NONE, 'Generated.', '(reference only)'],
  SECTION('reference columns'),
  ['source_program', NONE, NONE, 'CDO / PHC / other, by the legacy domain.', '(reference only)'],
  ['evidence', 'ref', TRAF, 'Tracked click count on that ?ref= slug — proof the link is really in circulation.', '(reference only)'],
  ['data_quality_flags', NONE, NONE, '', '(reference only)'],
  SECTION('SIDE EFFECT: creates a real Shopify UrlRedirect. REQUIRES the write_online_store_navigation scope (added 2026-07-29 — needs shopify app deploy + merchant re-auth).'),
];

// ── 4. Referred Customers ────────────────────────────────────────────────
sheets['Referred Customers'] = [
  ['row_id', NONE, NONE, 'Generated sequence. Used by the importer to label errors in its report; never persisted to the DB.', '(error reporting only, not stored)'],
  ['practitioner_email', 'Affiliate Email', CC, 'Join key back to Practitioners.', 'cdo_referrals.practitionerEmail'],
  ['referral_code_used', 'Referral code', CC, 'Lowercased.', 'cdo_referrals.referralCode'],
  ['customer_email', 'Customer Email', CC, 'REQUIRED — the importer rejects a blank. Lowercased. Dedup key is (practitioner + code + customer email).', 'cdo_referrals.referredEmail'],
  ['customer_first_name', 'first_name', CC, 'Falls back to splitting "Customer Name".', 'cdo_referrals.referredName (combined)'],
  ['customer_last_name', 'last_name', CC, 'Falls back to splitting "Customer Name".', 'cdo_referrals.referredName (combined)'],
  ['customer_phone', 'phone', CC, '', '(reference only)'],
  ['applicant_type', NONE, NONE, "Constant 'patient'. NOT read by the importer.", 'NOT IMPORTED'],
  ['referral_status', 'Source / order_id', CC, "DERIVED — 'converted' when Source='order' or an order_id is present, else 'pending'. Enum: pending / converted / expired.", 'cdo_referrals.status'],
  ['first_referred_at', 'Date', CC, 'Earliest date across BOTH programs\' exports for the same (practitioner, code, customer).', 'cdo_referrals.referredAt'],
  ['converted_at', 'Date', CC, 'Same date, only when converted.', 'cdo_referrals.convertedAt'],
  ['goaffpro_referral_id', 'id / order_id', CC, "GoAffPro's row id, else 'order:<order_id>'.", '(reference only)'],
  ['notes', NONE, NONE, 'Generated.', '(reference only)'],
  SECTION('reference columns'),
  ['source_program', NONE, NONE, 'CDO / PHC / CDO+PHC — which export(s) this connection appeared in (1,067 of them appear in both).', '(reference only)'],
  ['goaffpro_source', 'Source', CC, 'order / form / manual.', '(reference only)'],
  ['goaffpro_order_id', 'order_id', CC, '', '(reference only)'],
  ['data_quality_flags', NONE, NONE, 'CODE_NOT_ON_REFERRAL_CODES_SHEET, CODE_OWNED_BY_A_DIFFERENT_PRACTITIONER, AFFILIATE_NOT_ON_PRACTITIONERS_SHEET.', '(reference only)'],
];

// ── 5. Historical Orders Commissions ─────────────────────────────────────
sheets['Historical Orders Commissions'] = [
  ['row_id', NONE, NONE, 'Generated sequence. Historical_Payouts.linked_commission_row_ids points at THESE ids, so the importer DOES use it — to resolve that linkage and to label errors in the report. Never persisted to the DB.', '(used for linkage + error reporting, not stored)'],
  ['practitioner_email', 'Affiliate Email', TX, 'Join key back to Practitioners.', 'cdo_orders/cdo_commissions.practitionerEmail'],
  ['referral_code_used', 'Discount Code', `${SHOP}, ${ORD}`, 'PRIORITY: (1) the storefront discount code, but ONLY if that code belongs to the credited practitioner; (2) GoAffPro orders "Discount codes"/ref, same ownership test; (3) the credited practitioner\'s primary code. GoAffPro attributes by referral cookie (1,363) / customer-connect (301) far more than by coupon (284), so an order can carry A\'s code while B earns it — 24 such rows. B\'s code wins so the ledger stays self-consistent.', 'cdo_orders.referralCode + referral.code'],
  ['shopify_order_id_or_name', 'Order Number', TX, 'Verbatim, QUALIFIED when it would collide (CDO-/PHC- prefix when both programs used the number; -A<affId> when one order is credited to two affiliates; a synthetic ref when GoAffPro has no order number). Becomes the idempotency key legacy:goaffpro:<shop>:<ref>.', 'cdo_orders.shopifyOrderId + orderName'],
  ['customer_email', 'Customer Email / Email / Contact email', `${ORD}, ${SHOP}, ${WIX}`, 'First available of the three order sources.', 'cdo_orders.customerEmail'],
  ['customer_name', 'Customer Name / Billing Name / Recipient name', `${ORD}, ${SHOP}, ${WIX}`, 'First available.', 'cdo_orders.customerName'],
  ['order_placed_at', 'Order Date / Created at / Date created', `${ORD}, ${SHOP}, ${WIX}`, "The storefront's real order date, preferred over the ledger timestamp which can lag by hours.", 'cdo_orders.placedAt'],
  ['currency', NONE, NONE, "Constant 'USD' — every source row is USD.", 'cdo_orders.currency'],
  ['order_amount', 'Order Total / Total', `${ORD}, ${SHOP}, ${WIX}`, 'Joined on ORDER NUMBER. 1,992 from GoAffPro PHC orders, 1,262 from the CDO Shopify export, 11 from Wix, 22 unresolved (commissions with no order behind them — manual adjustments). NEVER joined on order number "0": that is a placeholder shared by unrelated rows and joining on it pulls a stranger\'s revenue in.', 'cdo_orders.amount'],
  ['commission_rate_applied', NONE, `${ORD}, ${SHOP}, ${WIX}`, 'DERIVED — commission_amount ÷ order subtotal, kept only when it lands in (0,1]. Wix has no subtotal column, so it is Total − tax − shipping.', 'cdo_commissions.rate + referral.commissionRate'],
  ['commission_amount', 'Amount', TX, 'AUTHORITATIVE FIGURE. SUM of every SALES transaction for that (affiliate, order) — netting ADD / UPDATE / DELETE. Per-program totals match the affiliates export "Total Commission" to the cent, which orders-*.csv does not.', 'cdo_orders.commissionAmount + cdo_commissions.amount'],
  ['commission_status', "Is Paid ? / net Amount", `${TX}, ${PAY}`, "DERIVED: 'reversed' when the net is ≤ 0; 'paid' when a payout settled it; else 'approved' (= still owed). Enum: pending / approved / paid / reversed.", 'cdo_commissions.status (+ cdo_orders.status)'],
  ['payout_status', NONE, NONE, "DERIVED — 'paid' or 'pending'; blank when reversed.", 'cdo_commissions.payoutStatus'],
  ['earned_at', NONE, NONE, 'Same as order_placed_at.', 'cdo_commissions.earnedAt'],
  ['paid_at', 'Date', PAY, 'Date of the settling payout. REQUIRED whenever commission_status=paid — the importer hard-rejects a paid row without it.', 'cdo_commissions.payoutDate'],
  ['goaffpro_order_id', 'Order ID', ORD, "GoAffPro's own order id (PHC rows only).", 'cdo_orders.goaffproOrderId'],
  ['goaffpro_commission_id', NONE, NONE, 'GENERATED — <program>-TXN-<affId>-<orderRef>. GoAffPro exports no commission id.', '(reference only)'],
  ['notes', NONE, NONE, 'Generated — states paid / still-owed / reversed and why.', '(reference only)'],
  SECTION('reference columns'),
  ['source_program', NONE, NONE, 'CDO or PHC.', '(reference only)'],
  ['goaffpro_order_number', 'Order Number', TX, 'The UNqualified original, before any collision prefix.', '(reference only)'],
  ['order_amount_source', NONE, NONE, 'Which of the three order exports supplied the revenue.', '(reference only)'],
  ['linked_payout_goaffpro_id', 'Is Paid ? / ID', `${TX}, ${PAY}`, 'The GoAffPro payout that settled this commission.', '(reference only)'],
  ['storefront_order_id', 'Id / Order number', `${SHOP}, ${WIX}`, "The REAL storefront order id. Kept for audit only — the import key uses the order NAME so cdo_orders.orderName stays matchable.", '(reference only)'],
  ['storefront_discount_code', 'Discount Code', `${SHOP}, ${WIX}`, "The code actually on the order, even when a different practitioner was credited.", '(reference only)'],
  ['storefront_financial_status', 'Financial Status / Payment status', `${SHOP}, ${WIX}`, 'paid / partially_refunded / refunded / expired.', '(reference only)'],
  ['storefront_refunded_amount', 'Refunded Amount', `${SHOP}, ${WIX}`, 'FLAGGED, never applied — GoAffPro\'s ledger already records whatever reversal it made, and overriding it here would change money (40 such rows).', '(reference only)'],
  ['storefront_cancelled_at', 'Cancelled at', SHOP, 'Flagged, never applied — same reasoning.', '(reference only)'],
  ['data_quality_flags', NONE, NONE, 'ORDER_REVENUE_NOT_FOUND_IN_ANY_EXPORT, REFERRAL_CODE_ASSUMED_PRIMARY, STOREFRONT_CODE_BELONGS_TO_ANOTHER_PRACTITIONER…, COMMISSION_REVERSED…, ORDER_REF_QUALIFIED…, STOREFRONT_REFUND_<amt>…, ORDER_NUMBER_REUSED_BY_AN_UNRELATED_EXISTING_ORDER.', '(reference only)'],
];

// ── 6. Historical Payouts ────────────────────────────────────────────────
sheets['Historical Payouts'] = [
  ['row_id', NONE, NONE, 'Generated sequence. Used by the importer to label errors in its report; never persisted to the DB.', '(error reporting only, not stored)'],
  ['practitioner_email', 'Affiliate Email', PAY, 'Join key back to Practitioners.', 'cdo_payouts.practitionerEmail'],
  ['payout_amount', 'Payout Amount', PAY, "GoAffPro's actual disbursed amount, kept verbatim even when the linked commissions sum differently (variance is reported).", 'cdo_payouts.amount'],
  ['currency', 'Currency', PAY, '', 'cdo_payouts.currency'],
  ['payout_method', 'Payment Method', PAY, 'Mapped: PayPal→paypal, Venmo→manual, Cheque→check, else manual. Enum: ach / check / paypal / manual.', 'cdo_payouts.method'],
  ['payout_status', NONE, NONE, "Constant 'paid'. NOT IMPORTED — the importer always records a historical payout as paid.", 'NOT IMPORTED (forced paid)'],
  ['period_start', NONE, NONE, 'DERIVED — earliest earned_at among the linked commissions.', 'cdo_payouts.periodStart'],
  ['period_end', NONE, NONE, 'DERIVED — latest earned_at among the linked commissions.', 'cdo_payouts.periodEnd'],
  ['paid_at', 'Date', PAY, 'REQUIRED — the importer rejects a payout without it.', 'cdo_payouts.paidAt'],
  ['reference_or_check_number', 'ID', PAY, 'GENERATED — GOAFFPRO-<program>-<ID>, guaranteed unique so it works as the re-run idempotency key. The provider reference ("Payment Note for Admin") goes into notes.', 'cdo_payouts.reference'],
  ['linked_commission_row_ids', "Is Paid ?", `${TX}, ${PAY}`, 'THE CRITICAL FIELD. CDO: taken from the transactions export\'s "Is Paid ?" column, which is NOT a boolean — it holds the GoAffPro payout ID that settled the row (473 of 490 CDO payouts reconcile exactly). PHC: that column is zeroed, so links are RECONSTRUCTED oldest-first against each affiliate\'s "Amount Paid", using a CUMULATIVE budget across their payouts (a per-payout budget strands each payout\'s leftover and left $8,688 wrongly looking owed). Lands within $0.27. A payout with no linkable commission is EXCLUDED — the importer requires at least one.', '→ cdo_payouts.commissionIds[]'],
  ['goaffpro_payout_id', 'ID', PAY, '', '(reference only)'],
  ['notes', NONE, NONE, 'Generated — states whether the linkage came from the export or was reconstructed. NOT imported: the importer writes its own fixed system_note remark (migration.service.js:706).', '(reference only)'],
  SECTION('reference columns'),
  ['source_program', NONE, NONE, 'CDO or PHC.', '(reference only)'],
  ['goaffpro_payment_method_raw', 'Payment Method', PAY, 'Unmapped original.', '(reference only)'],
  ['goaffpro_payment_data', 'Payment Data', PAY, 'e.g. "PayPal email address: …", "Venmo Mobile number: …".', '(reference only)'],
  ['linked_commission_sum', NONE, NONE, 'DERIVED — sum of the linked commissions.', '(reference only)'],
  ['variance_vs_payout_amount', NONE, NONE, 'DERIVED — linked_commission_sum − payout_amount. Non-zero is flagged.', '(reference only)'],
  ['data_quality_flags', NONE, NONE, 'LINKED_COMMISSIONS_DO_NOT_SUM_TO_PAYOUT_AMOUNT, PAYOUT_LINK_RECONSTRUCTED_FIFO_NOT_FROM_EXPORT.', '(reference only)'],
];

// ── 7. Vendor Commission Rates ───────────────────────────────────────────
sheets['Vendor Commission Rates'] = [
  ['row_id', NONE, NONE, 'Generated sequence. Used by the importer to label errors in its report; never persisted to the DB.', '(error reporting only, not stored)'],
  ['vendor_name', 'Vendor', PROD, 'NOT AVAILABLE — the "Vendor" column is BLANK on all 5,845 rows of the GoAffPro products export, so no vendor→rate mapping can be migrated.', 'cdo_settings.vendorCommissions[].vendor'],
  ['commission_percent', NONE, NONE, 'NOT AVAILABLE — see above. Must be entered by hand from the Shopify product vendors BEFORE the program computes commission on NEW orders.', 'cdo_settings.vendorCommissions[].commissionPercent'],
  ['notes', NONE, NONE, '', '(reference only)'],
  SECTION('This sheet ships EMPTY on purpose. It is the only part of the CDO program that could not be migrated from GoAffPro.'),
];

// ── Emit ─────────────────────────────────────────────────────────────────
const wb = XLSX.utils.book_new();
const ORDER = ['Practitioners', 'Referral Codes', 'Referral URL Mapping', 'Referred Customers',
  'Historical Orders Commissions', 'Historical Payouts', 'Vendor Commission Rates'];
for (const name of ORDER) {
  const aoa = [HEAD, ['', '', '', '', ''], ...sheets[name]];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 34 }, { wch: 34 }, { wch: 30 }, { wch: 96 }, { wch: 40 }];
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, ws, name);
}
XLSX.writeFile(wb, OUT);
console.log('WROTE', OUT);
for (const name of ORDER) console.log(`  ${String(sheets[name].length).padStart(3)} rows  ${name}`);
