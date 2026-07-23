// GoAffPro → CDO Program migration import.
//
// Parses the Excel workbook described in
// docs/migration/goaffpro-migration-plan.md + GoAffPro_Migration_Template.xlsx,
// validates it, and (when commit=true) writes the resulting records.
//
// Ownership rule this module NEVER breaks: it only writes to collections
// ns-retail owns (cdo_practitioner_codes, cdo_referrals, cdo_orders,
// cdo_commissions, cdo_payouts, cdo_settings). `WholesaleApplication` is
// READ-ONLY here — a practitioner row that doesn't match an existing
// wholesale_applications record by email is reported as unresolved and
// every dependent row for that practitioner is skipped, never invented.
//
// Historical orders/commissions are migrated as business-data placeholders,
// not full Shopify order snapshots — the source spreadsheet carries no line
// items/addresses, and doing a live Shopify order-by-name lookup per row
// would add a hard external dependency + rate-limit risk for what could be
// hundreds of rows. Each migrated cdo_orders doc gets a deterministic
// synthetic `shopifyOrderId` (`legacy:goaffpro:<shop>:<order id/name>`),
// clearly distinguishable from a real `gid://shopify/Order/...`, which is
// what the idempotency re-run check keys off.

import XLSX from "xlsx";
import mongoose from "mongoose";
import connectDB from "../../db/mongo.server";
import WholesaleApplication from "../../models/wholesaleApplication.server";
import CdoPractitionerCode from "../../models/cdoPractitionerCode.server";
import CdoReferral from "../../models/cdoReferral.server";
import CdoOrder from "../../models/cdoOrder.server";
import CdoCommission from "../../models/cdoCommission.server";
import CdoPayout from "../../models/cdoPayout.server";
import CdoSetting from "../../models/cdoSetting.server";
import { unauthenticated } from "../../shopify.server";
import { createShopifyDiscount } from "./cdo.discount.service";
import { normalizeReferralCode } from "../../utils/referralCode";
import { readEnv } from "../../utils/env.utils";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("migration.service");

const SHEET_NAMES = {
  practitioners: "Practitioners",
  referralCodes: "Referral_Codes",
  referralUrlMapping: "Referral_URL_Mapping",
  referredCustomers: "Referred_Customers",
  historicalOrders: "Historical_Orders_Commissions",
  historicalPayouts: "Historical_Payouts",
  vendorRates: "Vendor_Commission_Rates",
};

// ── Parsing ──────────────────────────────────────────────────────────────

function sheetToRows(workbook, sheetName) {
  const ws = workbook.Sheets[sheetName];
  if (!ws) return [];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
  const headers = (raw[0] || []).map((h) => String(h ?? "").trim());
  return raw
    .slice(1)
    .filter((row) => row.some((cell) => cell !== "" && cell !== null && cell !== undefined))
    .map((row, i) => {
      const obj = { _sheetRowNumber: i + 2 }; // +2 = header row + 1-indexed
      headers.forEach((h, idx) => {
        if (h) obj[h] = row[idx];
      });
      return obj;
    });
}

// `data` is a Uint8Array (the route reads the uploaded File via
// `.arrayBuffer()` and wraps it — kept as a plain Web API type, not a
// Node `Buffer`, so this stays usable from either a Node or edge runtime).
export function parseMigrationWorkbook(data) {
  const workbook = XLSX.read(data, { type: "array" });
  return {
    practitioners: sheetToRows(workbook, SHEET_NAMES.practitioners),
    referralCodes: sheetToRows(workbook, SHEET_NAMES.referralCodes),
    referralUrlMapping: sheetToRows(workbook, SHEET_NAMES.referralUrlMapping),
    referredCustomers: sheetToRows(workbook, SHEET_NAMES.referredCustomers),
    historicalOrders: sheetToRows(workbook, SHEET_NAMES.historicalOrders),
    historicalPayouts: sheetToRows(workbook, SHEET_NAMES.historicalPayouts),
    vendorRates: sheetToRows(workbook, SHEET_NAMES.vendorRates),
  };
}

// ── Small shared helpers ─────────────────────────────────────────────────

function s(v) {
  return v === null || v === undefined ? "" : String(v).trim();
}
function lc(v) {
  return s(v).toLowerCase();
}
function bool(v) {
  return String(v).trim().toUpperCase() === "TRUE" || v === true || v === 1;
}
function num(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function dateOrNull(v) {
  if (!v && v !== 0) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function isFraction(n) {
  return typeof n === "number" && n >= 0 && n <= 1;
}

// `unauthenticated.admin` needs a bare shop domain (no protocol). Same
// multi-shop disambiguation as scripts/migrate-practitioner-discounts.js —
// prefer an explicit override, only auto-detect when unambiguous.
async function resolveRetailShop() {
  const configured = readEnv("CDO_RETAIL_SHOP");
  if (configured) return configured;
  const sessions = await mongoose.connection.db
    .collection("shopify_sessions")
    .find({ isOnline: false })
    .toArray();
  const distinctShops = [...new Set(sessions.map((doc) => doc.shop).filter(Boolean))];
  if (distinctShops.length === 1) return distinctShops[0];
  throw new Error(
    distinctShops.length === 0
      ? "Could not resolve the retail shop — no offline session found and CDO_RETAIL_SHOP is not set."
      : `Ambiguous retail shop (found ${distinctShops.length}: ${distinctShops.join(", ")}) — set CDO_RETAIL_SHOP explicitly in .env.`,
  );
}

const URL_REDIRECT_CREATE = `#graphql
  mutation MigrationUrlRedirectCreate($redirect: UrlRedirectInput!) {
    urlRedirectCreate(urlRedirect: $redirect) {
      urlRedirect { id path target }
      userErrors { field message }
    }
  }
`;

function pathFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return `${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

// ── Report scaffolding ───────────────────────────────────────────────────

function newSection() {
  return { total: 0, created: 0, updated: 0, alreadyExists: 0, skipped: 0, errors: [] };
}

function pushError(section, rowId, message) {
  section.errors.push({ row_id: rowId, message });
}

// ── Main entry point ─────────────────────────────────────────────────────

// `commit=false` runs every resolution/validation step WITHOUT writing
// anything (no Mongo writes, no Shopify API calls) — a true dry run.
// `commit=true` performs the same walk but actually persists + calls
// Shopify. Both modes return the identical report shape so the UI can show
// one preview and, on commit, the same shape again with real outcomes.
export async function runMigrationImport({ parsed, actor, commit, migrationRunId = null }) {
  await connectDB();

  // Stamped on every record this importer creates, so migrated data is
  // uniformly recognizable afterwards ({ migrationSource: "goaffpro" }) and
  // each record links back to its cdo_migration_runs audit entry.
  const prov = { migrationSource: "goaffpro", migrationRunId: migrationRunId || null };

  const report = {
    dryRun: !commit,
    practitioners: newSection(),
    referralCodes: newSection(),
    referralUrlMapping: newSection(),
    referredCustomers: newSection(),
    historicalOrders: newSection(),
    historicalPayouts: newSection(),
    vendorRates: newSection(),
  };

  let shop = null;
  try {
    shop = await resolveRetailShop();
  } catch (err) {
    // Only referral-code discount creation + redirect creation need the
    // shop; everything else (DB writes) can proceed without it, so this is
    // a warning attached to those two sections rather than a hard abort.
    pushError(report.referralCodes, null, `Could not resolve retail shop: ${err.message}`);
    pushError(report.referralUrlMapping, null, `Could not resolve retail shop: ${err.message}`);
  }

  // ── 1. Practitioners — resolve by email against wholesale_applications
  //    (READ-ONLY; never created/updated here) ──
  const practitionerByEmail = new Map(); // email -> { practitionerId, name, email }
  for (const row of parsed.practitioners) {
    report.practitioners.total += 1;
    const email = lc(row.practitioner_email);
    if (!email) {
      pushError(report.practitioners, row.row_id, "practitioner_email is required");
      continue;
    }
    const app = await WholesaleApplication.findOne({
      email: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
    })
      .select("_id firstName lastName")
      .lean();
    if (!app) {
      report.practitioners.skipped += 1;
      pushError(
        report.practitioners,
        row.row_id,
        `No matching wholesale_applications record for "${email}" — this practitioner (and every row that references them) will be skipped. They must have an approved wholesale application before their referral history can be migrated.`,
      );
      continue;
    }
    practitionerByEmail.set(email, {
      practitionerId: String(app._id),
      practitionerEmail: email,
      practitionerName:
        [row.practitioner_first_name, row.practitioner_last_name].filter(Boolean).join(" ") ||
        [app.firstName, app.lastName].filter(Boolean).join(" ") ||
        email,
    });
    report.practitioners.created += 1; // "resolved", reusing the counter for the UI
  }

  // ── 2. Referral_Codes ──
  const codeMetaByCode = new Map(); // normalized code -> { practitionerId, practitionerEmail, practitionerName, discountPercent, commissionRate }
  for (const row of parsed.referralCodes) {
    report.referralCodes.total += 1;
    const email = lc(row.practitioner_email);
    const practitioner = practitionerByEmail.get(email);
    if (!practitioner) {
      pushError(report.referralCodes, row.row_id, `Unresolved practitioner "${email}" — skipped`);
      continue;
    }
    const code = normalizeReferralCode(row.code);
    if (!code) {
      pushError(report.referralCodes, row.row_id, "code is required");
      continue;
    }
    const discountPercent = num(row.discount_percent);
    if (!isFraction(discountPercent)) {
      pushError(
        report.referralCodes,
        row.row_id,
        `discount_percent must be a fraction between 0 and 1 (got "${row.discount_percent}")`,
      );
      continue;
    }
    const commissionRateRaw = num(row.commission_rate);
    const commissionRate = commissionRateRaw === null ? null : commissionRateRaw;
    if (commissionRate !== null && !isFraction(commissionRate)) {
      pushError(
        report.referralCodes,
        row.row_id,
        `commission_rate must be a fraction between 0 and 1 when set (got "${row.commission_rate}")`,
      );
      continue;
    }

    try {
      const existing = shop
        ? await CdoPractitionerCode.findOne({ shop, code }).lean()
        : await CdoPractitionerCode.findOne({ code, practitionerId: practitioner.practitionerId }).lean();
      if (existing) {
        report.referralCodes.alreadyExists += 1;
        codeMetaByCode.set(code, {
          practitionerId: existing.practitionerId,
          practitionerEmail: existing.practitionerEmail,
          practitionerName: existing.practitionerName,
          discountPercent: existing.discountPercent,
          commissionRate: existing.commissionRate,
        });
        continue;
      }

      codeMetaByCode.set(code, {
        practitionerId: practitioner.practitionerId,
        practitionerEmail: practitioner.practitionerEmail,
        practitionerName: practitioner.practitionerName,
        discountPercent,
        commissionRate,
      });

      if (!commit) {
        report.referralCodes.created += 1;
        continue;
      }

      const doc = await CdoPractitionerCode.create({
        shop,
        practitionerId: practitioner.practitionerId,
        practitionerSource: "wholesale",
        practitionerEmail: practitioner.practitionerEmail,
        practitionerName: practitioner.practitionerName,
        code,
        isPrimary: bool(row.is_primary),
        discountPercent,
        commissionRate,
        status: ["active", "paused", "archived"].includes(s(row.status)) ? s(row.status) : "active",
        note: "Migrated from GoAffPro",
        createdBy: actor,
        ...prov,
      });

      if (shop) {
        const discountResult = await createShopifyDiscount({
          shop,
          code,
          discountPercent,
          practitionerId: practitioner.practitionerId,
          practitionerName: practitioner.practitionerName,
        }).catch((err) => ({ ok: false, error: err?.message || String(err) }));
        if (discountResult.ok) {
          doc.shopifyDiscountId = discountResult.shopifyDiscountId || null;
          doc.shopifyDiscountUrl = discountResult.shopifyDiscountUrl || null;
          await doc.save();
        } else {
          log.warn("migration.discount_create_failed", { code, error: discountResult.error });
          pushError(
            report.referralCodes,
            row.row_id,
            `Code created in the database, but the Shopify discount failed to create: ${discountResult.error || "unknown error"}. Retry from the referral code's admin page once the underlying issue is fixed.`,
          );
        }
      }
      report.referralCodes.created += 1;
    } catch (err) {
      pushError(report.referralCodes, row.row_id, err?.message || String(err));
    }
  }

  // ── 3. Referral_URL_Mapping — Shopify URL Redirects ──
  for (const row of parsed.referralUrlMapping) {
    report.referralUrlMapping.total += 1;
    const code = normalizeReferralCode(row.new_referral_code);
    if (!codeMetaByCode.has(code)) {
      pushError(
        report.referralUrlMapping,
        row.row_id,
        `new_referral_code "${row.new_referral_code}" was not found on the Referral_Codes sheet (or failed to migrate) — skipped`,
      );
      continue;
    }
    if (!bool(row.create_redirect)) {
      report.referralUrlMapping.skipped += 1;
      continue;
    }
    const fromPath = pathFromUrl(s(row.legacy_full_url));
    const toTarget = s(row.new_full_url);
    if (!fromPath || !toTarget) {
      pushError(
        report.referralUrlMapping,
        row.row_id,
        "legacy_full_url / new_full_url must both be valid URLs",
      );
      continue;
    }
    if (!commit) {
      report.referralUrlMapping.created += 1;
      continue;
    }
    if (!shop) {
      pushError(report.referralUrlMapping, row.row_id, "Retail shop could not be resolved — redirect not created");
      continue;
    }
    try {
      const admin = await unauthenticated.admin(shop);
      const res = await admin.graphql(URL_REDIRECT_CREATE, {
        variables: { redirect: { path: fromPath, target: toTarget } },
      });
      const body = await res.json();
      const userErrors = body?.data?.urlRedirectCreate?.userErrors || [];
      if (userErrors.length) {
        if (userErrors.some((e) => /already exists|has already been taken/i.test(e.message || ""))) {
          report.referralUrlMapping.alreadyExists += 1;
        } else {
          pushError(report.referralUrlMapping, row.row_id, userErrors.map((e) => e.message).join("; "));
        }
        continue;
      }
      report.referralUrlMapping.created += 1;
    } catch (err) {
      pushError(report.referralUrlMapping, row.row_id, err?.message || String(err));
    }
  }

  // ── 4. Referred_Customers → cdo_referrals ──
  for (const row of parsed.referredCustomers) {
    report.referredCustomers.total += 1;
    const email = lc(row.practitioner_email);
    const practitioner = practitionerByEmail.get(email);
    if (!practitioner) {
      pushError(report.referredCustomers, row.row_id, `Unresolved practitioner "${email}" — skipped`);
      continue;
    }
    const code = normalizeReferralCode(row.referral_code_used);
    const referredEmail = lc(row.customer_email);
    if (!referredEmail) {
      pushError(report.referredCustomers, row.row_id, "customer_email is required");
      continue;
    }
    const status = ["pending", "converted", "expired"].includes(s(row.referral_status))
      ? s(row.referral_status)
      : "pending";
    try {
      const existing = await CdoReferral.findOne({
        practitionerId: practitioner.practitionerId,
        referralCode: code,
        referredEmail,
      }).lean();
      if (existing) {
        report.referredCustomers.alreadyExists += 1;
        continue;
      }
      if (!commit) {
        report.referredCustomers.created += 1;
        continue;
      }
      await CdoReferral.create({
        shop,
        practitionerId: practitioner.practitionerId,
        practitionerEmail: practitioner.practitionerEmail,
        practitionerName: practitioner.practitionerName,
        referralCode: code,
        referredEmail,
        referredName: [row.customer_first_name, row.customer_last_name].filter(Boolean).join(" ") || null,
        status,
        referredAt: dateOrNull(row.first_referred_at),
        convertedAt: dateOrNull(row.converted_at),
        ...prov,
      });
      report.referredCustomers.created += 1;
    } catch (err) {
      pushError(report.referredCustomers, row.row_id, err?.message || String(err));
    }
  }

  // ── 5. Historical_Orders_Commissions → cdo_orders + cdo_commissions ──
  const commissionIdByRowId = new Map(); // sheet row_id -> created cdo_commissions _id
  for (const row of parsed.historicalOrders) {
    report.historicalOrders.total += 1;
    const email = lc(row.practitioner_email);
    const practitioner = practitionerByEmail.get(email);
    if (!practitioner) {
      pushError(report.historicalOrders, row.row_id, `Unresolved practitioner "${email}" — skipped`);
      continue;
    }
    const code = normalizeReferralCode(row.referral_code_used);
    const orderRef = s(row.shopify_order_id_or_name);
    if (!orderRef) {
      pushError(report.historicalOrders, row.row_id, "shopify_order_id_or_name is required");
      continue;
    }
    const orderAmount = num(row.order_amount);
    const rate = num(row.commission_rate_applied);
    const commissionAmount = num(row.commission_amount);
    if (orderAmount === null || commissionAmount === null) {
      pushError(report.historicalOrders, row.row_id, "order_amount and commission_amount are required numbers");
      continue;
    }
    if (rate !== null && !isFraction(rate)) {
      pushError(report.historicalOrders, row.row_id, `commission_rate_applied must be a fraction 0–1 (got "${row.commission_rate_applied}")`);
      continue;
    }
    const commissionStatus = ["pending", "approved", "paid", "reversed"].includes(s(row.commission_status))
      ? s(row.commission_status)
      : "pending";
    const payoutStatus = ["pending", "paid"].includes(s(row.payout_status)) ? s(row.payout_status) : "pending";
    if (commissionStatus === "paid" && !row.paid_at) {
      pushError(report.historicalOrders, row.row_id, "paid_at is required when commission_status='paid'");
      continue;
    }

    const syntheticOrderId = `legacy:goaffpro:${shop || "unknown"}:${orderRef}`;
    try {
      const existingOrder = await CdoOrder.findOne({ shop, shopifyOrderId: syntheticOrderId }).lean();
      if (existingOrder) {
        report.historicalOrders.alreadyExists += 1;
        // Still need the previously-created commission id if this row links
        // to a Historical_Payouts row on a re-run.
        const existingCommission = await CdoCommission.findOne({ orderId: existingOrder._id }).select("_id").lean();
        if (existingCommission) commissionIdByRowId.set(String(row.row_id), existingCommission._id);
        continue;
      }
      if (!commit) {
        report.historicalOrders.created += 1;
        // Dry run never creates a real CdoCommission, but Historical_Payouts'
        // linked_commission_row_ids check still needs a truthy placeholder
        // here so a valid link isn't reported as broken during preview.
        commissionIdByRowId.set(String(row.row_id), `dry-run:${row.row_id}`);
        continue;
      }

      const placedAt = dateOrNull(row.order_placed_at) || new Date();
      const order = await CdoOrder.create({
        shop,
        attributed: true,
        practitionerId: practitioner.practitionerId,
        practitionerEmail: practitioner.practitionerEmail,
        practitionerName: practitioner.practitionerName,
        shopifyOrderId: syntheticOrderId,
        orderName: orderRef,
        customerEmail: lc(row.customer_email) || null,
        customerName: s(row.customer_name) || null,
        currency: s(row.currency) || "USD",
        amount: orderAmount,
        commissionAmount,
        referral: {
          code,
          practitionerId: practitioner.practitionerId,
          practitionerSource: "wholesale",
          practitionerName: practitioner.practitionerName,
          practitionerEmail: practitioner.practitionerEmail,
          discountPercent: codeMetaByCode.get(code)?.discountPercent ?? 0,
          commissionRate: rate,
        },
        referralCode: code,
        status: commissionStatus === "reversed" ? "cancelled" : commissionStatus === "paid" ? "paid" : "approved",
        placedAt,
        // Non-schema fields (strict:false) — traceability, never read by
        // the live ingestion pipeline.
        migratedFromGoAffPro: true,
        goaffproOrderId: s(row.goaffpro_order_id) || null,
        ...prov,
      });

      const commission = await CdoCommission.create({
        shop,
        practitionerId: practitioner.practitionerId,
        practitionerEmail: practitioner.practitionerEmail,
        practitionerName: practitioner.practitionerName,
        orderId: order._id,
        orderName: orderRef,
        currency: s(row.currency) || "USD",
        amount: commissionAmount,
        rate: rate ?? 0,
        status: commissionStatus,
        payoutStatus: commissionStatus === "reversed" ? "cancelled" : payoutStatus,
        earnedAt: dateOrNull(row.earned_at) || placedAt,
        payoutDate: dateOrNull(row.paid_at),
        ...prov,
      });
      commissionIdByRowId.set(String(row.row_id), commission._id);
      report.historicalOrders.created += 1;
    } catch (err) {
      pushError(report.historicalOrders, row.row_id, err?.message || String(err));
    }
  }

  // ── 6. Historical_Payouts → cdo_payouts (+ link commissions) ──
  for (const row of parsed.historicalPayouts) {
    report.historicalPayouts.total += 1;
    const email = lc(row.practitioner_email);
    const practitioner = practitionerByEmail.get(email);
    if (!practitioner) {
      pushError(report.historicalPayouts, row.row_id, `Unresolved practitioner "${email}" — skipped`);
      continue;
    }
    const amount = num(row.payout_amount);
    if (amount === null) {
      pushError(report.historicalPayouts, row.row_id, "payout_amount is required");
      continue;
    }
    if (!row.paid_at) {
      pushError(report.historicalPayouts, row.row_id, "paid_at is required for a historical payout");
      continue;
    }
    const linkedRowIds = s(row.linked_commission_row_ids)
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (!linkedRowIds.length) {
      pushError(report.historicalPayouts, row.row_id, "linked_commission_row_ids is required — a historical payout must link to at least one migrated commission");
      continue;
    }
    const commissionIds = [];
    let missing = false;
    for (const linkedId of linkedRowIds) {
      const cid = commissionIdByRowId.get(linkedId);
      if (!cid) {
        pushError(report.historicalPayouts, row.row_id, `linked_commission_row_ids references row_id ${linkedId}, which was not found/created on Historical_Orders_Commissions`);
        missing = true;
        break;
      }
      commissionIds.push(cid);
    }
    if (missing) continue;

    try {
      const existing = await CdoPayout.findOne({
        shop,
        practitionerId: practitioner.practitionerId,
        reference: s(row.reference_or_check_number) || undefined,
        paidAt: dateOrNull(row.paid_at),
      }).lean();
      if (existing) {
        report.historicalPayouts.alreadyExists += 1;
        continue;
      }
      if (!commit) {
        report.historicalPayouts.created += 1;
        continue;
      }
      const method = ["ach", "check", "paypal", "manual"].includes(s(row.payout_method))
        ? s(row.payout_method)
        : "manual";
      const paidAt = dateOrNull(row.paid_at);
      const payout = await CdoPayout.create({
        shop,
        practitionerId: practitioner.practitionerId,
        practitionerSource: "wholesale",
        practitionerEmail: practitioner.practitionerEmail,
        practitionerName: practitioner.practitionerName,
        currency: s(row.currency) || "USD",
        amount,
        method,
        status: "paid",
        commissionIds,
        periodStart: dateOrNull(row.period_start),
        periodEnd: dateOrNull(row.period_end),
        reference: s(row.reference_or_check_number) || null,
        paidAt,
        remarks: [
          {
            kind: "system_note",
            message: "Migrated from GoAffPro — historical payout, already settled.",
            actor,
            source: "admin",
          },
        ],
        ...prov,
      });
      await CdoCommission.updateMany(
        { _id: { $in: commissionIds } },
        { $set: { payoutId: payout._id, payoutStatus: "paid", status: "paid", payoutDate: paidAt } },
      );
      report.historicalPayouts.created += 1;
    } catch (err) {
      pushError(report.historicalPayouts, row.row_id, err?.message || String(err));
    }
  }

  // ── 7. Vendor_Commission_Rates → cdo_settings.vendorCommissions[] ──
  if (parsed.vendorRates.length) {
    const settings = commit
      ? await CdoSetting.findOneAndUpdate(
          { singletonKey: "cdo-program" },
          { $setOnInsert: { singletonKey: "cdo-program" } },
          { upsert: true, new: true },
        )
      : await CdoSetting.findOne({ singletonKey: "cdo-program" });
    const existingRates = settings?.vendorCommissions ? [...settings.vendorCommissions] : [];
    for (const row of parsed.vendorRates) {
      report.vendorRates.total += 1;
      const vendor = s(row.vendor_name);
      const pct = num(row.commission_percent);
      if (!vendor || !isFraction(pct)) {
        pushError(report.vendorRates, row.row_id, "vendor_name is required and commission_percent must be a fraction 0–1");
        continue;
      }
      const idx = existingRates.findIndex((r) => r.vendor === vendor);
      if (idx >= 0) {
        existingRates[idx] = { ...existingRates[idx], commissionPercent: pct, updatedAt: new Date(), updatedBy: actor };
        report.vendorRates.updated += 1;
      } else {
        existingRates.push({ vendor, commissionPercent: pct, updatedAt: new Date(), updatedBy: actor });
        report.vendorRates.created += 1;
      }
    }
    if (commit && settings) {
      settings.vendorCommissions = existingRates;
      settings.commissionConfigVersion = (settings.commissionConfigVersion || 1) + 1;
      await settings.save();
    }
  }

  return report;
}
