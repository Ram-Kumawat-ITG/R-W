// CDO Program data access + aggregation layer.
//
// All reads for the CDO Program tabs route through here so the route
// loaders stay thin and the queries are reusable across the Dashboard,
// Reports, and per-tab list pages. Each function ensures the shared
// Mongo connection (connectDB is cached + idempotent) before querying.
//
// User-type model (two collections, two roles):
//   • Practitioners → `wholesale_applications` (approved applicants who
//     resell). These own referral codes. The CDO Program admin's
//     "Customers" list + detail pages surface practitioners from here.
//   • Customers (Retailer + Patient) → `cdo_applications`. A customer
//     application may carry a referral code that maps back to a
//     practitioner in wholesale_applications, making the customer
//     eligible for that code's discount.
//
// Referral codes live in `cdo_practitioner_codes`, keyed to the owning
// practitioner via `practitionerId` + `practitionerSource` ("wholesale").
// The practitioner↔customer relationship is tracked through this code
// mapping — see validateReferralCode() / buildReferralSnapshot() below.

import mongoose from "mongoose";
import connectDB from "../../db/mongo.server";
import WholesaleApplication from "../../models/wholesaleApplication.server";
import CdoApplication from "../../models/cdoApplication.server";
import CdoOrder from "../../models/cdoOrder.server";
import CdoCommission from "../../models/cdoCommission.server";
import CdoPayout from "../../models/cdoPayout.server";
import CdoReferral from "../../models/cdoReferral.server";
import CdoTransaction from "../../models/cdoTransaction.server";
import CdoSetting from "../../models/cdoSetting.server";
import CdoCommissionConfigHistory from "../../models/cdoCommissionConfigHistory.server";
import CdoPractitionerCode from "../../models/cdoPractitionerCode.server";
import CdoPractitionerHold from "../../models/cdoPractitionerHold.server";
import CdoPayoutBatch from "../../models/cdoPayoutBatch.server";
import {
  findOrCreateVendor,
  createBill,
  createBillPayment,
  billWebUrl,
} from "../qbo/qbo.service";
import {
  createShopifyDiscount,
  setShopifyDiscountActive,
} from "./cdo.discount.service";
import { schedulerConfig } from "../scheduler/scheduler.config";
import { payoutConfig } from "../payout/payout.config";
import { getPayoutProvider } from "../payout/provider";
import { createLogger } from "../../utils/logger.utils";
import {
  deriveShippingStatus,
  deriveDeliveryStatus,
  deriveDeliveredAt,
  extractTracking,
} from "../../utils/orderStatus";

const log = createLogger("cdo.service");

// Practitioners are approved wholesale applicants who resell. Real
// registration data records "resells" inconsistently: some rows set the
// boolean `resellsProducts`, others leave it false but describe what they
// resell in the free-text `tax.itemsToResell` (e.g. "yes", "Herbal
// supplements"). So we treat an approved applicant as a practitioner when
// EITHER signal is present — `resellsProducts === true`, OR
// `tax.itemsToResell` holds a real value (present, not empty / a
// negation). Matching only the literal "yes" missed legitimate
// practitioners who typed what they resell.
const RESELL_NEGATIVES = ["", "no", "No", "NO", "none", "None", "n/a", "N/A", null];
const PRACTITIONER_FILTER = {
  status: "approved",
  $or: [
    { resellsProducts: true },
    { "tax.itemsToResell": { $exists: true, $nin: RESELL_NEGATIVES } },
  ],
};

// Codes minted for CDO Program practitioners point at wholesale_applications.
const PRACTITIONER_SOURCE = "wholesale";

function sum(rows, field) {
  return rows.reduce((acc, r) => acc + (Number(r[field]) || 0), 0);
}

export async function listPractitioners() {
  await connectDB();
  const [rows, heldIds] = await Promise.all([
    WholesaleApplication.find(PRACTITIONER_FILTER)
      .sort({ submittedAt: -1 })
      .select(
        "firstName lastName email phone businessName submittedAt customerId status tax.itemsToResell",
      )
      .lean(),
    getHeldPractitionerIds(),
  ]);
  const held = new Set(heldIds.map(String));

  return rows.map((r) => ({
    id: r._id.toString(),
    firstName: r.firstName || "",
    lastName: r.lastName || "",
    name: `${r.firstName || ""} ${r.lastName || ""}`.trim(),
    email: r.email || "",
    phone: r.phone || "",
    businessName: r.businessName || "",
    submittedAt: r.submittedAt || null,
    customerId: r.customerId || null,
    status: r.status || "approved",
    // Practitioner-level payout hold (cdo_practitioner_holds). Distinct
    // from per-commission pause; gates the automated payout CRON.
    payoutsPaused: held.has(r._id.toString()),
  }));
}

export async function countPractitioners() {
  await connectDB();
  return WholesaleApplication.countDocuments(PRACTITIONER_FILTER);
}

// cdo_orders now holds EVERY synced order; program-wide order views scope
// to attributed (practitioner-linked) orders so "referral revenue" stays
// meaningful. Backward-compatible with pre-`attributed` seed rows (they
// carry a practitionerId).
const ATTRIBUTED_ORDER_FILTER = { practitionerId: { $ne: null } };

export async function listOrders({ limit = 0 } = {}) {
  await connectDB();
  const q = CdoOrder.find(ATTRIBUTED_ORDER_FILTER).sort({ placedAt: -1, createdAt: -1 });
  if (limit) q.limit(limit);
  const rows = await q.lean();
  return rows.map((r) => ({
    id: r._id.toString(),
    practitionerName: r.practitionerName || r.practitionerEmail || "—",
    orderName: r.orderName || r.orderNumber || r.shopifyOrderId || "—",
    customerName: r.customerName || r.customerEmail || "—",
    amount: r.amount || 0,
    commissionAmount: r.commissionAmount || 0,
    currency: r.currency || "USD",
    status: r.status || "pending",
    placedAt: r.placedAt || r.createdAt || null,
  }));
}

export async function listCommissions() {
  await connectDB();
  const rows = await CdoCommission.find({})
    .sort({ earnedAt: -1, createdAt: -1 })
    .lean();
  return rows.map((r) => ({
    id: r._id.toString(),
    practitionerId: r.practitionerId || null,
    practitionerName: r.practitionerName || r.practitionerEmail || "—",
    orderName: r.orderName || "—",
    amount: r.amount || 0,
    rate: r.rate || 0,
    currency: r.currency || "USD",
    status: r.status || "pending",
    paused: r.paused === true,
    pausedBy: r.pausedBy || null,
    pausedAt: r.pausedAt || null,
    earnedAt: r.earnedAt || r.createdAt || null,
  }));
}

export async function listPayouts() {
  await connectDB();
  const rows = await CdoPayout.find({})
    .sort({ createdAt: -1 })
    .lean();
  return rows.map((r) => ({
    id: r._id.toString(),
    practitionerName: r.practitionerName || r.practitionerEmail || "—",
    amount: r.amount || 0,
    currency: r.currency || "USD",
    method: r.method || "manual",
    status: r.status || "pending",
    periodStart: r.periodStart || null,
    periodEnd: r.periodEnd || null,
    reference: r.reference || "",
    paidAt: r.paidAt || null,
    commissionCount: Array.isArray(r.commissionIds) ? r.commissionIds.length : 0,
    qboBillId: r.qboBillId || null,
    qboBillUrl: r.qboBillId ? billWebUrl(r.qboBillId) : null,
    lastError: r.lastError || null,
    // Disbursement / settlement (real-money lifecycle).
    providerName: r.providerName || null,
    providerTransferId: r.providerTransferId || null,
    providerStatus: r.providerStatus || null,
    transferInitiatedAt: r.transferInitiatedAt || null,
    settledAt: r.settledAt || null,
    settlementLastCheckedAt: r.settlementLastCheckedAt || null,
    returnCode: r.returnCode || null,
    returnReason: r.returnReason || null,
    bankingError: r.bankingError || null,
  }));
}

export async function listReferrals() {
  await connectDB();
  const rows = await CdoReferral.find({})
    .sort({ referredAt: -1, createdAt: -1 })
    .lean();
  return rows.map((r) => ({
    id: r._id.toString(),
    practitionerName: r.practitionerName || r.practitionerEmail || "—",
    referredName: r.referredName || r.referredEmail || "—",
    referralCode: r.referralCode || "—",
    status: r.status || "pending",
    referredAt: r.referredAt || r.createdAt || null,
    convertedAt: r.convertedAt || null,
  }));
}

export async function listTransactions() {
  await connectDB();
  const rows = await CdoTransaction.find({})
    .sort({ occurredAt: -1, createdAt: -1 })
    .lean();
  return rows.map((r) => ({
    id: r._id.toString(),
    practitionerName: r.practitionerName || r.practitionerEmail || "—",
    type: r.type || "—",
    amount: r.amount || 0,
    currency: r.currency || "USD",
    balanceAfter: r.balanceAfter ?? null,
    description: r.description || "",
    occurredAt: r.occurredAt || r.createdAt || null,
  }));
}

export async function getSettings() {
  await connectDB();
  const doc = await CdoSetting.findOne({ singletonKey: "cdo-program" }).lean();
  return {
    programName: doc?.programName ?? "CDO Program",
    defaultCommissionRate: doc?.defaultCommissionRate ?? 0.1,
    currency: doc?.currency ?? "USD",
    payoutSchedule: doc?.payoutSchedule ?? "monthly",
    minimumPayoutAmount: doc?.minimumPayoutAmount ?? 50,
    autoApproveCommissions: doc?.autoApproveCommissions ?? false,
    cookieWindowDays: doc?.cookieWindowDays ?? 30,
    vendorCommissions: Array.isArray(doc?.vendorCommissions)
      ? doc.vendorCommissions
      : [],
    commissionConfigVersion: doc?.commissionConfigVersion ?? 1,
    configured: Boolean(doc),
  };
}

// ── Per-vendor commission configuration ──────────────────────────────
//
// Commission is vendor-driven: each order line earns
// `lineRevenue × vendorRate(line.vendor)`, where vendorRate is the configured
// fraction for that vendor (0 when the vendor isn't configured). The config is
// versioned (cdo_settings.commissionConfigVersion) and snapshotted onto every
// order at ingest, so edits here apply ONLY to future orders.

// Normalize a vendor key for case/space-insensitive matching (the Shopify
// vendor string is the identity; we store the original casing but match loosely
// so "Acme" and "acme " resolve to the same config).
function vendorKey(v) {
  return String(v || "").trim().toLowerCase();
}

// Saved vendor → fractional rate map (+ version) for the calc + UI.
export async function getVendorCommissions() {
  const settings = await getSettings();
  const rows = settings.vendorCommissions.map((v) => ({
    vendor: v.vendor,
    commissionPercent: Number(v.commissionPercent) || 0,
    updatedAt: v.updatedAt || null,
    updatedBy: v.updatedBy || null,
  }));
  return { version: settings.commissionConfigVersion, vendors: rows };
}

// Build a vendorKey → fraction lookup from a vendorCommissions array.
function buildVendorRateMap(vendorCommissions) {
  const map = new Map();
  for (const v of vendorCommissions || []) {
    map.set(vendorKey(v.vendor), Number(v.commissionPercent) || 0);
  }
  return map;
}

// Upsert one vendor's commission rate. `commissionPercent` is a FRACTION
// (0.10 = 10%). Bumps commissionConfigVersion + appends a history row. Idempotent
// on value (still bumps version + logs so the audit trail is complete).
export async function setVendorCommission({ vendor, commissionPercent, actor }) {
  const name = String(vendor || "").trim();
  if (!name) throw new Error("Vendor is required");
  const rate = normalizeFraction(commissionPercent, "Commission percent");
  if (rate == null) throw new Error("Commission percent is required");
  await connectDB();

  const doc =
    (await CdoSetting.findOne({ singletonKey: "cdo-program" })) ||
    new CdoSetting({ singletonKey: "cdo-program" });

  const list = Array.isArray(doc.vendorCommissions) ? doc.vendorCommissions : [];
  const idx = list.findIndex((v) => vendorKey(v.vendor) === vendorKey(name));
  const previousPercent = idx >= 0 ? Number(list[idx].commissionPercent) || 0 : null;

  if (idx >= 0) {
    list[idx].vendor = name;
    list[idx].commissionPercent = rate;
    list[idx].updatedAt = new Date();
    list[idx].updatedBy = actor || "system";
  } else {
    list.push({
      vendor: name,
      commissionPercent: rate,
      updatedAt: new Date(),
      updatedBy: actor || "system",
    });
  }
  doc.vendorCommissions = list;
  doc.commissionConfigVersion = (doc.commissionConfigVersion || 1) + 1;
  doc.markModified("vendorCommissions");
  await doc.save();

  await CdoCommissionConfigHistory.create({
    shop: doc.shop || null,
    vendor: name,
    action: "set",
    previousPercent,
    newPercent: rate,
    version: doc.commissionConfigVersion,
    changedBy: actor || "system",
    changedAt: new Date(),
  });

  return { vendor: name, commissionPercent: rate, version: doc.commissionConfigVersion };
}

// Remove a vendor's commission config (its products revert to 0% commission).
// Bumps version + logs. No-op (no version bump) if the vendor wasn't configured.
export async function removeVendorCommission({ vendor, actor }) {
  const name = String(vendor || "").trim();
  if (!name) throw new Error("Vendor is required");
  await connectDB();

  const doc = await CdoSetting.findOne({ singletonKey: "cdo-program" });
  if (!doc) return { removed: false };
  const list = Array.isArray(doc.vendorCommissions) ? doc.vendorCommissions : [];
  const idx = list.findIndex((v) => vendorKey(v.vendor) === vendorKey(name));
  if (idx < 0) return { removed: false };

  const previousPercent = Number(list[idx].commissionPercent) || 0;
  list.splice(idx, 1);
  doc.vendorCommissions = list;
  doc.commissionConfigVersion = (doc.commissionConfigVersion || 1) + 1;
  doc.markModified("vendorCommissions");
  await doc.save();

  await CdoCommissionConfigHistory.create({
    shop: doc.shop || null,
    vendor: name,
    action: "remove",
    previousPercent,
    newPercent: null,
    version: doc.commissionConfigVersion,
    changedBy: actor || "system",
    changedAt: new Date(),
  });

  return { removed: true, version: doc.commissionConfigVersion };
}

// Recent commission-config changes for the audit panel.
export async function getCommissionConfigHistory({ vendor, limit = 25 } = {}) {
  await connectDB();
  const match = {};
  if (vendor) match.vendor = vendor;
  const rows = await CdoCommissionConfigHistory.find(match)
    .sort({ changedAt: -1 })
    .limit(Math.min(Math.max(parseInt(limit, 10) || 25, 1), 200))
    .lean();
  return rows.map((r) => ({
    id: String(r._id),
    vendor: r.vendor,
    action: r.action,
    previousPercent: r.previousPercent,
    newPercent: r.newPercent,
    version: r.version,
    changedBy: r.changedBy || "system",
    changedAt: r.changedAt || null,
  }));
}

// Fetch ALL Shopify product vendors via Admin GraphQL (paginated). Returns a
// sorted array of vendor strings. `admin` is the authenticated admin client
// from authenticate.admin(request). Needs read_products (granted). Best-effort:
// returns [] on failure so the settings page still renders the saved configs.
const QUERY_PRODUCT_VENDORS = `#graphql
  query ProductVendors($first: Int!, $after: String) {
    productVendors(first: $first, after: $after) {
      edges { node }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export async function fetchProductVendors(admin) {
  if (!admin?.graphql) return [];
  const vendors = [];
  let after = null;
  try {
    for (let page = 0; page < 50; page++) {
      const res = await admin.graphql(QUERY_PRODUCT_VENDORS, {
        variables: { first: 250, after },
      });
      const body = await res.json();
      const conn = body?.data?.productVendors;
      if (!conn) break;
      for (const edge of conn.edges || []) {
        if (edge?.node) vendors.push(String(edge.node));
      }
      if (!conn.pageInfo?.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
  } catch (e) {
    console.error("[cdo] fetchProductVendors failed:", e?.message || e);
  }
  // Drop blanks + dedupe (case-insensitive), keep first-seen casing, sort.
  const seen = new Set();
  const out = [];
  for (const v of vendors) {
    const t = v.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

// Compute an order's commission per line from the per-vendor config, and build
// the immutable snapshot persisted on the order. Pure (no DB). A line whose
// vendor isn't configured earns 0%. Line revenue = price×qty − totalDiscount.
//   vendorCommissions — the cdo_settings.vendorCommissions array (live, at ingest)
//   configVersion     — cdo_settings.commissionConfigVersion (tags the snapshot)
function computeOrderCommission(doc, { vendorCommissions, configVersion } = {}) {
  const rateMap = buildVendorRateMap(vendorCommissions);
  const lines = (doc.lineItems || []).map((li) => {
    const revenue = roundMoney(
      (Number(li.price) || 0) * (Number(li.quantity) || 0) -
        (Number(li.totalDiscount) || 0),
    );
    const rate = rateMap.get(vendorKey(li.vendor)) || 0;
    return {
      vendor: li.vendor || null,
      revenue,
      rate,
      amount: roundMoney(revenue * rate),
    };
  });
  const commissionAmount = roundMoney(
    lines.reduce((s, l) => s + (Number(l.amount) || 0), 0),
  );
  const totalRevenue = lines.reduce((s, l) => s + (Number(l.revenue) || 0), 0);
  const effectiveRate =
    totalRevenue > 0 ? Number((commissionAmount / totalRevenue).toFixed(4)) : 0;
  const snapshot = {
    configVersion: configVersion ?? null,
    vendorRates: (vendorCommissions || []).map((v) => ({
      vendor: v.vendor,
      rate: Number(v.commissionPercent) || 0,
    })),
    lines,
    effectiveRate,
    computedAt: new Date(),
  };
  return { commissionAmount, snapshot };
}

// Dashboard KPIs + supporting lists. Computed in parallel; safe against
// empty collections (returns zeros / empty arrays).
export async function getDashboardMetrics() {
  await connectDB();

  const [
    orders,
    commissions,
    pendingPayouts,
    paidPayouts,
    failedPayouts,
    referrals,
    convertedReferrals,
    activePractitioners,
    upcoming,
  ] = await Promise.all([
    CdoOrder.find(ATTRIBUTED_ORDER_FILTER).select("amount commissionAmount placedAt createdAt").lean(),
    CdoCommission.find({}).select("amount status").lean(),
    // "Pending payouts" = every OPEN (non-terminal) payout — i.e. in flight,
    // not yet paid/failed/rejected/cancelled. The lifecycle is
    // draft → awaiting_approval → approved → processing → awaiting_settlement →
    // paid, so the open set must include `awaiting_settlement` (funds submitted,
    // awaiting bank confirmation) and `draft` — omitting `awaiting_settlement`
    // made this read $0 even with disbursements in flight.
    CdoPayout.find({
      status: {
        $in: [
          "draft",
          "awaiting_approval",
          "approved",
          "processing",
          "awaiting_settlement",
        ],
      },
    })
      .select("amount")
      .lean(),
    CdoPayout.find({ status: "paid" }).select("amount").lean(),
    CdoPayout.find({ status: "failed" }).select("amount").lean(),
    CdoReferral.countDocuments({}),
    CdoReferral.countDocuments({ status: "converted" }),
    countPractitioners(),
    getUpcomingPayouts(),
  ]);

  const totalRevenue = sum(orders, "amount");

  // Commission ledger by status. "Earned" excludes reversed; "Paid" is the
  // settled set; "Outstanding liability" = earned not yet paid.
  const earnedCommissions = commissions.filter((c) => c.status !== "reversed");
  const totalCommissionEarned = sum(earnedCommissions, "amount");
  const totalCommissionPaid = sum(
    commissions.filter((c) => c.status === "paid"),
    "amount",
  );
  const pendingApprovalAmount = sum(
    commissions.filter((c) => c.status === "pending"),
    "amount",
  );
  const reversedTotal = sum(
    commissions.filter((c) => c.status === "reversed"),
    "amount",
  );
  const outstandingLiability = roundMoney(totalCommissionEarned - totalCommissionPaid);

  const pendingPayoutTotal = sum(pendingPayouts, "amount");
  const paidPayoutTotal = sum(paidPayouts, "amount");
  const failedPayoutTotal = sum(failedPayouts, "amount");

  // Monthly performance — revenue + order count grouped by YYYY-MM.
  const monthMap = new Map();
  for (const o of orders) {
    const when = o.placedAt || o.createdAt;
    if (!when) continue;
    const d = new Date(when);
    if (Number.isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const entry = monthMap.get(key) || { month: key, revenue: 0, orders: 0 };
    entry.revenue += Number(o.amount) || 0;
    entry.orders += 1;
    monthMap.set(key, entry);
  }
  const monthlyPerformance = [...monthMap.values()]
    .sort((a, b) => b.month.localeCompare(a.month))
    .slice(0, 6);

  const [topPractitioners, recentOrders] = await Promise.all([
    getTopPractitioners({ limit: 5 }),
    listOrders({ limit: 5 }),
  ]);

  const conversionRate = referrals > 0 ? convertedReferrals / referrals : 0;
  const avgOrderValue = orders.length ? roundMoney(totalRevenue / orders.length) : 0;
  const avgCommissionPerOrder = orders.length
    ? roundMoney(sum(orders, "commissionAmount") / orders.length)
    : 0;

  return {
    kpis: {
      totalRevenue,
      totalCommissionEarned,
      totalCommissionPaid,
      outstandingLiability,
      pendingApprovalAmount,
      reversedTotal,
      pendingPayoutTotal,
      paidPayoutTotal,
      failedPayoutTotal,
      failedPayoutCount: failedPayouts.length,
      totalReferrals: referrals,
      convertedReferrals,
      conversionRate,
      activePractitioners,
      totalOrders: orders.length,
      avgOrderValue,
      avgCommissionPerOrder,
      // Back-compat alias for older callers that read `totalCommissions`.
      totalCommissions: totalCommissionEarned,
    },
    upcoming,
    monthlyPerformance,
    topPractitioners,
    recentOrders,
  };
}

// Next calendar 25th (the production payout schedule). Pure date math; dev
// runs on CDO_PAYOUT_INTERVAL but the business-meaningful "next payout date"
// is still the 25th.
function nextPayoutDate(from = new Date()) {
  const d = new Date(from);
  return d.getDate() < 25
    ? new Date(d.getFullYear(), d.getMonth(), 25)
    : new Date(d.getFullYear(), d.getMonth() + 1, 25);
}

// Forward-looking preview of what the NEXT payout run will disburse — a
// dry-run of the batch grouping with NO writes. Eligible commissions
// (approved, unpaid, not paused, not on practitioner hold — via
// getEligibleCommissions) grouped by practitioner; only practitioners whose
// total clears the minimum are included (mirrors buildPayoutBatch).
export async function getUpcomingPayouts({ shop } = {}) {
  await connectDB();
  const settings = await getSettings();
  const minAmount = Number(settings.minimumPayoutAmount) || 0;

  const eligible = await getEligibleCommissions({ periodEnd: new Date() });
  const rows = shop ? eligible.filter((c) => c.shop === shop) : eligible;

  const groups = new Map();
  for (const c of rows) {
    const key = c.practitionerId;
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, {
        practitionerId: key,
        practitionerName: c.practitionerName || c.practitionerEmail || "—",
        commissionCount: 0,
        amount: 0,
      });
    }
    const g = groups.get(key);
    g.commissionCount += 1;
    g.amount = roundMoney(g.amount + (Number(c.amount) || 0));
  }

  const breakdown = [...groups.values()]
    .filter((g) => g.amount >= minAmount)
    .sort((a, b) => b.amount - a.amount);
  const belowMinimum = [...groups.values()].filter((g) => g.amount < minAmount);

  return {
    estimatedDate: nextPayoutDate(),
    minimumPayoutAmount: minAmount,
    totalAmount: roundMoney(breakdown.reduce((s, g) => s + g.amount, 0)),
    practitionerCount: breakdown.length,
    commissionCount: breakdown.reduce((s, g) => s + g.commissionCount, 0),
    breakdown,
    belowMinimumCount: belowMinimum.length,
  };
}

// Top practitioners by attributed revenue + commission, aggregated from
// cdo_orders. Returns [] when there are no attributed orders yet.
export async function getTopPractitioners({ limit = 5 } = {}) {
  await connectDB();
  const rows = await CdoOrder.aggregate([
    { $match: ATTRIBUTED_ORDER_FILTER },
    {
      $group: {
        _id: {
          practitionerId: "$practitionerId",
          practitionerEmail: "$practitionerEmail",
        },
        practitionerName: { $first: "$practitionerName" },
        revenue: { $sum: "$amount" },
        commission: { $sum: "$commissionAmount" },
        orders: { $sum: 1 },
      },
    },
    { $sort: { revenue: -1 } },
    { $limit: limit },
  ]);

  return rows.map((r) => ({
    practitionerName:
      r.practitionerName || r._id?.practitionerEmail || "—",
    revenue: r.revenue || 0,
    commission: r.commission || 0,
    orders: r.orders || 0,
  }));
}

// ── Per-practitioner detail helpers ──────────────────────────────────
//
// Drive the CDO Customers detail page (`/app/cdo-program/customers/:id`).
// Every helper takes the practitioner's wholesale_applications `_id` as
// its primary key — that's the same id the CDO Customers list page hands
// to the row link.

function isValidObjectId(id) {
  return typeof id === "string" && mongoose.isValidObjectId(id);
}

// Pure derivation — same projection as listPractitioners() but for a
// single row. Returns null when the id is malformed or the document
// doesn't exist / isn't a CDO-eligible practitioner.
export async function getPractitionerProfile(id) {
  if (!isValidObjectId(id)) return null;
  await connectDB();
  const row = await WholesaleApplication.findOne({
    _id: id,
    ...PRACTITIONER_FILTER,
  }).lean();
  if (!row) return null;
  return {
    id: row._id.toString(),
    shop: row.shop || null,
    firstName: row.firstName || "",
    lastName: row.lastName || "",
    name: `${row.firstName || ""} ${row.lastName || ""}`.trim(),
    email: (row.email || "").toLowerCase(),
    phone: row.phone || "",
    businessName: row.businessName || "",
    submittedAt: row.submittedAt || null,
    customerId: row.customerId || null,
    status: row.status || "approved",
    // Country / address — best-effort from any address fields present
    // on the wholesale application; varies by registration version.
    country:
      row.billingAddress?.country ||
      row.shippingAddress?.country ||
      row.tax?.country ||
      null,
    // Tag / note placeholders — wholesale_applications doesn't store
    // these natively; surfaced for future expansion when admins add
    // notes (would land on a new cdo_practitioner_notes collection).
    notes: row.notes || null,
    tags: Array.isArray(row.tags) ? row.tags : [],
  };
}

// Identify a practitioner across all the cdo_* collections by both
// id AND email — different ingestion paths populate one or the other,
// so the queries union them.
function practitionerMatch(profile) {
  const ors = [];
  if (profile.id) ors.push({ practitionerId: profile.id });
  if (profile.email) ors.push({ practitionerEmail: profile.email.toLowerCase() });
  return ors.length > 0 ? { $or: ors } : { _id: null }; // never-match fallback
}

// ── Referral codes ───────────────────────────────────────────────────

// List every code owned by this practitioner. Primary first, then
// active by recency, then paused/archived at the bottom.
export async function listPractitionerCodes(practitionerId) {
  if (!isValidObjectId(practitionerId)) return [];
  await connectDB();
  const rows = await CdoPractitionerCode.find({ practitionerId })
    .sort({ isPrimary: -1, status: 1, createdAt: -1 })
    .lean();
  return rows.map((r) => ({
    id: r._id.toString(),
    code: r.code,
    isPrimary: r.isPrimary === true,
    discountPercent: r.discountPercent ?? 0,
    commissionRate: r.commissionRate, // null = "inherit from settings"
    status: r.status || "active",
    note: r.note || "",
    // Shareable storefront discount URL (https://<retail-shop>/discount/<code>),
    // populated when the backing Shopify discount was created. null for
    // 0%/attribution-only or legacy codes that have no discount object.
    referralUrl: r.shopifyDiscountUrl || null,
    createdAt: r.createdAt || null,
    updatedAt: r.updatedAt || null,
    createdBy: r.createdBy || null,
    updatedBy: r.updatedBy || null,
  }));
}

// Resolve "the practitioner's effective referral code" — used by the
// storefront / link-builder. Picks the primary code if one exists;
// otherwise the most recently created active code; else null.
export async function getPrimaryCode(practitionerId) {
  const codes = await listPractitionerCodes(practitionerId);
  return (
    codes.find((c) => c.isPrimary && c.status === "active") ||
    codes.find((c) => c.status === "active") ||
    null
  );
}

// Code validation helper — used by createPractitionerCode + update. The
// storefront matches case-insensitively, but we normalise to uppercase
// at write time so the unique index works reliably.
function normalizeAndValidateCode(rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) throw new Error("Referral code is required");
  if (!/^[A-Z0-9-]{3,40}$/.test(code)) {
    throw new Error(
      "Code must be 3–40 characters, letters / digits / hyphens only",
    );
  }
  return code;
}

function normalizeFraction(raw, label) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`${label} must be a decimal between 0 and 1 (e.g. 0.10 for 10%)`);
  }
  // Snap to 4 decimals so floating-point quirks don't pile up over
  // repeated edits.
  return Number(n.toFixed(4));
}

// `shop` is the RETAIL store (session.shop) where the backing Shopify discount
// is created — distinct from the code's stored `shop` (which follows the owning
// practitioner / wholesale application). Pass it from the admin action so the
// discount lands on the storefront the app is installed on.
export async function createPractitionerCode({
  practitionerId,
  code,
  discountPercent,
  commissionRate,
  isPrimary,
  note,
  actor,
  shop: discountShop,
}) {
  const profile = await getPractitionerProfile(practitionerId);
  if (!profile) throw new Error("Practitioner not found");

  const normalized = normalizeAndValidateCode(code);
  const discount = normalizeFraction(discountPercent, "Discount percent") ?? 0;
  const commission = normalizeFraction(commissionRate, "Commission rate");

  await connectDB();

  // A code's shop follows its owning practitioner — the DB uniqueness
  // guarantee is the partial index { shop, code }, so the dup pre-check
  // and the insert must both be shop-scoped to stay consistent with it.
  const shop = profile.shop ?? null;

  // Cheap pre-check for the per-shop uniqueness — surfaces a friendly
  // error before the DB layer throws E11000.
  const clash = await CdoPractitionerCode.findOne({ shop, code: normalized }).lean();
  if (clash) {
    throw new Error(
      `Code "${normalized}" is already in use by another practitioner`,
    );
  }

  // If this is the first code for the practitioner, force primary so
  // the storefront has SOMETHING to resolve. Otherwise honour the
  // caller's flag.
  const existingCount = await CdoPractitionerCode.countDocuments({
    practitionerId: profile.id,
  });
  const shouldBePrimary = existingCount === 0 || isPrimary === true;

  if (shouldBePrimary) {
    // Clear the existing primary, if any, so the partial unique index
    // doesn't fire.
    await CdoPractitionerCode.updateMany(
      { practitionerId: profile.id, isPrimary: true },
      { $set: { isPrimary: false, updatedBy: actor || "system" } },
    );
  }

  const doc = await CdoPractitionerCode.create({
    shop,
    practitionerId: profile.id,
    practitionerSource: PRACTITIONER_SOURCE,
    practitionerEmail: profile.email,
    practitionerName: profile.name,
    code: normalized,
    isPrimary: shouldBePrimary,
    discountPercent: discount,
    commissionRate: commission,
    status: "active",
    note: note ? String(note).slice(0, 500) : undefined,
    createdBy: actor || "system",
    updatedBy: actor || "system",
  });

  // When a discount % was set, create the backing Shopify discount on the
  // retail storefront so the shareable link actually applies a discount and
  // the pause/resume toggle has something to deactivate/reactivate. Discount %
  // is optional — a 0% code is attribution-only (no storefront discount), so
  // we skip the Shopify write entirely in that case. Best-effort: a discount
  // failure logs but never blocks code creation (an admin can re-trigger
  // later); the code row simply keeps a null shopifyDiscountUrl, and pause/
  // resume safely no-ops the Shopify side for it.
  const retailShop = discountShop || shop;
  if (discount > 0 && retailShop) {
    const disc = await createShopifyDiscount({
      shop: retailShop,
      code: doc.code,
      discountPercent: discount,
      practitionerName: profile.name,
    });
    if (disc.ok && (disc.shopifyDiscountId || disc.shopifyDiscountUrl)) {
      doc.shopifyDiscountId = disc.shopifyDiscountId || null;
      doc.shopifyDiscountUrl = disc.shopifyDiscountUrl || null;
      await doc.save();
    } else if (!disc.ok) {
      console.warn(
        `[cdo] code ${doc.code} created, but Shopify discount creation failed: ${disc.error}`,
      );
    }
  }

  return doc.toObject();
}

export async function updatePractitionerCode({
  practitionerId,
  codeId,
  code,
  discountPercent,
  commissionRate,
  status,
  note,
  actor,
}) {
  if (!isValidObjectId(practitionerId)) {
    throw new Error("Invalid practitioner id");
  }
  if (!isValidObjectId(codeId)) throw new Error("Invalid code id");
  await connectDB();

  const existing = await CdoPractitionerCode.findOne({
    _id: codeId,
    practitionerId,
  });
  if (!existing) throw new Error("Referral code not found");

  if (code !== undefined && code !== null && String(code).trim() !== "") {
    const normalized = normalizeAndValidateCode(code);
    if (normalized !== existing.code) {
      // Scope by the code's own shop to match the { shop, code } index.
      const clash = await CdoPractitionerCode.findOne({
        shop: existing.shop ?? null,
        code: normalized,
        _id: { $ne: existing._id },
      }).lean();
      if (clash) {
        throw new Error(
          `Code "${normalized}" is already in use by another practitioner`,
        );
      }
      existing.code = normalized;
    }
  }
  if (discountPercent !== undefined) {
    existing.discountPercent = normalizeFraction(discountPercent, "Discount percent") ?? 0;
  }
  if (commissionRate !== undefined) {
    existing.commissionRate = normalizeFraction(commissionRate, "Commission rate");
  }
  if (status !== undefined) {
    if (!["active", "paused", "archived"].includes(status)) {
      throw new Error(`Invalid status: ${status}`);
    }
    existing.status = status;
  }
  if (note !== undefined) {
    existing.note = note ? String(note).slice(0, 500) : "";
  }
  existing.updatedBy = actor || "system";
  await existing.save();
  return existing.toObject();
}

// Pause or resume a practitioner's referral code from the CDO admin.
//
// This is the admin-side mirror of the Practitioner Portal's
// setReferralCodeStatus (cdo.portal.service.js): it does NOT merely flip the
// DB status — it deactivates / reactivates the backing Shopify discount via
// the shared cdo.discount.service so the code genuinely stops (or resumes)
// applying on the storefront. The Shopify toggle runs FIRST so the DB status
// and the storefront never disagree (if the store update fails, the DB is left
// untouched and the caller surfaces the error).
//
// Pausing also stops new attributions/validations (validateReferralCode +
// the portal/checkout lookups all require status === "active"); existing
// cdo_referrals / cdo_commissions are immutable history and are untouched, so
// referral tracking + earned commissions are preserved.
//
// Legacy admin-created codes that never had a Shopify discount object
// (shopifyDiscountId unset) simply skip the Shopify call — there's no
// storefront discount to toggle, and the DB status gate still stops attribution.
export async function setPractitionerCodeStatus({
  practitionerId,
  codeId,
  status,
  actor,
  shop,
}) {
  if (!isValidObjectId(practitionerId)) {
    throw new Error("Invalid practitioner id");
  }
  if (!isValidObjectId(codeId)) throw new Error("Invalid code id");
  if (status !== "active" && status !== "paused") {
    throw new Error(`Invalid status: ${status}`);
  }
  await connectDB();

  const existing = await CdoPractitionerCode.findOne({
    _id: codeId,
    practitionerId,
  });
  if (!existing) throw new Error("Referral code not found");
  if (existing.status === "archived") {
    throw new Error("Archived codes can't be paused or resumed");
  }

  // Idempotent — already in the requested state.
  if (existing.status === status) return existing.toObject();

  // Toggle the backing Shopify discount before flipping the DB status.
  // The discount lives on the RETAIL store (where the admin is logged in and
  // where the app has an offline session) — prefer the caller-supplied `shop`
  // (session.shop) over the code's stored `shop`, which for wholesale-created
  // codes can be the wholesale shop (no ns-retail session there).
  if (existing.shopifyDiscountId) {
    const r = await setShopifyDiscountActive({
      shop: shop || existing.shop,
      discountId: existing.shopifyDiscountId,
      active: status === "active",
    });
    if (!r.ok) {
      throw new Error(
        r.error ||
          "Could not update the discount on the store. Please try again.",
      );
    }
  }

  existing.status = status;
  existing.updatedBy = actor || "system";
  await existing.save();
  return existing.toObject();
}

export async function deletePractitionerCode({ practitionerId, codeId }) {
  if (!isValidObjectId(practitionerId)) {
    throw new Error("Invalid practitioner id");
  }
  if (!isValidObjectId(codeId)) throw new Error("Invalid code id");
  await connectDB();
  const result = await CdoPractitionerCode.deleteOne({
    _id: codeId,
    practitionerId,
  });
  if (result.deletedCount === 0) {
    throw new Error("Referral code not found");
  }
  return { deleted: true };
}

export async function setPrimaryPractitionerCode({
  practitionerId,
  codeId,
  actor,
}) {
  if (!isValidObjectId(practitionerId)) {
    throw new Error("Invalid practitioner id");
  }
  if (!isValidObjectId(codeId)) throw new Error("Invalid code id");
  await connectDB();

  const target = await CdoPractitionerCode.findOne({
    _id: codeId,
    practitionerId,
  });
  if (!target) throw new Error("Referral code not found");
  if (target.status !== "active") {
    throw new Error("Only active codes can be set as primary");
  }

  // Two-step swap — clear other primaries first, then set this one.
  // Order matters because of the partial unique (practitionerId, isPrimary)
  // index: a concurrent reader between the two updates would see no
  // primary momentarily, which is preferable to seeing two.
  await CdoPractitionerCode.updateMany(
    { practitionerId, isPrimary: true, _id: { $ne: codeId } },
    { $set: { isPrimary: false, updatedBy: actor || "system" } },
  );
  target.isPrimary = true;
  target.updatedBy = actor || "system";
  await target.save();
  return target.toObject();
}

// ── Customer applications + referral-code mapping ────────────────────
//
// Customers (Retailer + Patient) live in `cdo_applications`. When a
// customer applies with a referral code, the code is validated against
// the practitioner-owned `cdo_practitioner_codes` catalogue and the
// resolved practitioner + discount is snapshotted onto the customer
// record (`referral`). This is the practitioner↔customer link the
// program tracks. Customers without a code carry `referral: null` and
// get no discount.

const CUSTOMER_TYPES = ["retailer", "patient"];

// Resolve a raw referral code to its owning practitioner + discount.
// Returns { valid:false, reason } when the code is unknown / not active,
// otherwise the full mapping the registration flow snapshots onto the
// customer. Validates the practitioner still exists in the collection
// named by the code's `practitionerSource`.
//
// `opts.shop` scopes the lookup to one shop — pass it from the customer's
// registration context so a code only resolves within its own shop,
// matching the { shop, code } uniqueness index. Omit it for single-tenant
// callers (the lookup then ignores shop).
export async function validateReferralCode(rawCode, { shop } = {}) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) return { valid: false, reason: "empty" };
  await connectDB();

  const codeQuery = { code };
  if (shop !== undefined) codeQuery.shop = shop;
  const codeDoc = await CdoPractitionerCode.findOne(codeQuery).lean();
  if (!codeDoc) return { valid: false, reason: "not_found", code };
  if (codeDoc.status !== "active") {
    return { valid: false, reason: "inactive", code, status: codeDoc.status };
  }

  // Confirm the code points at a still-ELIGIBLE practitioner — not just
  // an existing document. We re-apply the same eligibility gate the rest
  // of the service uses (PRACTITIONER_FILTER for wholesale practitioners:
  // approved + resells) so a code owned by a rejected / revoked /
  // non-reselling applicant stops granting a discount. Without this, a
  // code could outlive its owner's practitioner status.
  const source = codeDoc.practitionerSource || "wholesale";
  const Model = source === "cdo" ? CdoApplication : WholesaleApplication;
  const eligibility = source === "cdo" ? { status: "approved" } : PRACTITIONER_FILTER;
  const practitioner = isValidObjectId(codeDoc.practitionerId)
    ? await Model.findOne({ _id: codeDoc.practitionerId, ...eligibility })
        .select("firstName lastName email status")
        .lean()
    : null;
  if (!practitioner) {
    // Either the record is gone or it no longer qualifies as a practitioner.
    return { valid: false, reason: "practitioner_ineligible", code };
  }

  // Discount the customer becomes eligible for; commissionRate falls
  // back to the program default so callers always have a usable number.
  const settings = await getSettings();
  const discountPercent = codeDoc.discountPercent ?? 0;
  const commissionRate =
    codeDoc.commissionRate != null
      ? codeDoc.commissionRate
      : settings.defaultCommissionRate;

  return {
    valid: true,
    code: codeDoc.code,
    codeId: codeDoc._id.toString(),
    practitionerId: codeDoc.practitionerId,
    practitionerSource: source,
    practitionerName:
      codeDoc.practitionerName ||
      `${practitioner.firstName || ""} ${practitioner.lastName || ""}`.trim() ||
      practitioner.email ||
      "—",
    practitionerEmail: (practitioner.email || codeDoc.practitionerEmail || "").toLowerCase(),
    discountPercent,
    commissionRate,
  };
}

// Build the immutable `referral` snapshot stored on a cdo_applications
// record at submit time. `null` when no (valid) code was supplied — the
// caller can decide whether an invalid code is a hard error or a silent
// "no discount" depending on the registration UX. Pass `opts.shop` to
// scope the code lookup to the customer's shop (multi-tenant safe).
export async function buildReferralSnapshot(rawCode, { when, shop } = {}) {
  if (!rawCode) return null;
  const result = await validateReferralCode(rawCode, { shop });
  if (!result.valid) return null;
  return {
    code: result.code,
    codeId: result.codeId,
    practitionerId: result.practitionerId,
    practitionerSource: result.practitionerSource,
    practitionerName: result.practitionerName,
    practitionerEmail: result.practitionerEmail,
    discountPercent: result.discountPercent,
    commissionRate: result.commissionRate,
    linkedAt: when || new Date(),
  };
}

// ── Permanent patient ↔ practitioner binding ─────────────────────────
//
// Once a patient (identified by email and/or Shopify customer id) is
// attributed to a practitioner, that relationship is PERMANENT: the patient
// may afterwards only use referral codes that belong to the SAME
// practitioner. The binding is read from two places, in priority order:
//   1. cdo_applications.referral.practitionerId — the registration /
//      first-touch snapshot (the canonical mapping; one per customer).
//   2. cdo_referrals.practitionerId (by referredEmail) — the referral
//      lifecycle row, kept as a fallback for link / checkout-only
//      attributions that never created an application.
// A practitioner may rotate or hold several codes, so the binding is by
// PRACTITIONER, not by code — different codes from the bound practitioner
// are always allowed; only a different practitioner is blocked.
export async function resolvePatientPractitioner({ email, customerId } = {}) {
  const e = String(email || "").trim().toLowerCase();
  const cid = String(customerId || "").trim();
  if (!e && !cid) return null;
  await connectDB();

  // 1. PRIMARY — the customer's cdo_applications referral snapshot. Match on
  //    email OR customerId (different ingest paths populate one or the other).
  const or = [];
  if (e) or.push({ email: e });
  if (cid) or.push({ customerId: cid });
  const app = await CdoApplication.findOne({
    $or: or,
    status: { $ne: "rejected" },
    "referral.practitionerId": { $ne: null },
  })
    .select("referral email")
    .lean();
  if (app?.referral?.practitionerId) {
    return {
      practitionerId: String(app.referral.practitionerId),
      practitionerName: app.referral.practitionerName || null,
      practitionerEmail: (app.referral.practitionerEmail || "").toLowerCase() || null,
      code: app.referral.code || null,
      source: "cdo_application",
    };
  }

  // 2. FALLBACK — earliest cdo_referrals row for this email wins (the FIRST
  //    attribution is the permanent one).
  const refEmail = e || app?.email;
  if (refEmail) {
    const ref = await CdoReferral.findOne({
      referredEmail: refEmail,
      practitionerId: { $ne: null },
    })
      .sort({ createdAt: 1 })
      .select("practitionerId practitionerName practitionerEmail referralCode")
      .lean();
    if (ref?.practitionerId) {
      return {
        practitionerId: String(ref.practitionerId),
        practitionerName: ref.practitionerName || null,
        practitionerEmail: (ref.practitionerEmail || "").toLowerCase() || null,
        code: ref.referralCode || null,
        source: "cdo_referral",
      };
    }
  }
  return null;
}

// Decide whether a candidate code's practitioner is allowed for this patient,
// honoring the permanent binding. `practitionerId` is the practitioner the
// candidate code resolves to. Returns:
//   { ok: true,  firstTime: true,  boundPractitionerId: null }      — no binding yet
//   { ok: true,  firstTime: false, boundPractitionerId }            — same practitioner
//   { ok: false, reason: "bound_other", boundPractitionerId, boundPractitionerName }
export async function checkPatientBinding({ email, customerId, practitionerId } = {}) {
  const binding = await resolvePatientPractitioner({ email, customerId });
  if (!binding) return { ok: true, firstTime: true, boundPractitionerId: null };
  if (String(binding.practitionerId) === String(practitionerId || "")) {
    return {
      ok: true,
      firstTime: false,
      boundPractitionerId: binding.practitionerId,
    };
  }
  return {
    ok: false,
    reason: "bound_other",
    boundPractitionerId: binding.practitionerId,
    boundPractitionerName: binding.practitionerName,
  };
}

// List customer applications, optionally scoped by applicant type. Used
// by the (future) CDO customer-applications admin screens + by tests
// validating the referral / non-referral seed scenarios.
export async function listCustomerApplications({ type } = {}) {
  await connectDB();
  const filter = {};
  if (type && CUSTOMER_TYPES.includes(type)) filter.applicantType = type;
  const rows = await CdoApplication.find(filter)
    .sort({ submittedAt: -1 })
    .lean();
  return rows.map((r) => ({
    id: r._id.toString(),
    applicantType: r.applicantType || null,
    firstName: r.firstName || "",
    lastName: r.lastName || "",
    name: `${r.firstName || ""} ${r.lastName || ""}`.trim(),
    email: (r.email || "").toLowerCase(),
    businessName: r.businessName || "",
    status: r.status || "pending",
    submittedAt: r.submittedAt || null,
    referral: r.referral || null,
    discountPercent: r.referral?.discountPercent ?? 0,
  }));
}

// Customers referred by a given practitioner — the reverse of the
// referral mapping (practitioner → their referred customers).
export async function listCustomersForPractitioner(practitionerId) {
  if (!isValidObjectId(practitionerId)) return [];
  await connectDB();
  const rows = await CdoApplication.find({
    "referral.practitionerId": practitionerId,
  })
    .sort({ submittedAt: -1 })
    .lean();
  return rows.map((r) => ({
    id: r._id.toString(),
    applicantType: r.applicantType || null,
    name: `${r.firstName || ""} ${r.lastName || ""}`.trim(),
    email: (r.email || "").toLowerCase(),
    referralCode: r.referral?.code || null,
    discountPercent: r.referral?.discountPercent ?? 0,
    submittedAt: r.submittedAt || null,
  }));
}

// ── Per-practitioner aggregations (Statistics + tab loaders) ─────────

// Headline KPIs for the practitioner detail Details/Statistics card.
// `dateFrom` / `dateTo` are optional Date objects that scope the
// revenue + commissions counts; null = all-time.
export async function getPractitionerKpis(practitionerId, { dateFrom, dateTo } = {}) {
  const profile = await getPractitionerProfile(practitionerId);
  if (!profile) return null;
  await connectDB();

  const match = practitionerMatch(profile);
  const orderMatch = { ...match };
  const commissionMatch = { ...match };
  const referralMatch = { ...match };
  if (dateFrom || dateTo) {
    const range = {};
    if (dateFrom) range.$gte = dateFrom;
    if (dateTo) range.$lte = dateTo;
    orderMatch.placedAt = range;
    commissionMatch.earnedAt = range;
    referralMatch.referredAt = range;
  }

  const settings = await getSettings();
  const minAmount = Number(settings.minimumPayoutAmount) || 0;

  const [
    orderAgg,
    commissionAgg,
    commissionByStatus,
    lifetimeOrderAgg,
    pendingPayouts,
    paidPayouts,
    totalReferrals,
    convertedReferrals,
    codeCount,
    referredCustomers,
    lastPaidPayout,
    eligible,
  ] = await Promise.all([
    CdoOrder.aggregate([
      { $match: orderMatch },
      {
        $group: {
          _id: null,
          revenue: { $sum: "$amount" },
          commissionFromOrders: { $sum: "$commissionAmount" },
          orders: { $sum: 1 },
        },
      },
    ]),
    CdoCommission.aggregate([
      { $match: commissionMatch },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    // All-time commission totals by status (not date-scoped) for the
    // earned / paid / pending summary.
    CdoCommission.aggregate([
      { $match: match },
      { $group: { _id: "$status", total: { $sum: "$amount" } } },
    ]),
    // Lifetime referral orders + revenue (all-time, ignores the date chip).
    CdoOrder.aggregate([
      { $match: match },
      { $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: "$amount" } } },
    ]),
    // Open (not-yet-settled) payouts — awaiting_approval/approved/processing.
    CdoPayout.aggregate([
      { $match: { ...match, status: { $in: ["awaiting_approval", "approved", "processing"] } } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    CdoPayout.aggregate([
      { $match: { ...match, status: "paid" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    CdoReferral.countDocuments(referralMatch),
    CdoReferral.countDocuments({ ...referralMatch, status: "converted" }),
    CdoPractitionerCode.countDocuments({ practitionerId: profile.id }),
    CdoApplication.countDocuments({ "referral.practitionerId": profile.id }),
    CdoPayout.findOne({ ...match, status: "paid" }).sort({ paidAt: -1 }).select("paidAt").lean(),
    getEligibleCommissions({ practitionerId: profile.id, periodEnd: new Date() }),
  ]);

  const orderRow = orderAgg[0] || { revenue: 0, commissionFromOrders: 0, orders: 0 };
  const conversionRate =
    totalReferrals > 0 ? convertedReferrals / totalReferrals : 0;

  // Commission status rollup (all-time).
  const byStatus = { pending: 0, approved: 0, paid: 0, reversed: 0 };
  for (const r of commissionByStatus) {
    if (r._id in byStatus) byStatus[r._id] = roundMoney(r.total);
  }
  const totalCommissionEarned = roundMoney(byStatus.pending + byStatus.approved + byStatus.paid);
  const totalCommissionPaid = byStatus.paid;
  const pendingCommissions = roundMoney(byStatus.pending + byStatus.approved);

  // This practitioner's next-cycle payout (eligible total, gated by minimum).
  const eligibleTotal = roundMoney(
    (eligible || []).reduce((s, c) => s + (Number(c.amount) || 0), 0),
  );
  const upcomingPayoutAmount = eligibleTotal >= minAmount ? eligibleTotal : 0;

  const lifetime = lifetimeOrderAgg[0] || { orders: 0, revenue: 0 };

  return {
    totalOrders: orderRow.orders || 0,
    totalRevenue: orderRow.revenue || 0,
    totalCommissions: commissionAgg[0]?.total || 0,
    pendingPayout: pendingPayouts[0]?.total || 0,
    paidPayout: paidPayouts[0]?.total || 0,
    totalReferrals,
    convertedReferrals,
    conversionRate,
    activeCodes: codeCount,
    // ── Commission summary (all-time) ──
    totalCommissionEarned,
    totalCommissionPaid,
    pendingCommissions,
    // ── Referral footprint ──
    referredCustomers,
    totalReferralOrders: lifetime.orders || 0,
    lifetimeReferralRevenue: roundMoney(lifetime.revenue || 0),
    // ── Payout cadence ──
    lastPayoutDate: lastPaidPayout?.paidAt || null,
    upcomingPayoutAmount,
    nextExpectedPayoutAmount: upcomingPayoutAmount,
    nextPayoutDate: nextPayoutDate(),
    minimumPayoutAmount: minAmount,
  };
}

// Shared filter so the tab loaders below all scope to one practitioner.
async function practitionerScopedQuery(practitionerId, Model, opts = {}) {
  const profile = await getPractitionerProfile(practitionerId);
  if (!profile) return { profile: null, rows: [] };
  await connectDB();
  const match = practitionerMatch(profile);
  let cursor = Model.find(match).sort(opts.sort || { createdAt: -1 });
  if (opts.limit) cursor = cursor.limit(opts.limit);
  const rows = await cursor.lean();
  return { profile, rows };
}

export async function listPractitionerOrders(practitionerId) {
  const { profile, rows } = await practitionerScopedQuery(
    practitionerId,
    CdoOrder,
    { sort: { placedAt: -1, createdAt: -1 } },
  );
  if (!profile) return [];
  return rows.map((r) => ({
    id: r._id.toString(),
    orderName: r.orderName || r.orderNumber || r.shopifyOrderId || "—",
    customerName: r.customerName || r.customerEmail || "—",
    amount: r.amount || 0,
    commissionAmount: r.commissionAmount || 0,
    currency: r.currency || "USD",
    status: r.status || "pending",
    placedAt: r.placedAt || r.createdAt || null,
    referralCode: r.referralCode || null,
  }));
}

export async function listPractitionerCommissions(practitionerId) {
  const { profile, rows } = await practitionerScopedQuery(
    practitionerId,
    CdoCommission,
    { sort: { earnedAt: -1, createdAt: -1 } },
  );
  if (!profile) return [];
  return rows.map((r) => ({
    id: r._id.toString(),
    orderName: r.orderName || "—",
    amount: r.amount || 0,
    rate: r.rate || 0,
    currency: r.currency || "USD",
    status: r.status || "pending",
    earnedAt: r.earnedAt || r.createdAt || null,
  }));
}

export async function listPractitionerPayouts(practitionerId) {
  const { profile, rows } = await practitionerScopedQuery(
    practitionerId,
    CdoPayout,
    { sort: { createdAt: -1 } },
  );
  if (!profile) return [];
  return rows.map((r) => ({
    id: r._id.toString(),
    amount: r.amount || 0,
    currency: r.currency || "USD",
    method: r.method || "manual",
    status: r.status || "pending",
    periodStart: r.periodStart || null,
    periodEnd: r.periodEnd || null,
    reference: r.reference || "",
    paidAt: r.paidAt || null,
    commissionCount: Array.isArray(r.commissionIds) ? r.commissionIds.length : 0,
    qboBillId: r.qboBillId || null,
    qboBillUrl: r.qboBillId ? billWebUrl(r.qboBillId) : null,
    lastError: r.lastError || null,
  }));
}

export async function listPractitionerReferrals(practitionerId) {
  const { profile, rows } = await practitionerScopedQuery(
    practitionerId,
    CdoReferral,
    { sort: { referredAt: -1, createdAt: -1 } },
  );
  if (!profile) return [];
  return rows.map((r) => ({
    id: r._id.toString(),
    referredName: r.referredName || r.referredEmail || "—",
    referredEmail: r.referredEmail || "",
    referralCode: r.referralCode || "—",
    status: r.status || "pending",
    referredAt: r.referredAt || r.createdAt || null,
    convertedAt: r.convertedAt || null,
  }));
}

export async function listPractitionerTransactions(practitionerId) {
  const { profile, rows } = await practitionerScopedQuery(
    practitionerId,
    CdoTransaction,
    { sort: { occurredAt: -1, createdAt: -1 } },
  );
  if (!profile) return [];
  return rows.map((r) => ({
    id: r._id.toString(),
    type: r.type || "—",
    amount: r.amount || 0,
    currency: r.currency || "USD",
    balanceAfter: r.balanceAfter ?? null,
    description: r.description || "",
    occurredAt: r.occurredAt || r.createdAt || null,
  }));
}

// ── Commission payout engine (accrual → batch → approve → execute) ───
//
// Lifecycle:
//   cdo_orders ──accrueCommissionsForOrders──▶ cdo_commissions
//   approved commissions ──buildPayoutBatch──▶ cdo_payouts(awaiting_approval)
//   admin ──approvePayout──▶ approved ──executeApprovedPayout──▶
//     QBO findOrCreateVendor → createBill → createBillPayment
//     → commissions(paid) + cdo_transactions(ledger) + status(paid)
//
// Every write is idempotent / safely retryable: commissions are reserved
// via `payoutId`, QBO writes carry stable `requestid`s, and each step is
// guarded by the presence of its result id on the payout.

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Append a running-balance ledger entry for a practitioner. Balance is
// derived from the most recent prior entry (chronological append model —
// fine for the CRON / admin single-writer flow).
async function appendLedgerEntry({
  shop,
  practitionerId,
  practitionerEmail,
  practitionerName,
  currency,
  type,
  amount,
  relatedType,
  relatedId,
  description,
  occurredAt,
}) {
  const last = await CdoTransaction.findOne({ practitionerId })
    .sort({ occurredAt: -1, createdAt: -1 })
    .lean();
  const prev = last?.balanceAfter ?? 0;
  const balanceAfter = roundMoney(prev + amount);
  return CdoTransaction.create({
    shop,
    practitionerId,
    practitionerEmail,
    practitionerName,
    type,
    currency: currency || "USD",
    amount: roundMoney(amount),
    balanceAfter,
    relatedType,
    relatedId,
    description,
    occurredAt: occurredAt || new Date(),
  });
}

function pushPayoutRemark(payout, { kind, message, actor, source }) {
  payout.remarks.push({
    kind,
    message,
    actor: actor || "system",
    source: source || "system",
    createdAt: new Date(),
  });
}

// ── Commission banking (payout destination) ──────────────────────────
//
// The practitioner's payout bank details live on the canonical
// `wholesale_applications.commission` object (written by the wholesale
// workspace) — the single source of truth. The payout process reads them
// fresh at execution time (never caches them) so it always uses the LATEST
// banking on file, validates them, and snapshots a MASKED copy onto the
// payout for audit/reconciliation. The full account number is used only
// transiently by the disbursement step and is never persisted or logged.

const VALID_ACCOUNT_TYPES = new Set(["checking", "savings"]);

function maskAccountLast4(num) {
  const s = String(num || "").replace(/\D/g, "");
  return s ? s.slice(-4) : "";
}

// US ABA routing number — 9 digits with the standard mod-10 checksum.
function isValidRoutingNumber(raw) {
  const s = String(raw || "").replace(/\D/g, "");
  if (!/^\d{9}$/.test(s)) return false;
  const d = s.split("").map(Number);
  const sum =
    3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
  return sum % 10 === 0;
}

// Fetch + validate a practitioner's commission banking from
// wholesale_applications.commission. Returns { ok, details, errors }.
//   • details.accountNumber is the FULL number — transient use only; callers
//     must persist only the masked snapshot (see executeApprovedPayout).
//   • errors is a list of human-readable reasons when ok:false.
export async function resolvePractitionerBanking(practitionerId) {
  await connectDB();
  if (!isValidObjectId(practitionerId)) {
    return { ok: false, details: null, errors: ["invalid practitioner id"] };
  }
  const row = await WholesaleApplication.findOne({
    _id: practitionerId,
    ...PRACTITIONER_FILTER,
  })
    .select("commission")
    .lean();
  if (!row) {
    return { ok: false, details: null, errors: ["practitioner not found or not approved"] };
  }

  const c = row.commission || null;
  if (!c) return { ok: false, details: null, errors: ["no commission banking on file"] };

  const errors = [];
  if (c.enabled === false) errors.push("commission payouts not enabled");

  const accountName = String(c.bankAccountName || "").trim();
  const routing = String(c.bankRoutingNumber || "").replace(/\D/g, "");
  const account = String(c.bankAccountNumber || "").replace(/\D/g, "");
  const type = String(c.bankAccountType || "").trim();

  if (!accountName) errors.push("missing bank account name");
  if (!routing) errors.push("missing routing number");
  else if (!isValidRoutingNumber(routing)) errors.push("invalid routing number");
  if (!account) errors.push("missing account number");
  else if (!/^\d{4,17}$/.test(account)) errors.push("invalid account number");
  if (!type) errors.push("missing account type");
  else if (!VALID_ACCOUNT_TYPES.has(type.toLowerCase())) {
    errors.push(`unsupported account type "${type}"`);
  }

  if (errors.length) return { ok: false, details: null, errors };

  return {
    ok: true,
    errors: [],
    details: {
      accountName,
      routingNumber: routing,
      accountNumber: account, // FULL — transient use only, never persisted/logged
      accountLast4: String(c.bankAccountLast4 || "") || maskAccountLast4(account),
      accountType: type,
      sourcedFromPaymentAch: !!c.sourcedFromPaymentAch,
      updatedAt: c.updatedAt || null,
    },
  };
}

// ── Phase 2: commission accrual + eligibility ────────────────────────

// Create the cdo_commission + ledger credit for a single attributed order.
// Idempotent + the SINGLE writer of commissions for an order — used by
// both the live order-ingestion pipeline (ingestShopifyOrder) and the
// batch accrual (accrueCommissionsForOrders). Returns { created, commission }:
//   • skips (created:false, commission:null) when commissionAmount <= 0
//   • skips (created:false, commission:<existing>) when a commission for
//     this orderId already exists
// Rate prefers the order's snapshotted referral.commissionRate, falling
// back to commissionAmount/amount, then the program default. Status follows
// cdo_settings.autoApproveCommissions.
async function createCommissionForOrder(order, settings) {
  const amount = roundMoney(order.commissionAmount);
  if (amount <= 0) return { created: false, commission: null };

  const existing = await CdoCommission.findOne({ orderId: order._id }).lean();
  if (existing) return { created: false, commission: existing };

  const autoApprove = settings.autoApproveCommissions === true;
  // Prefer the order's blended effective rate from the vendor-driven commission
  // snapshot; fall back to the legacy referral rate / derived rate for orders
  // ingested before per-vendor commissions existed.
  const effectiveRate = order.commissionSnapshot?.effectiveRate;
  const snapshotRate = order.referral?.commissionRate;
  const rate = Number.isFinite(effectiveRate)
    ? effectiveRate
    : Number.isFinite(snapshotRate)
      ? snapshotRate
      : Number(order.amount) > 0
        ? Number((amount / Number(order.amount)).toFixed(4))
        : settings.defaultCommissionRate;
  const earnedAt = order.placedAt || order.createdAt || new Date();

  const commission = await CdoCommission.create({
    shop: order.shop,
    practitionerId: order.practitionerId,
    practitionerEmail: order.practitionerEmail,
    practitionerName: order.practitionerName,
    orderId: order._id,
    orderName: order.orderName,
    currency: order.currency || settings.currency,
    amount,
    rate,
    status: autoApprove ? "approved" : "pending",
    earnedAt,
  });
  await appendLedgerEntry({
    shop: order.shop,
    practitionerId: order.practitionerId,
    practitionerEmail: order.practitionerEmail,
    practitionerName: order.practitionerName,
    currency: order.currency || settings.currency,
    type: "commission",
    amount,
    relatedType: "CdoCommission",
    relatedId: commission._id,
    description: `Commission earned on ${order.orderName || order.shopifyOrderId || "order"}`,
    occurredAt: earnedAt,
  });
  return { created: true, commission };
}

// Generate cdo_commissions for attributed orders that don't have one yet.
// Idempotent: delegates to createCommissionForOrder, which skips orders
// that already have a linked commission and orders with no commission.
// Status follows cdo_settings.autoApproveCommissions.
export async function accrueCommissionsForOrders({ shop } = {}) {
  await connectDB();
  const settings = await getSettings();

  // Commissions accrue only for PAID orders (never unpaid / cancelled /
  // refunded). Legacy/seeded orders without a financialStatus snapshot fall
  // back to the CDO order status === "paid".
  const orderFilter = {
    status: { $ne: "cancelled" },
    commissionAmount: { $gt: 0 },
    $or: [
      { financialStatus: "paid" },
      { financialStatus: { $in: [null, undefined] }, status: "paid" },
    ],
  };
  if (shop) orderFilter.shop = shop;
  const orders = await CdoOrder.find(orderFilter).lean();

  let createdCount = 0;
  for (const o of orders) {
    const { created } = await createCommissionForOrder(o, settings);
    if (created) createdCount += 1;
  }
  return { createdCount, autoApprove: settings.autoApproveCommissions === true };
}

export async function approveCommission(commissionId) {
  if (!isValidObjectId(commissionId)) throw new Error("Invalid commission id");
  await connectDB();
  const c = await CdoCommission.findById(commissionId);
  if (!c) throw new Error("Commission not found");
  if (c.status === "paid") throw new Error("Cannot approve a paid commission");
  c.status = "approved";
  await c.save();
  return c.toObject();
}

export async function reverseCommission(commissionId) {
  if (!isValidObjectId(commissionId)) throw new Error("Invalid commission id");
  await connectDB();
  const c = await CdoCommission.findById(commissionId);
  if (!c) throw new Error("Commission not found");
  if (c.status === "paid" || c.payoutId) {
    throw new Error("Cannot reverse a commission that is paid or attached to a payout");
  }
  c.status = "reversed";
  c.payoutStatus = "cancelled";
  await c.save();
  return c.toObject();
}

// Approved, not-yet-paid, not-yet-batched commissions earned on/before
// the period end. The batch builder applies the per-practitioner minimum.
export async function getEligibleCommissions({ practitionerId, periodEnd } = {}) {
  await connectDB();
  // Eligibility excludes individually-paused commissions and any
  // commission owned by a practitioner whose payouts are on hold.
  const filter = { status: "approved", payoutId: null, paused: { $ne: true } };
  if (practitionerId) {
    if (await isPractitionerPaused(practitionerId)) return [];
    filter.practitionerId = practitionerId;
  } else {
    const held = await getHeldPractitionerIds();
    if (held.length) filter.practitionerId = { $nin: held };
  }
  if (periodEnd) filter.earnedAt = { $lte: new Date(periodEnd) };
  return CdoCommission.find(filter).sort({ earnedAt: 1 }).lean();
}

// ── Phase 3: payout batch + approval workflow ────────────────────────

// Aggregate eligible commissions per practitioner into awaiting_approval
// payouts. Reserves the commissions (sets payoutId) so a second run won't
// double-batch them. Skips practitioners below the minimum payout amount
// or who already have an open payout for the period.
export async function buildPayoutBatch({ periodStart, periodEnd, practitionerId, actor } = {}) {
  await connectDB();
  const settings = await getSettings();
  const minAmount = Number(settings.minimumPayoutAmount) || 0;
  const periodEndDate = periodEnd ? new Date(periodEnd) : new Date();
  const periodStartDate = periodStart ? new Date(periodStart) : null;

  const eligible = await getEligibleCommissions({
    practitionerId,
    periodEnd: periodEndDate,
  });

  // Group by practitioner.
  const groups = new Map();
  for (const c of eligible) {
    const key = c.practitionerId;
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  const created = [];
  const skipped = [];
  for (const [pid, commissions] of groups.entries()) {
    const total = roundMoney(commissions.reduce((s, c) => s + (Number(c.amount) || 0), 0));
    if (total < minAmount) {
      skipped.push({ practitionerId: pid, total, reason: "below_minimum", minAmount });
      continue;
    }

    // Idempotency: don't open a second payout for the same practitioner +
    // period while one is still in flight.
    const open = await CdoPayout.findOne({
      practitionerId: pid,
      periodEnd: periodEndDate,
      status: { $in: ["draft", "awaiting_approval", "approved", "processing"] },
    }).lean();
    if (open) {
      skipped.push({ practitionerId: pid, total, reason: "open_payout_exists" });
      continue;
    }

    const first = commissions[0];
    const reference = `CDO-${periodEndDate.toISOString().slice(0, 7).replace("-", "")}-${String(pid).slice(-6)}`;
    const payout = new CdoPayout({
      shop: first.shop,
      practitionerId: pid,
      practitionerSource: "wholesale",
      practitionerEmail: first.practitionerEmail,
      practitionerName: first.practitionerName,
      currency: first.currency || settings.currency,
      amount: total,
      method: "ach",
      status: "awaiting_approval",
      commissionIds: commissions.map((c) => c._id),
      periodStart: periodStartDate,
      periodEnd: periodEndDate,
      reference,
    });
    pushPayoutRemark(payout, {
      kind: "batch_created",
      message: `Batched ${commissions.length} commission(s) totalling ${total} ${payout.currency}`,
      actor,
      source: actor ? "admin" : "system",
    });
    await payout.save();

    // Reserve the commissions so they aren't batched again.
    await CdoCommission.updateMany(
      { _id: { $in: payout.commissionIds } },
      { $set: { payoutId: payout._id } },
    );

    created.push(payout.toObject());
  }

  return { created, skipped, minAmount, periodEnd: periodEndDate };
}

export async function approvePayout(payoutId, actor) {
  if (!isValidObjectId(payoutId)) throw new Error("Invalid payout id");
  await connectDB();
  const payout = await CdoPayout.findById(payoutId);
  if (!payout) throw new Error("Payout not found");
  if (!["draft", "awaiting_approval"].includes(payout.status)) {
    throw new Error(`Cannot approve a payout in status "${payout.status}"`);
  }
  payout.status = "approved";
  payout.approvedBy = actor || "admin";
  payout.approvedAt = new Date();
  pushPayoutRemark(payout, {
    kind: "approved",
    message: "Payout approved for execution",
    actor,
    source: "admin",
  });
  await payout.save();
  return payout.toObject();
}

export async function rejectPayout(payoutId, actor, reason) {
  if (!isValidObjectId(payoutId)) throw new Error("Invalid payout id");
  await connectDB();
  const payout = await CdoPayout.findById(payoutId);
  if (!payout) throw new Error("Payout not found");
  if (!["draft", "awaiting_approval", "approved"].includes(payout.status)) {
    throw new Error(`Cannot reject a payout in status "${payout.status}"`);
  }
  // Release the reserved commissions so they can be re-batched.
  await CdoCommission.updateMany(
    { _id: { $in: payout.commissionIds } },
    { $set: { payoutId: null } },
  );
  payout.status = "rejected";
  payout.rejectedBy = actor || "admin";
  payout.rejectedAt = new Date();
  payout.rejectionReason = reason || null;
  pushPayoutRemark(payout, {
    kind: "rejected",
    message: reason ? `Rejected: ${reason}` : "Payout rejected",
    actor,
    source: "admin",
  });
  await payout.save();
  return payout.toObject();
}

// Execute an approved payout against QBO: ensure Vendor → create Bill →
// record BillPayment → settle commissions + ledger. Each step is guarded
// by its result id on the payout, so a re-run after a mid-way failure
// resumes rather than duplicating. QBO writes use stable requestids.
export async function executeApprovedPayout(payoutId, { actor } = {}) {
  if (!isValidObjectId(payoutId)) throw new Error("Invalid payout id");
  await connectDB();
  const payout = await CdoPayout.findById(payoutId);
  if (!payout) throw new Error("Payout not found");
  if (!["approved", "processing", "failed"].includes(payout.status)) {
    throw new Error(`Cannot execute a payout in status "${payout.status}"`);
  }

  payout.status = "processing";
  payout.lastError = null;
  await payout.save();

  // ── Banking gate ── Fetch the practitioner's commission banking fresh from
  // wholesale_applications (canonical source, always the latest) and validate
  // it BEFORE any QBO write or disbursement. Missing/invalid banking flags the
  // payout (bankingError + bank_invalid remark) and aborts; once the
  // practitioner corrects their details, a re-run (manual "Execute" / reprocess
  // batch, or the next CRON) picks up the change and proceeds.
  const banking = await resolvePractitionerBanking(payout.practitionerId);
  if (!banking.ok) {
    payout.status = "failed";
    payout.bankingError = banking.errors.join("; ");
    payout.lastError = `Banking validation failed: ${payout.bankingError}`;
    pushPayoutRemark(payout, {
      kind: "bank_invalid",
      message: `Missing/invalid commission banking — ${payout.bankingError}`,
      actor,
      source: actor ? "admin" : "cron",
    });
    await payout.save();
    // Never log the account number — only the validation reasons.
    log.warn("payout.bank_invalid", {
      payoutId: String(payout._id),
      practitionerId: payout.practitionerId,
      errors: banking.errors,
    });
    throw new Error(payout.lastError);
  }

  // Snapshot the destination banking (MASKED — the full account number is
  // never persisted) for audit + reconciliation, recording exactly which
  // version of the banking (commission.updatedAt) this payout used.
  const bank = banking.details;
  payout.bankSnapshot = {
    accountName: bank.accountName,
    routingNumber: bank.routingNumber,
    accountLast4: bank.accountLast4,
    accountType: bank.accountType,
    sourcedFromPaymentAch: bank.sourcedFromPaymentAch,
    bankingUpdatedAt: bank.updatedAt,
    capturedAt: new Date(),
  };
  payout.bankingError = null;
  pushPayoutRemark(payout, {
    kind: "bank_validated",
    message: `Banking validated — ${bank.accountType} ••••${bank.accountLast4} (routing ${bank.routingNumber})`,
    actor,
    source: actor ? "admin" : "cron",
  });
  await payout.save();

  try {
    // 1) Vendor (find-or-create, cached in cdo_qbo_vendors).
    if (!payout.qboVendorId) {
      const profile = await getPractitionerProfile(payout.practitionerId);
      const { qboVendorId } = await findOrCreateVendor({
        practitionerId: payout.practitionerId,
        practitionerSource: payout.practitionerSource,
        displayName: profile?.name || payout.practitionerName,
        email: profile?.email || payout.practitionerEmail,
        firstName: profile?.firstName,
        lastName: profile?.lastName,
        companyName: profile?.businessName,
      });
      payout.qboVendorId = qboVendorId;
      await payout.save();
    }

    // 2) Bill (one expense line per commission).
    if (!payout.qboBillId) {
      const commissions = await CdoCommission.find({
        _id: { $in: payout.commissionIds },
      }).lean();
      const lines = commissions.map((c) => ({
        amount: c.amount,
        description: `Commission — ${c.orderName || "order"} (rate ${(Number(c.rate) * 100).toFixed(1)}%)`,
      }));
      const bill = await createBill({
        vendorId: payout.qboVendorId,
        lines,
        docNumber: payout.reference,
        privateNote:
          `CDO commission payout ${payout.reference} ` +
          `(period ending ${payout.periodEnd?.toISOString().slice(0, 10)}) — ` +
          `Destination: ${bank.accountName} · ${bank.accountType} ••••${bank.accountLast4} · routing ${bank.routingNumber}`,
        txnDate: new Date(),
        requestId: `cdo-bill-${payout._id}`,
      });
      payout.qboBillId = String(bill.Id);
      payout.billCreatedAt = new Date();
      pushPayoutRemark(payout, {
        kind: "bill_created",
        message: `QBO Bill ${bill.Id} created (${payout.amount} ${payout.currency})`,
        actor,
        source: actor ? "admin" : "cron",
      });
      await payout.save();
    }

    // 3) Initiate the real bank→bank transfer through the configured payout
    //    provider. The QBO Bill above records the LIABILITY; the QBO
    //    BillPayment + `paid` status are DEFERRED until the transfer SETTLES
    //    (confirmed asynchronously by checkPayoutSettlement). Idempotent per
    //    attempt: only initiate when there is no live transfer — none yet, or
    //    the prior one returned/failed (a retry gets a fresh idempotency key).
    if (!payout.providerTransferId || ["returned", "failed"].includes(payout.providerStatus)) {
      const provider = getPayoutProvider();
      const attempt = (payout.transferAttemptCount || 0) + 1;
      payout.transferAttemptCount = attempt;
      payout.transferInitiatedAt = new Date();
      payout.providerName = provider.name;

      const res = await provider.initiateTransfer({
        amount: payout.amount,
        currency: payout.currency,
        destination: {
          accountName: bank.accountName,
          routingNumber: bank.routingNumber,
          accountNumber: banking.details.accountNumber, // full — transient only, never persisted/logged
          accountType: bank.accountType,
        },
        idempotencyKey: `cdo-payout-${payout._id}-${attempt}`,
        reference: payout.reference,
        metadata: {
          practitionerId: payout.practitionerId,
          practitionerEmail: payout.practitionerEmail,
          practitionerName: payout.practitionerName,
          periodEnd: payout.periodEnd,
        },
      });

      if (res.status === "failed") {
        // Provider rejected the transfer up front (e.g. bad account). Capture
        // the reason; the catch below sets status=failed + remark + rethrows.
        payout.providerStatus = "failed";
        payout.returnCode = res.returnCode || null;
        payout.returnReason = res.returnReason || "Transfer rejected at initiation";
        throw new Error(`Transfer rejected at initiation: ${payout.returnReason}`);
      }

      payout.providerTransferId = res.transferId;
      payout.providerStatus = res.status || "pending";
      payout.returnCode = null;
      payout.returnReason = null;
      payout.returnedAt = null;
      pushPayoutRemark(payout, {
        kind: "transfer_initiated",
        message:
          `ACH transfer initiated via ${provider.name} — ${payout.amount} ${payout.currency} → ` +
          `${bank.accountType} ••••${bank.accountLast4} (transfer ${res.transferId})`,
        actor,
        source: actor ? "admin" : "cron",
      });
      await payout.save();
    }

    // 4) Funds are in flight. Settlement (QBO BillPayment + commissions paid +
    //    ledger debit + `paid`) is confirmed asynchronously by the settlement
    //    poll (checkPayoutSettlement) — NOT here. ACH takes 1–3 business days
    //    and can still be returned, so we never claim `paid` at this point.
    payout.status = "awaiting_settlement";
    await payout.save();
    return payout.toObject();
  } catch (err) {
    payout.status = "failed";
    payout.lastError = err?.message || String(err);
    pushPayoutRemark(payout, {
      kind: "failed",
      message: `Execution failed: ${payout.lastError}`,
      actor,
      source: actor ? "admin" : "cron",
    });
    await payout.save();
    throw err;
  }
}

// ── Settlement (real-money confirmation) ─────────────────────────────
//
// A payout in `awaiting_settlement` has had its bank→bank transfer initiated
// but NOT yet confirmed. The settlement poll (process-payout-settlements CRON,
// or the admin "Sync settlement" button) calls checkPayoutSettlement, which
// asks the provider for the transfer's status and transitions the payout:
//   • settled  → record the QBO BillPayment, settle commissions + ledger, `paid`
//   • returned/failed → `failed` + capture the return code (R01 NSF, etc.);
//       commissions stay reserved to the payout so a retry re-disburses
//   • pending  → leave alone (normal 1–3 business-day ACH window)
//
// All money/state writes happen HERE on confirmed settlement — never at
// initiation — so the books, the commission, and the practitioner record only
// claim "paid" once funds have actually moved.

// Record the QBO BillPayment + settle commissions + ledger debit + mark paid.
// Only ever reached from a confirmed `settled` transfer. Each step is guarded
// so a retried finalize (e.g. ledger append crashed after BillPayment) never
// double-records.
async function finalizeSettledPayout(payout, { actor, source } = {}) {
  // 1) QBO BillPayment — records the disbursement now that funds have settled.
  if (!payout.qboBillPaymentId) {
    const payment = await createBillPayment({
      vendorId: payout.qboVendorId,
      billId: payout.qboBillId,
      amount: payout.amount,
      requestId: `cdo-pay-${payout._id}`,
    });
    payout.qboBillPaymentId = String(payment.Id);
    payout.paymentRecordedAt = new Date();
    pushPayoutRemark(payout, {
      kind: "payment_recorded",
      message: `QBO BillPayment ${payment.Id} recorded (transfer settled)`,
      actor,
      source: source || "cron",
    });
  }

  // 2) Settle the commissions.
  const settledAt = payout.settledAt || new Date();
  await CdoCommission.updateMany(
    { _id: { $in: payout.commissionIds } },
    {
      $set: {
        status: "paid",
        payoutId: payout._id,
        payoutStatus: "paid",
        payoutDate: settledAt,
        payoutTxnRef: payout.providerTransferId || payout.qboBillPaymentId || null,
        payoutFailureReason: null,
      },
    },
  );

  // 3) Ledger debit — idempotent: only append if this payout has no debit yet.
  const existingDebit = await CdoTransaction.findOne({
    relatedType: "CdoPayout",
    relatedId: payout._id,
    type: "payout",
  }).lean();
  if (!existingDebit) {
    await appendLedgerEntry({
      shop: payout.shop,
      practitionerId: payout.practitionerId,
      practitionerEmail: payout.practitionerEmail,
      practitionerName: payout.practitionerName,
      currency: payout.currency,
      type: "payout",
      amount: -roundMoney(payout.amount),
      relatedType: "CdoPayout",
      relatedId: payout._id,
      description: `Payout ${payout.reference} settled via ${payout.providerName || "provider"} (${payout.providerTransferId})`,
      occurredAt: settledAt,
    });
  }

  payout.status = "paid";
  payout.paidAt = settledAt;
  await payout.save();

  // Reflect the settled outcome back onto the batch snapshot(s) that processed
  // this payout (run-time items were recorded as "processing" because ACH is
  // async). Without this the batch view stays stuck on "Processing".
  await reflectPayoutOnBatches(payout, {
    itemStatus: "paid",
    txnRef: payout.providerTransferId || payout.qboBillPaymentId || null,
    payoutDate: settledAt,
  });
  return payout.toObject();
}

// Reflect a payout's TERMINAL outcome back onto the payout-batch snapshot(s)
// that processed it. Batch items are recorded at RUN time as "processing"
// (ACH settles asynchronously, later, via the settlement CRON — a different
// tick/process than the run), so without this the batch's per-commission
// outcome + Paid/Failed/Skipped counts would stay frozen on "processing" even
// after the payout settled or returned. Updates the matching items + recomputes
// the stored counts. Best-effort — never throws into the settlement path.
async function reflectPayoutOnBatches(payout, { itemStatus, txnRef = null, payoutDate = null } = {}) {
  try {
    const batches = await CdoPayoutBatch.find({ "items.payoutId": payout._id });
    for (const batch of batches) {
      let touched = false;
      for (const it of batch.items || []) {
        if (String(it.payoutId) === String(payout._id) && it.status !== itemStatus) {
          it.status = itemStatus;
          if (txnRef) it.txnRef = txnRef;
          if (payoutDate) it.payoutDate = payoutDate;
          if (itemStatus === "paid") it.failureReason = null;
          touched = true;
        }
      }
      if (!touched) continue;
      batch.successCount = batch.items.filter((i) => i.status === "paid").length;
      batch.failedCount = batch.items.filter((i) => i.status === "failed").length;
      batch.skippedCount = batch.items.filter((i) => i.status === "skipped").length;
      // A late return can introduce failures into a previously clean batch.
      if (["completed", "completed_with_errors"].includes(batch.status)) {
        batch.status = batch.failedCount > 0 ? "completed_with_errors" : "completed";
      }
      batch.markModified("items");
      await batch.save();
    }
  } catch (err) {
    log.warn("payout.batch_reflect_failed", {
      payoutId: String(payout._id),
      err: err?.message || String(err),
    });
  }
}

// Advance any provider-side transfers that require an explicit processing
// trigger before they can settle, so the settlement loop is fully automated
// with NO manual dashboard step. On real rails (production ACH) the provider's
// processPendingTransfers is a no-op — the banking network settles on its own.
// In TEST/sandbox it triggers the provider's batch processing (Dwolla Sandbox's
// `/sandbox/process-bank-transfers`). Best-effort + provider-optional: never
// throws into the settlement CRON. Called once per settlement tick BEFORE the
// per-payout poll, so the subsequent checkPayoutSettlement sees `processed`.
export async function advancePendingPayoutTransfers() {
  const provider = getPayoutProvider();
  if (typeof provider.processPendingTransfers !== "function") {
    return { advanced: false, skipped: true };
  }
  try {
    const res = (await provider.processPendingTransfers()) || { advanced: false };
    if (res.advanced) {
      log.info("payout.provider_transfers_advanced", { provider: provider.name });
    }
    return res;
  } catch (err) {
    log.warn("payout.advance_pending_failed", {
      provider: provider.name,
      err: err?.message || String(err),
    });
    return { advanced: false, error: err?.message || String(err) };
  }
}

// Poll the provider for one in-flight payout and apply the outcome. Safe to
// call repeatedly (the awaiting_settlement guard makes settle/return one-way).
// Returns { changed, status, reason? }. Shared by the CRON + the admin button.
export async function checkPayoutSettlement(payoutId, { actor = "system", source = "cron" } = {}) {
  if (!isValidObjectId(payoutId)) throw new Error("Invalid payout id");
  await connectDB();
  const payout = await CdoPayout.findById(payoutId);
  if (!payout) throw new Error("Payout not found");
  if (payout.status !== "awaiting_settlement") {
    return { changed: false, status: payout.status, reason: "not awaiting settlement" };
  }
  if (!payout.providerTransferId) {
    return { changed: false, status: payout.status, reason: "no transfer id on payout" };
  }

  const provider = getPayoutProvider();
  let res;
  try {
    res = await provider.getTransferStatus(payout.providerTransferId);
  } catch (err) {
    payout.settlementLastCheckedAt = new Date();
    await payout.save();
    log.warn("payout.settlement_check_failed", {
      payoutId: String(payout._id),
      err: err?.message || String(err),
    });
    return { changed: false, status: payout.status, reason: "provider lookup failed" };
  }

  payout.settlementLastCheckedAt = new Date();
  payout.providerStatus = res.status;

  if (res.status === "settled") {
    payout.settledAt = res.settledAt ? new Date(res.settledAt) : new Date();
    pushPayoutRemark(payout, {
      kind: "settled",
      message: `Transfer ${payout.providerTransferId} settled — funds confirmed`,
      actor,
      source,
    });
    await payout.save();
    await finalizeSettledPayout(payout, { actor, source });
    log.info("payout.settled", { payoutId: String(payout._id), transferId: payout.providerTransferId });
    return { changed: true, status: "paid" };
  }

  if (res.status === "returned" || res.status === "failed") {
    payout.status = "failed";
    payout.returnCode = res.returnCode || null;
    payout.returnReason =
      res.returnReason || (res.status === "returned" ? "ACH returned" : "Transfer failed");
    payout.returnedAt = new Date();
    payout.lastError =
      `Transfer ${res.status}: ${payout.returnReason}` +
      (payout.returnCode ? ` (${payout.returnCode})` : "");
    // Keep the commissions RESERVED to this payout (payoutId unchanged) but
    // flag them failed, so a retry (Execute) re-disburses the SAME payout once
    // the practitioner's banking is corrected — no re-batching, no double-pay.
    await CdoCommission.updateMany(
      { _id: { $in: payout.commissionIds } },
      { $set: { payoutStatus: "failed", payoutFailureReason: payout.lastError } },
    );
    pushPayoutRemark(payout, { kind: "returned", message: payout.lastError, actor, source });
    await payout.save();
    await reflectPayoutOnBatches(payout, { itemStatus: "failed" });
    await alertPayoutFailure(payout, new Error(payout.lastError));
    log.warn("payout.returned", {
      payoutId: String(payout._id),
      transferId: payout.providerTransferId,
      returnCode: payout.returnCode,
    });
    return { changed: true, status: "failed" };
  }

  // Still pending — normal ACH window. Leave the payout in awaiting_settlement.
  await payout.save();
  return { changed: false, status: "awaiting_settlement", reason: "pending" };
}

// In-flight payouts the settlement poll should reconcile.
export async function listPayoutsAwaitingSettlement() {
  await connectDB();
  return CdoPayout.find({
    status: "awaiting_settlement",
    providerTransferId: { $ne: null },
  })
    .select("_id reference practitionerEmail transferInitiatedAt")
    .lean();
}

// Full payout detail for the admin UI — the payout, its settled
// commissions, and a QBO deep link to the Bill.
export async function getPayoutDetail(payoutId) {
  if (!isValidObjectId(payoutId)) return null;
  await connectDB();
  const payout = await CdoPayout.findById(payoutId).lean();
  if (!payout) return null;
  const commissions = await CdoCommission.find({
    _id: { $in: payout.commissionIds || [] },
  }).lean();
  return {
    ...payout,
    id: payout._id.toString(),
    commissions: commissions.map((c) => ({
      id: c._id.toString(),
      orderName: c.orderName,
      amount: c.amount,
      rate: c.rate,
      status: c.status,
    })),
    qboBillUrl: payout.qboBillId ? billWebUrl(payout.qboBillId) : null,
  };
}

// ── Order ingestion (orders/create → cdo_orders) ─────────────────────
//
// The live pipeline behind the orders/create webhook. EVERY Shopify order
// is synchronized into cdo_orders with a complete snapshot. When the buyer
// used an eligible practitioner referral code, the order is ATTRIBUTED and
// the full referral → commission → ledger chain is created + linked:
//
//   resolve code ─▶ upsert cdo_orders ─▶ (if attributed) ─▶
//     upsert cdo_referrals (converted) ─▶ create cdo_commission + ledger ─▶
//     first-touch cdo_applications mapping
//
// All cdo_* writes live here (per the payout.md layering rule); the webhook
// route only handles auth/dedup + the Shopify-API customer tag.

// Parse a possibly-stringy money value to a finite Number (Shopify sends
// amounts as strings, e.g. "400.00").
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Resolve a raw referral code carried on an order to its owning
// practitioner + discount/commission terms. Case-insensitive (codes are
// stored canonical-lowercase) and applies the SAME eligibility gate as
// validateReferralCode — a code owned by a no-longer-eligible practitioner
// stops attributing. Returns the referral snapshot, or null.
export async function resolvePractitionerReferral(rawCode, { shop } = {}) {
  const code = String(rawCode || "").trim();
  if (!code) return null;
  await connectDB();

  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Codes are looked up CROSS-SHOP intentionally: the wholesale app creates
  // them (so `shop` on the doc = wholesale shop domain), and the ns-retail
  // app consumes them at order time (with `shop` = retail shop domain).
  // The two apps share the same MongoDB cdo_practitioner_codes collection;
  // the code value alone is globally unique by design (random 8-hex suffix).
  // The `shop` field on the schema is metadata only — never filter on it
  // here or attribution silently breaks for retail orders. The `shop`
  // parameter is kept for backwards compat but ignored.
  void shop; // eslint-disable-line no-unused-expressions
  const codeQuery = {
    code: { $regex: `^${escaped}$`, $options: "i" },
    status: "active",
  };
  const codeDoc = await CdoPractitionerCode.findOne(codeQuery).lean();
  if (!codeDoc) return null;

  const source = codeDoc.practitionerSource || "wholesale";
  const Model = source === "cdo" ? CdoApplication : WholesaleApplication;
  const eligibility = source === "cdo" ? { status: "approved" } : PRACTITIONER_FILTER;
  const practitioner = isValidObjectId(codeDoc.practitionerId)
    ? await Model.findOne({ _id: codeDoc.practitionerId, ...eligibility })
        .select("firstName lastName email status")
        .lean()
    : null;
  if (!practitioner) return null;

  const settings = await getSettings();
  return {
    code: codeDoc.code,
    codeId: codeDoc._id.toString(),
    practitionerId: codeDoc.practitionerId,
    practitionerSource: source,
    practitionerName:
      codeDoc.practitionerName ||
      `${practitioner.firstName || ""} ${practitioner.lastName || ""}`.trim() ||
      practitioner.email ||
      "—",
    practitionerEmail: (practitioner.email || codeDoc.practitionerEmail || "").toLowerCase(),
    discountPercent: codeDoc.discountPercent ?? 0,
    commissionRate:
      codeDoc.commissionRate != null
        ? codeDoc.commissionRate
        : settings.defaultCommissionRate,
    linkedAt: new Date(),
  };
}

// Extract the buyer email from an orders/create payload (lowercased).
function orderEmail(payload) {
  return String(
    payload?.email || payload?.contact_email || payload?.customer?.email || "",
  )
    .toLowerCase()
    .trim();
}

// Resolve the practitioner referral for an order, with cdo_applications as
// the PRIMARY source of truth and cdo_practitioner_codes as the catalogue
// fallback:
//
//   1. PRIMARY — the customer's established cdo_applications mapping. If the
//      buyer already has a (non-rejected) application carrying a `referral`,
//      that frozen snapshot IS the customer→practitioner relationship; use
//      it directly. The code is "valid + active" because the relationship
//      exists. (source: "cdo_application")
//   2. FALLBACK — first-touch. No mapping yet but the order carried a code
//      (note attribute / discount code / customer tag): validate it against
//      cdo_practitioner_codes (active + eligible practitioner) and let the
//      pipeline create the mapping. (source: the code-discovery source)
//   3. Neither → unattributed (standard retail order).
//
// Returns { referral, attributionSource } — referral is null for retail.
async function resolveOrderReferral({ shop, payload, rawCode, codeSource }) {
  // 1. PRIMARY: the customer's existing mapping in cdo_applications.
  const email = orderEmail(payload);
  const customerGid = payload?.customer?.admin_graphql_api_id || null;
  let app = null;
  if (email) app = await CdoApplication.findOne({ email }).lean();
  if (!app && customerGid) {
    app = await CdoApplication.findOne({ customerId: customerGid }).lean();
  }
  if (app && app.referral && app.referral.practitionerId && app.status !== "rejected") {
    const referral = { ...app.referral, linkedAt: app.referral.linkedAt || new Date() };

    // The customer→practitioner MAPPING is anchored to their application, but
    // commission/discount TERMS must reflect the practitioner's CURRENT code —
    // rate/discount edits apply to NEW orders (see cdoPractitionerCode). So
    // re-resolve the live terms from the catalogue when the mapped code still
    // resolves to the same practitioner; the snapshot is only a fallback.
    if (app.referral.code) {
      const live = await resolvePractitionerReferral(app.referral.code, { shop });
      if (live && String(live.practitionerId) === String(app.referral.practitionerId)) {
        referral.code = live.code;
        referral.codeId = live.codeId;
        referral.commissionRate = live.commissionRate;
        referral.discountPercent = live.discountPercent;
        referral.practitionerName = live.practitionerName || referral.practitionerName;
        referral.practitionerEmail = live.practitionerEmail || referral.practitionerEmail;
      }
    }
    // Still no rate (code archived / snapshot predates rates) → program default.
    if (referral.commissionRate == null) {
      const settings = await getSettings();
      referral.commissionRate = settings.defaultCommissionRate;
    }
    return { referral, attributionSource: "cdo_application" };
  }

  // 2. FALLBACK: validate a code carried on the order against the catalogue.
  if (rawCode) {
    const referral = await resolvePractitionerReferral(rawCode, { shop });
    if (referral) {
      // Permanent-binding guard. The cdo_applications case is handled in
      // step 1; this also covers a patient who has a cdo_referrals binding
      // but no application yet. If they're already bound to a DIFFERENT
      // practitioner, a foreign code must NOT re-attribute the order — the
      // relationship is permanent.
      const binding = await resolvePatientPractitioner({ email, customerId: customerGid });
      if (binding && String(binding.practitionerId) !== String(referral.practitionerId)) {
        console.warn(
          `[cdo.ingest] order ${payload?.id} carried code "${rawCode}" (practitioner ${referral.practitionerId}), but ${email || customerGid} is permanently bound to practitioner ${binding.practitionerId} — ignoring the foreign code, leaving order unattributed`,
        );
        return { referral: null, attributionSource: null };
      }
      return { referral, attributionSource: codeSource || null };
    }
  }

  return { referral: null, attributionSource: null };
}

// Map a Shopify orders/create REST payload (snake_case) to a cdo_orders
// document. Pure — no DB. `amount` is the order gross (total_price); the
// commission base is the order subtotal (product revenue, excl. tax +
// shipping), set by the caller.
function mapShopifyOrderToDoc(payload, { referral, attribution, shop }) {
  const o = payload || {};
  const shopifyOrderId =
    o.admin_graphql_api_id || (o.id ? `gid://shopify/Order/${o.id}` : null);

  const cust = o.customer || {};
  const customerName =
    `${cust.first_name || o.billing_address?.first_name || ""} ${
      cust.last_name || o.billing_address?.last_name || ""
    }`.trim();
  const customerEmail = String(
    o.email || o.contact_email || cust.email || "",
  )
    .toLowerCase()
    .trim();

  const mapAddress = (a) =>
    a
      ? {
          name: a.name || `${a.first_name || ""} ${a.last_name || ""}`.trim(),
          line1: a.address1 || "",
          line2: a.address2 || "",
          city: a.city || "",
          province: a.province || "",
          zip: a.zip || "",
          country: a.country || "",
          phone: a.phone || "",
        }
      : null;

  const subtotal = money(o.subtotal_price ?? o.current_subtotal_price);
  const totalDiscounts = money(o.total_discounts ?? o.current_total_discounts);
  const totalTax = money(o.total_tax ?? o.current_total_tax);
  const total = money(o.total_price ?? o.current_total_price);
  const totalShipping = money(
    o.total_shipping_price_set?.shop_money?.amount ??
      (o.shipping_lines || []).reduce((s, l) => s + money(l.price), 0),
  );

  // CDO program status (not Shopify's): cancelled / paid / pending.
  let status = "pending";
  if (o.cancelled_at) status = "cancelled";
  else if (o.financial_status === "paid") status = "paid";

  return {
    shop,
    attributed: Boolean(referral),
    practitionerId: referral?.practitionerId ?? null,
    practitionerEmail: referral?.practitionerEmail ?? null,
    practitionerName: referral?.practitionerName ?? null,

    shopifyOrderId,
    orderName: o.name || null,
    orderNumber: o.order_number != null ? String(o.order_number) : null,

    customerEmail,
    customerName,
    customer: {
      shopifyCustomerId: cust.admin_graphql_api_id || null,
      firstName: cust.first_name || null,
      lastName: cust.last_name || null,
      email: (cust.email || customerEmail || "").toLowerCase(),
      phone: cust.phone || o.phone || null,
    },

    lineItems: (o.line_items || []).map((li) => ({
      productId: li.product_id != null ? String(li.product_id) : null,
      variantId: li.variant_id != null ? String(li.variant_id) : null,
      sku: li.sku || null,
      title: li.title || null,
      variantTitle: li.variant_title || null,
      // Product vendor — drives per-line commission (see computeOrderCommission).
      vendor: li.vendor || null,
      quantity: Number(li.quantity) || 0,
      price: money(li.price),
      totalDiscount: money(li.total_discount),
    })),

    currency: o.currency || "USD",
    amount: total,
    pricing: { subtotal, totalDiscounts, totalTax, totalShipping, total },
    discountCodes: (o.discount_codes || []).map((d) => ({
      code: d.code || null,
      type: d.type || null,
      amount: money(d.amount),
    })),
    taxLines: (o.tax_lines || []).map((t) => ({
      title: t.title || null,
      rate: money(t.rate),
      price: money(t.price),
    })),
    shippingLines: (o.shipping_lines || []).map((s) => ({
      title: s.title || null,
      price: money(s.price),
    })),

    billingAddress: mapAddress(o.billing_address),
    shippingAddress: mapAddress(o.shipping_address),

    payment: {
      gateways: Array.isArray(o.payment_gateway_names)
        ? o.payment_gateway_names
        : [],
      financialStatus: o.financial_status || null,
    },
    financialStatus: o.financial_status || null,
    fulfillmentStatus: o.fulfillment_status || null,

    // Extra snapshot fields surfaced on the Retail Order Details page. Pure
    // snapshot of the payload — safe to overwrite on re-ingest. (Tracking +
    // QBO state live in separate fields managed by services/retailQbo and are
    // intentionally NOT set here, so re-ingests never clobber them.)
    tags:
      typeof o.tags === "string"
        ? o.tags.split(",").map((t) => t.trim()).filter(Boolean)
        : Array.isArray(o.tags)
          ? o.tags
          : [],
    note: o.note || null,
    noteAttributes: (o.note_attributes || []).map((a) => ({
      name: a?.name || "",
      value: a?.value != null ? String(a.value) : "",
    })),
    sourceName: o.source_name || null,
    transactions: (o.transactions || []).map((t) => ({
      id: t?.id != null ? String(t.id) : null,
      kind: t?.kind || null,
      status: t?.status || null,
      gateway: t?.gateway || null,
      amount: money(t?.amount),
      processedAt: t?.processed_at ? new Date(t.processed_at) : undefined,
    })),

    referral: referral || null,
    referralCode: referral?.code || null,
    attribution: attribution || { source: null, code: null, matchedAt: null },

    status,
    placedAt: o.created_at ? new Date(o.created_at) : new Date(),
  };
}

// Upsert the cdo_referrals "conversion" row for an attributed order. One
// row per (referralCode, referredEmail); flips to `converted` on the first
// attributed order and records the converting orderId. Returns the doc.
async function upsertReferralConversion({ shop, referral, order }) {
  const referredEmail = order.customerEmail || "";
  const when = order.placedAt || new Date();
  const existing = await CdoReferral.findOne({
    referralCode: referral.code,
    referredEmail,
  });
  if (existing) {
    if (existing.status !== "converted") {
      existing.status = "converted";
      existing.convertedAt = existing.convertedAt || when;
    }
    if (!existing.orderId) existing.orderId = order._id;
    await existing.save();
    return existing;
  }
  return CdoReferral.create({
    shop,
    practitionerId: referral.practitionerId,
    practitionerEmail: referral.practitionerEmail,
    practitionerName: referral.practitionerName,
    referralCode: referral.code,
    referredEmail,
    referredName: order.customerName || null,
    status: "converted",
    orderId: order._id,
    referredAt: when,
    convertedAt: when,
  });
}

// First-touch cdo_applications mapping for an attributed buyer. Mirrors the
// prior webhook behavior: attach the referral snapshot to an existing
// application only if it has none (first-touch wins), else create a patient
// application. Customer tagging stays in the webhook route (Shopify API).
async function upsertCustomerApplication({ shop, payload, referral }) {
  const email = String(
    payload?.email || payload?.contact_email || payload?.customer?.email || "",
  )
    .toLowerCase()
    .trim();
  if (!email) {
    console.warn(
      `[cdo.ingest] order ${payload?.id} has no email — skipping cdo_application mapping`,
    );
    return;
  }
  const customerGid = payload?.customer?.admin_graphql_api_id || null;
  const existing = await CdoApplication.findOne({ email }).lean();

  if (existing) {
    const updates = {};
    if (!existing.referral) updates.referral = referral;
    if (!existing.customerId && customerGid) updates.customerId = customerGid;
    if (Object.keys(updates).length) {
      await CdoApplication.updateOne({ _id: existing._id }, { $set: updates });
      console.log(
        `[cdo.ingest] updated cdo_application ${existing._id} — set ${Object.keys(updates).join(", ")}`,
      );
    }
    return;
  }

  await CdoApplication.create({
    shop,
    applicantType: "patient",
    firstName: payload?.customer?.first_name || payload?.billing_address?.first_name || null,
    lastName: payload?.customer?.last_name || payload?.billing_address?.last_name || null,
    email,
    billingAddress: null,
    shippingAddress: null,
    referral,
    status: "approved",
    submittedAt: new Date(),
    reviewedAt: null,
    customerId: customerGid,
  });
  console.log(`[cdo.ingest] created cdo_application for new patient ${email}`);
}

// Synchronize one Shopify order into cdo_orders and, when attributed,
// create + link the referral / commission / ledger / customer-mapping
// records. Idempotent: upserts the order by (shop, shopifyOrderId) and all
// downstream writes are guarded, so Shopify's at-least-once delivery +
// replays don't duplicate.
//
//   shop               – the order's shop domain
//   payload            – the orders/create REST payload
//   rawCode            – referral code extracted from the order (or null)
//   attributionSource  – "note_attribute" | "discount_code" | null
//
// Returns { ok, attributed, referralCode, customerGid } so the caller can
// tag the customer with the canonical code.
export async function ingestShopifyOrder({ shop, payload, rawCode, attributionSource } = {}) {
  await connectDB();
  const orderId = payload?.id;
  const shopifyOrderId =
    payload?.admin_graphql_api_id || (orderId ? `gid://shopify/Order/${orderId}` : null);
  if (!shopifyOrderId) {
    console.warn("[cdo.ingest] payload has no order id — skipping");
    return { ok: false, reason: "no_order_id" };
  }

  // cdo_applications is the primary source of truth (existing customer →
  // practitioner mapping); the order's code is the first-touch fallback,
  // validated against the cdo_practitioner_codes catalogue.
  const { referral, attributionSource: resolvedSource } = await resolveOrderReferral({
    shop,
    payload,
    rawCode,
    codeSource: attributionSource,
  });
  const attributed = Boolean(referral);
  if (rawCode && !attributed) {
    console.warn(
      `[cdo.ingest] order ${orderId} carried code "${rawCode}" but it didn't resolve to an eligible practitioner (no cdo_applications mapping + not in catalogue) — storing unattributed`,
    );
  }

  const attribution = attributed
    ? {
        source: resolvedSource || null,
        code: referral.code || rawCode || null,
        matchedAt: new Date(),
      }
    : { source: null, code: rawCode || null, matchedAt: null };

  const doc = mapShopifyOrderToDoc(payload, { referral, attribution, shop });

  // Commission is per-line + VENDOR-DRIVEN: each line earns
  // lineRevenue × the line's product-vendor rate (0% for unconfigured vendors).
  // It is SNAPSHOTTED EXACTLY ONCE — at first ingest (order creation). This
  // handler re-runs on orders/updated, orders/paid, and webhook replays, so we
  // must NOT recompute on re-ingest: a vendor-config change made after an order
  // exists must never alter that order or its commission. So we compute (and
  // snapshot the live config + version) only when the order is NEW to
  // cdo_orders; on re-ingest we leave commissionAmount/commissionSnapshot OUT of
  // the $set entirely, preserving the frozen originals (legacy pre-feature
  // orders keep their stored amount too).
  const existing = await CdoOrder.findOne({ shop, shopifyOrderId })
    .select("_id commissionAmount commissionSnapshot")
    .lean();

  if (!existing) {
    if (attributed) {
      const cfg = await getVendorCommissions();
      const { commissionAmount, snapshot } = computeOrderCommission(doc, {
        vendorCommissions: cfg.vendors,
        configVersion: cfg.version,
      });
      doc.commissionAmount = commissionAmount;
      doc.commissionSnapshot = snapshot;
    } else {
      doc.commissionAmount = 0;
      doc.commissionSnapshot = null;
    }
  }

  // Validation — never persist a negative / non-finite money figure. Only check
  // commissionAmount when we actually set it (new order); on re-ingest it's
  // absent from `doc`, so the frozen value is left untouched.
  if (!(doc.amount >= 0)) {
    console.error(
      `[cdo.ingest] order ${orderId} has invalid amount (${doc.amount}) — coercing to 0`,
    );
    doc.amount = 0;
  }
  if (doc.commissionAmount !== undefined && !(doc.commissionAmount >= 0)) {
    console.error(
      `[cdo.ingest] order ${orderId} has invalid commission (${doc.commissionAmount}) — coercing to 0`,
    );
    doc.commissionAmount = 0;
  }

  const order = await CdoOrder.findOneAndUpdate(
    { shop, shopifyOrderId },
    { $set: doc },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
  console.log(
    `[cdo.ingest] synced order ${order.orderName || shopifyOrderId} (attributed=${attributed}, amount=${order.amount} ${order.currency})`,
  );

  if (!attributed) return { ok: true, attributed: false, referralCode: null, customerGid: null };

  // Referral conversion row + link it back onto the order.
  const referralDoc = await upsertReferralConversion({ shop, referral, order });
  if (referralDoc && String(order.referralId || "") !== String(referralDoc._id)) {
    order.referralId = referralDoc._id;
    await CdoOrder.updateOne(
      { _id: order._id },
      { $set: { referralId: referralDoc._id } },
    );
  }

  // Commission lifecycle is gated on PAYMENT. The referral mapping +
  // conversion above are captured regardless (attribution survives before
  // payment), but the commission RECORD is only created once the order is
  // paid, reversed if the order is later refunded/voided/cancelled, and
  // deferred while the order is still unpaid.
  const settings = await getSettings();
  if (isOrderCommissionable(order)) {
    const { created } = await createCommissionForOrder(order, settings);
    console.log(
      `[cdo.ingest] order ${order.orderName || shopifyOrderId} PAID — commission ${
        created ? "created" : "already existed"
      } (${order.commissionAmount} ${order.currency}, practitioner=${referral.practitionerEmail})`,
    );
  } else if (isOrderClawback(order)) {
    const reversed = await reverseOrderCommission(
      order,
      `order ${order.financialStatus || order.status}`,
    );
    console.log(
      `[cdo.ingest] order ${order.orderName || shopifyOrderId} ${order.financialStatus || order.status} — commission ${reversed ? "reversed" : "not reversible / none"}`,
    );
  } else {
    console.log(
      `[cdo.ingest] order ${order.orderName || shopifyOrderId} not yet paid (financial=${order.financialStatus || "—"}) — commission deferred until paid`,
    );
  }

  // First-touch customer → practitioner mapping (regardless of payment).
  await upsertCustomerApplication({ shop, payload, referral });

  const customerGid = payload?.customer?.admin_graphql_api_id || null;
  return { ok: true, attributed: true, referralCode: referral.code, customerGid };
}

// ── Commission eligibility by payment state ──────────────────────────
//
// Commissions are MONEY and only attach to orders that actually collected
// money. `isOrderCommissionable` gates creation (fully paid, not cancelled);
// `isOrderClawback` gates reversal (refunded / voided / cancelled). Anything
// else (pending / authorized / partially_paid / partially_refunded) is a
// no-op — the commission is deferred or left as-is, awaiting a terminal state.
//
// NOTE on partial refunds: a `partially_refunded` order is left intact (it's
// still a paid sale); only a FULL `refunded`/`voided` claws back. Proration
// of partial refunds is a deliberate future enhancement, not done here.
const ORDER_CLAWBACK_FINANCIAL = ["refunded", "voided"];

function isOrderCommissionable(order) {
  if (order.status === "cancelled") return false;
  if (order.financialStatus) return order.financialStatus === "paid";
  // Legacy / seeded orders without a financialStatus snapshot: fall back to
  // the CDO order status.
  return order.status === "paid";
}

function isOrderClawback(order) {
  return order.status === "cancelled" || ORDER_CLAWBACK_FINANCIAL.includes(order.financialStatus);
}

// Reverse an order's commission IF it isn't already paid or reserved into a
// payout — posting a `reversal` ledger debit. Shared by the cancel webhook +
// the payment reconcile (refund/void). Idempotent. Returns true if reversed
// (or already reversed), false if there's nothing reversible.
async function reverseOrderCommission(order, reason) {
  const commission = await CdoCommission.findOne({ orderId: order._id });
  if (!commission) return false;
  if (commission.status === "paid" || commission.payoutId) {
    console.warn(
      `[cdo] order ${order.shopifyOrderId} ${reason} but commission ${commission._id} is ${commission.status}${commission.payoutId ? " (batched)" : ""} — NOT reversing (already posted/reserved)`,
    );
    return false;
  }
  if (commission.status === "reversed") return true;

  commission.status = "reversed";
  commission.payoutStatus = "cancelled";
  await commission.save();
  await appendLedgerEntry({
    shop: order.shop,
    practitionerId: order.practitionerId,
    practitionerEmail: order.practitionerEmail,
    practitionerName: order.practitionerName,
    currency: order.currency,
    type: "reversal",
    amount: -roundMoney(commission.amount),
    relatedType: "CdoCommission",
    relatedId: commission._id,
    description: `Commission reversed — ${reason} (${order.orderName || order.shopifyOrderId})`,
    occurredAt: new Date(),
  });
  console.log(
    `[cdo] order ${order.shopifyOrderId} commission ${commission._id} reversed — ${reason} (${commission.amount} ${order.currency})`,
  );
  return true;
}

// Handle orders/cancelled: mark the cdo_order cancelled and reverse its
// commission (via reverseOrderCommission — paid/batched commissions are left
// intact). Idempotent.
export async function cancelShopifyOrder({ shop, shopifyOrderId } = {}) {
  await connectDB();
  if (!shopifyOrderId) return { ok: false, reason: "no_order_id" };

  const order = await CdoOrder.findOne({ shop, shopifyOrderId });
  if (!order) {
    console.warn(
      `[cdo.cancel] order ${shopifyOrderId} not found in cdo_orders — nothing to cancel`,
    );
    return { ok: false, reason: "order_not_found" };
  }

  if (order.status !== "cancelled") {
    order.status = "cancelled";
    await order.save();
  }

  const reversed = await reverseOrderCommission(order, "order cancelled");
  return { ok: true, cancelled: true, reversed };
}

// ── Pause / resume controls ──────────────────────────────────────────
//
// Two independent admin switches that hold money out of the automated
// payout pipeline (mirrors the wholesale auto-charge pause pattern):
//   • per-commission  → cdo_commissions.paused
//   • per-practitioner → cdo_practitioner_holds.paused
// Both are honoured by getEligibleCommissions (and therefore buildPayoutBatch)
// and by autoApproveEligibleCommissions. Neither unwinds already-paid or
// already-batched payouts — they only gate future runs. All are idempotent.

export async function pauseCommission(commissionId, { actor, note } = {}) {
  if (!isValidObjectId(commissionId)) throw new Error("Invalid commission id");
  await connectDB();
  const c = await CdoCommission.findById(commissionId);
  if (!c) throw new Error("Commission not found");
  if (c.status === "paid") throw new Error("Cannot pause a paid commission");
  c.paused = true;
  c.pausedAt = new Date();
  c.pausedBy = actor || "admin";
  if (note !== undefined) c.pauseNote = note ? String(note).slice(0, 500) : null;
  // Reflect the hold on the payout dimension (unless already settled).
  if (c.payoutStatus !== "paid") c.payoutStatus = "paused";
  await c.save();
  log.info("commission.paused", { commissionId: String(c._id), actor });
  return c.toObject();
}

export async function resumeCommission(commissionId, { actor } = {}) {
  if (!isValidObjectId(commissionId)) throw new Error("Invalid commission id");
  await connectDB();
  const c = await CdoCommission.findById(commissionId);
  if (!c) throw new Error("Commission not found");
  c.paused = false;
  c.resumedAt = new Date();
  c.resumedBy = actor || "admin";
  // Return to the eligible pool unless it's already been paid.
  if (c.payoutStatus === "paused") c.payoutStatus = "pending";
  await c.save();
  log.info("commission.resumed", { commissionId: String(c._id), actor });
  return c.toObject();
}

// Set/clear a practitioner-wide payout hold. Upserts the single
// cdo_practitioner_holds row for the practitioner.
export async function pausePractitionerPayouts(practitionerId, { actor, note, shop } = {}) {
  if (!isValidObjectId(practitionerId)) throw new Error("Invalid practitioner id");
  await connectDB();
  const hold = await CdoPractitionerHold.findOneAndUpdate(
    { practitionerId },
    {
      $set: {
        paused: true,
        pausedAt: new Date(),
        pausedBy: actor || "admin",
        note: note ? String(note).slice(0, 500) : null,
        ...(shop ? { shop } : {}),
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
  log.info("practitioner.payouts_paused", { practitionerId, actor });
  return hold.toObject();
}

export async function resumePractitionerPayouts(practitionerId, { actor } = {}) {
  if (!isValidObjectId(practitionerId)) throw new Error("Invalid practitioner id");
  await connectDB();
  const hold = await CdoPractitionerHold.findOneAndUpdate(
    { practitionerId },
    {
      $set: {
        paused: false,
        resumedAt: new Date(),
        resumedBy: actor || "admin",
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
  log.info("practitioner.payouts_resumed", { practitionerId, actor });
  return hold.toObject();
}

// Read a practitioner's hold state (for the admin settings UI). Returns a
// stable shape even when no hold row exists yet.
export async function getPractitionerHold(practitionerId) {
  if (!isValidObjectId(practitionerId)) return { paused: false };
  await connectDB();
  const hold = await CdoPractitionerHold.findOne({ practitionerId }).lean();
  return {
    paused: hold?.paused === true,
    pausedAt: hold?.pausedAt || null,
    pausedBy: hold?.pausedBy || null,
    note: hold?.note || null,
    resumedAt: hold?.resumedAt || null,
    resumedBy: hold?.resumedBy || null,
  };
}

export async function isPractitionerPaused(practitionerId) {
  if (!practitionerId) return false;
  await connectDB();
  const hold = await CdoPractitionerHold.findOne({
    practitionerId,
    paused: true,
  })
    .select("_id")
    .lean();
  return Boolean(hold);
}

// All practitionerIds currently on payout hold — used to exclude them from
// batch-wide eligibility queries in one round-trip.
export async function getHeldPractitionerIds() {
  await connectDB();
  const rows = await CdoPractitionerHold.find({ paused: true })
    .select("practitionerId")
    .lean();
  return rows.map((r) => r.practitionerId).filter(Boolean);
}

// ── Phase 5: fully-automated payout run (CRON) ───────────────────────
//
// The hands-off pipeline behind process-commission-payouts. Chains the
// existing engine functions, honouring pause/hold filters, with NO manual
// approval step. Idempotent + safely re-runnable: accrual is guarded by
// orderId, approval only flips pending→approved, batching reserves
// commissions + is partial-unique on (practitionerId, periodEnd), and
// execution resumes-not-duplicates via per-step QBO id guards.

// Auto-approve eligible pending commissions (the "no manual approval"
// requirement). Skips paused commissions + held practitioners. Returns the
// count flipped pending→approved.
export async function autoApproveEligibleCommissions({ shop } = {}) {
  await connectDB();
  const held = await getHeldPractitionerIds();
  const filter = { status: "pending", paused: { $ne: true } };
  if (shop) filter.shop = shop;
  if (held.length) filter.practitionerId = { $nin: held };
  const res = await CdoCommission.updateMany(filter, {
    $set: { status: "approved" },
  });
  const approved = res.modifiedCount || 0;
  if (approved) log.info("commissions.auto_approved", { approved });
  return approved;
}

// Loud, structured alert for a failed payout. Always logs; optionally
// POSTs to CDO_PAYOUT_ALERT_WEBHOOK_URL when configured (off by default —
// never sends externally otherwise, and never includes bank details).
async function alertPayoutFailure(payout, err) {
  const message = err?.message || payout?.lastError || "unknown error";
  console.error(
    `\n🚨 [cdo.payout.alert] payout ${payout?.reference || payout?._id} for ${payout?.practitionerEmail || payout?.practitionerId} FAILED: ${message}\n`,
  );
  log.error("cdo.payout.alert", {
    payoutId: String(payout?._id),
    practitionerId: payout?.practitionerId,
    amount: payout?.amount,
    reference: payout?.reference,
    error: message,
  });
  const url = schedulerConfig.alertWebhookUrl;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "cdo_payout_failed",
        payoutId: String(payout?._id),
        practitionerId: payout?.practitionerId,
        practitionerEmail: payout?.practitionerEmail,
        amount: payout?.amount,
        currency: payout?.currency,
        reference: payout?.reference,
        error: message,
        at: new Date().toISOString(),
      }),
    });
  } catch (postErr) {
    log.warn("cdo.payout.alert_webhook_failed", { err: postErr });
  }
}

// ── Batch tracking (cdo_payout_batches) ──────────────────────────────
//
// Every automated run (and every manual reprocess) persists a durable
// cdo_payout_batches record snapshotting which commissions it processed +
// their per-commission outcome, so runs are traceable + reconcilable. The
// money path is unchanged (executeApprovedPayout); the batch is the audit
// layer on top. cdo_commissions carries a latest-state payout rollup.

function makeBatchReference() {
  // Runtime server code (not a workflow script), so Date/Math.random are
  // available. CDOB-<yyyymmddThhmm>-<rand>.
  const ts = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const rand = Math.random().toString(36).slice(2, 6);
  return `CDOB-${ts}-${rand}`;
}

// Mark a payout's commissions "processing", bump their attempt count, and
// push a processing item onto the in-memory items[] (persisted by caller).
async function markPayoutCommissionsProcessing(payout, batch, items, startedAt) {
  const comms = await CdoCommission.find({ _id: { $in: payout.commissionIds } }).lean();
  for (const c of comms) {
    const attempt = (c.payoutAttemptCount || 0) + 1;
    await CdoCommission.updateOne(
      { _id: c._id },
      {
        $set: { payoutStatus: "processing", lastPayoutAttemptAt: startedAt, lastBatchId: batch._id },
        $inc: { payoutAttemptCount: 1 },
      },
    );
    items.push({
      commissionId: c._id,
      practitionerId: c.practitionerId,
      practitionerEmail: c.practitionerEmail,
      orderName: c.orderName,
      amount: c.amount,
      status: "processing",
      attempt,
      payoutId: payout._id,
    });
  }
}

// Approve (if still awaiting approval) + execute one payout, then write the
// outcome onto its batch items + the commission rollups. Never throws —
// failures land on the items + an alert. Shared by run + reprocess.
async function settlePayoutForBatch(payoutId, payoutItems, { actor }) {
  try {
    const p = await CdoPayout.findById(payoutId).lean();
    if (p && ["draft", "awaiting_approval"].includes(p.status)) {
      await approvePayout(String(payoutId), actor);
    }
    const done = await executeApprovedPayout(String(payoutId), { actor });
    // With real-money disbursement, executeApprovedPayout returns
    // `awaiting_settlement` (transfer initiated, in flight) — that is SUCCESS
    // at this stage, not failure. The transfer settles to `paid` (or returns
    // to `failed`) later via the settlement poll. `paid` only happens here in
    // the legacy no-provider path. Anything else = a genuine execution failure.
    const paid = done.status === "paid";
    const inFlight = done.status === "awaiting_settlement";
    const success = paid || inFlight;
    const txnRef = done.providerTransferId || done.qboBillPaymentId || done.qboBillId || null;
    const payoutDate = done.paidAt || null;
    for (const it of payoutItems) {
      it.status = success ? (paid ? "paid" : "processing") : "failed";
      it.txnRef = txnRef;
      it.payoutDate = payoutDate;
      it.failureReason = success ? null : done.lastError || "execution did not complete";
      await CdoCommission.updateOne(
        { _id: it.commissionId },
        {
          $set: {
            payoutStatus: success ? (paid ? "paid" : "processing") : "failed",
            payoutDate: paid ? payoutDate : null,
            payoutTxnRef: txnRef,
            payoutFailureReason: success ? null : done.lastError || null,
          },
        },
      );
    }
    if (!success) await alertPayoutFailure(done, new Error(done.lastError || "payout not paid"));
  } catch (err) {
    const msg = err?.message || String(err);
    for (const it of payoutItems) {
      it.status = "failed";
      it.failureReason = msg;
      await CdoCommission.updateOne(
        { _id: it.commissionId },
        { $set: { payoutStatus: "failed", payoutFailureReason: msg } },
      );
    }
    const fresh = await CdoPayout.findById(payoutId).lean().catch(() => null);
    await alertPayoutFailure(fresh, err);
  }
}

// Per-practitioner rollup for a batch — one entry per cdo_payouts the run
// created/processed (one aggregated payout per practitioner). Reflects the
// payout's final state (status + QBO reference + aggregated total).
async function buildPractitionerPayoutRollup(payoutIds) {
  if (!payoutIds || !payoutIds.length) return [];
  const payouts = await CdoPayout.find({ _id: { $in: payoutIds } }).lean();
  return payouts.map((p) => ({
    practitionerId: p.practitionerId,
    practitionerName: p.practitionerName,
    practitionerEmail: p.practitionerEmail,
    payoutId: p._id,
    commissionCount: (p.commissionIds || []).length,
    totalAmount: p.amount || 0,
    status: p.status,
    txnRef: p.qboBillPaymentId || p.qboBillId || null,
  }));
}

function finalizeBatchCounts(batch, items) {
  batch.items = items;
  batch.totalCommissions = items.length;
  batch.totalAmount = roundMoney(items.reduce((s, i) => s + (Number(i.amount) || 0), 0));
  batch.successCount = items.filter((i) => i.status === "paid").length;
  batch.failedCount = items.filter((i) => i.status === "failed").length;
  batch.skippedCount = items.filter((i) => i.status === "skipped").length;
  batch.completedAt = new Date();
  batch.status = batch.failedCount > 0 ? "completed_with_errors" : "completed";
}

// The end-to-end automated run, wrapped in a durable batch record. Returns
// a summary the CRON job logs. `mode`/`trigger` tag how the run was started.
export async function runAutomatedPayouts({ shop, periodEnd, mode = "cron", trigger = "cron" } = {}) {
  await connectDB();
  const startedAt = new Date();
  const periodEndDate = periodEnd ? new Date(periodEnd) : new Date();

  const batch = await CdoPayoutBatch.create({
    shop: shop || null,
    reference: makeBatchReference(),
    mode,
    trigger,
    executionTime: startedAt,
    startedAt,
    status: "running",
  });

  const summary = {
    batchId: String(batch._id),
    reference: batch.reference,
    accrued: 0,
    approved: 0,
    batched: 0,
    paid: 0,
    failed: 0,
    skipped: 0,
    awaitingApproval: 0,
  };

  try {
    // 1. Accrue (safety net) + 2. auto-approve (no manual approval).
    const accrual = await accrueCommissionsForOrders({ shop });
    summary.accrued = accrual.createdCount || 0;
    summary.approved = await autoApproveEligibleCommissions({ shop });

    // Candidate pool (approved + unpaid + not paused; held excluded) BEFORE
    // reservation, so we can tell batched from skipped (below-minimum / open).
    const eligibleBefore = await getEligibleCommissions({ periodEnd: periodEndDate });
    const eligibleIds = new Set(eligibleBefore.map((c) => String(c._id)));

    // 3. Build payouts (reserves batched commissions via payoutId).
    const build = await buildPayoutBatch({ periodEnd: periodEndDate, actor: "system" });
    summary.batched = build.created.length;

    // Human-approval gate (default ON for real money): stop after building the
    // payouts. They wait in `awaiting_approval` for an admin to Approve +
    // Execute, which initiates the actual bank transfer. The CRON disburses
    // NOTHING. (Set CDO_PAYOUT_REQUIRE_APPROVAL=false for the legacy
    // end-to-end auto-disburse path.)
    if (payoutConfig.requireApproval) {
      batch.payoutIds = build.created.map((p) => p._id);
      batch.totalCommissions = build.created.reduce(
        (s, p) => s + (Array.isArray(p.commissionIds) ? p.commissionIds.length : 0),
        0,
      );
      batch.skippedCount = build.skipped.length;
      batch.practitionerPayouts = await buildPractitionerPayoutRollup(batch.payoutIds);
      batch.status = "completed";
      batch.completedAt = new Date();
      await batch.save();
      summary.skipped = build.skipped.length;
      summary.awaitingApproval = build.created.length;
      log.info("automated_payouts.awaiting_approval", { ...summary });
      return summary;
    }

    const items = [];
    const batchedIds = new Set();

    // 4. Mark batched commissions processing + record items.
    for (const payout of build.created) {
      batch.payoutIds.push(payout._id);
      const before = items.length;
      await markPayoutCommissionsProcessing(payout, batch, items, startedAt);
      for (let i = before; i < items.length; i += 1) batchedIds.add(String(items[i].commissionId));
    }

    // Skipped = eligible candidates that were not reserved into a payout
    // (below the minimum payout amount, or an open payout already exists).
    const skippedIds = [...eligibleIds].filter((id) => !batchedIds.has(id));
    if (skippedIds.length) {
      const skipped = await CdoCommission.find({ _id: { $in: skippedIds } }).lean();
      for (const c of skipped) {
        await CdoCommission.updateOne(
          { _id: c._id },
          { $set: { payoutStatus: "skipped", lastBatchId: batch._id } },
        );
        items.push({
          commissionId: c._id,
          practitionerId: c.practitionerId,
          practitionerEmail: c.practitionerEmail,
          orderName: c.orderName,
          amount: c.amount,
          status: "skipped",
          attempt: c.payoutAttemptCount || 0,
          failureReason: "below_minimum_or_open_payout",
        });
      }
    }

    // Persist the processing snapshot before execution (crash visibility).
    batch.items = items;
    batch.totalCommissions = items.length;
    batch.skippedCount = skippedIds.length;
    await batch.save();

    // 5. Approve + execute each payout; record outcomes per commission.
    for (const payout of build.created) {
      const payoutItems = items.filter((i) => String(i.payoutId) === String(payout._id));
      await settlePayoutForBatch(payout._id, payoutItems, { actor: "system" });
    }

    // 6. Finalize — counts + per-practitioner rollup (one entry per payout).
    batch.practitionerPayouts = await buildPractitionerPayoutRollup(batch.payoutIds);
    finalizeBatchCounts(batch, items);
    await batch.save();
    summary.paid = batch.successCount;
    summary.failed = batch.failedCount;
    summary.skipped = batch.skippedCount;
  } catch (wholeErr) {
    batch.status = "failed";
    batch.error = wholeErr?.message || String(wholeErr);
    batch.completedAt = new Date();
    await batch.save().catch(() => {});
    log.error("automated_payouts.failed", { batchId: String(batch._id), err: wholeErr });
    throw wholeErr;
  }

  log.info("automated_payouts.run", { ...summary });
  return summary;
}

// List payout batches for the admin view (newest first).
export async function listPayoutBatches({ limit = 0 } = {}) {
  await connectDB();
  const q = CdoPayoutBatch.find({}).sort({ createdAt: -1 });
  if (limit) q.limit(limit);
  const rows = await q.lean();
  return rows.map((b) => ({
    id: b._id.toString(),
    reference: b.reference,
    mode: b.mode,
    status: b.status,
    executionTime: b.executionTime || b.createdAt || null,
    completedAt: b.completedAt || null,
    totalCommissions: b.totalCommissions || 0,
    totalAmount: b.totalAmount || 0,
    ...batchOutcomeCounts(b),
  }));
}

// Per-batch outcome counts for the breakdown column. `processing` is DERIVED
// as the remainder (commissions batched into a payout but not yet paid/failed/
// skipped — i.e. awaiting admin approval or awaiting bank settlement). Deriving
// it makes the breakdown always reconcile with totalCommissions, and works for
// existing batches too (the approval-gated run path records totalCommissions
// but no items/paid-failed-skipped counts, which is why those rows showed
// 0 / 0 / 0 against a non-zero commission count).
function batchOutcomeCounts(b) {
  const successCount = b.successCount || 0;
  const failedCount = b.failedCount || 0;
  const skippedCount = b.skippedCount || 0;
  const total = b.totalCommissions || 0;
  return {
    successCount,
    failedCount,
    skippedCount,
    processingCount: Math.max(
      0,
      total - successCount - failedCount - skippedCount,
    ),
  };
}

// Full batch detail (rollup + per-commission items) for the detail page.
export async function getPayoutBatch(id) {
  if (!isValidObjectId(id)) return null;
  await connectDB();
  const b = await CdoPayoutBatch.findById(id).lean();
  if (!b) return null;

  // Join the linked cdo_payouts to enrich the per-practitioner rollup with
  // the vendor-bill deep link + method + paidAt + the payout audit trail
  // (remarks[]), so the batch detail can show bills + history per practitioner.
  const payoutIds = (b.practitionerPayouts || [])
    .map((p) => p.payoutId)
    .filter(Boolean);
  const payoutDocs = payoutIds.length
    ? await CdoPayout.find({ _id: { $in: payoutIds } })
        .select("status method paidAt qboBillId qboBillPaymentId reference remarks")
        .lean()
    : [];
  const payoutById = new Map(payoutDocs.map((p) => [String(p._id), p]));

  return {
    id: b._id.toString(),
    reference: b.reference,
    mode: b.mode,
    trigger: b.trigger || null,
    status: b.status,
    executionTime: b.executionTime || b.createdAt || null,
    startedAt: b.startedAt || null,
    completedAt: b.completedAt || null,
    totalCommissions: b.totalCommissions || 0,
    totalAmount: b.totalAmount || 0,
    ...batchOutcomeCounts(b),
    error: b.error || null,
    practitionerPayouts: (b.practitionerPayouts || []).map((p) => {
      const doc = p.payoutId ? payoutById.get(String(p.payoutId)) : null;
      const billId = doc?.qboBillId || null;
      return {
        id: p.payoutId ? String(p.payoutId) : String(p.practitionerId),
        practitionerId: p.practitionerId || null,
        practitionerName: p.practitionerName || p.practitionerEmail || "—",
        practitionerEmail: p.practitionerEmail || null,
        payoutId: p.payoutId ? String(p.payoutId) : null,
        commissionCount: p.commissionCount || 0,
        totalAmount: p.totalAmount || 0,
        status: doc?.status || p.status || "—",
        method: doc?.method || null,
        reference: doc?.reference || null,
        paidAt: doc?.paidAt || null,
        txnRef: p.txnRef || doc?.qboBillPaymentId || billId || null,
        qboBillId: billId,
        qboBillUrl: billId ? billWebUrl(billId) : null,
        remarks: (doc?.remarks || []).map((r) => ({
          kind: r.kind,
          message: r.message,
          actor: r.actor || "system",
          source: r.source || "system",
          createdAt: r.createdAt || null,
        })),
      };
    }),
    items: (b.items || []).map((i) => ({
      id: String(i.commissionId), // one item per commission per batch
      commissionId: String(i.commissionId),
      practitionerId: i.practitionerId || null,
      practitionerEmail: i.practitionerEmail || null,
      orderName: i.orderName || "—",
      amount: i.amount || 0,
      status: i.status,
      attempt: i.attempt || 0,
      failureReason: i.failureReason || null,
      txnRef: i.txnRef || null,
      payoutId: i.payoutId ? String(i.payoutId) : null,
      payoutDate: i.payoutDate || null,
    })),
  };
}

// Cross-batch attempt trail for one commission (every batch that touched it).
export async function getCommissionPayoutHistory(commissionId) {
  if (!isValidObjectId(commissionId)) return [];
  await connectDB();
  const batches = await CdoPayoutBatch.find({ "items.commissionId": commissionId })
    .sort({ createdAt: -1 })
    .lean();
  const history = [];
  for (const b of batches) {
    for (const i of b.items || []) {
      if (String(i.commissionId) !== String(commissionId)) continue;
      history.push({
        batchId: b._id.toString(),
        reference: b.reference,
        mode: b.mode,
        at: b.executionTime || b.createdAt || null,
        status: i.status,
        attempt: i.attempt || 0,
        failureReason: i.failureReason || null,
        txnRef: i.txnRef || null,
        payoutDate: i.payoutDate || null,
      });
    }
  }
  return history;
}

// Reprocess a batch's FAILED payouts in a fresh manual_reprocess batch.
// executeApprovedPayout resumes idempotently (per-step QBO id guards +
// stable requestids), so retrying never double-pays. Increments each
// commission's payoutAttemptCount.
export async function reprocessBatch(batchId, { actor } = {}) {
  if (!isValidObjectId(batchId)) throw new Error("Invalid batch id");
  await connectDB();
  const source = await CdoPayoutBatch.findById(batchId).lean();
  if (!source) throw new Error("Batch not found");

  const failedPayoutIds = [
    ...new Set(
      (source.items || [])
        .filter((i) => i.status === "failed" && i.payoutId)
        .map((i) => String(i.payoutId)),
    ),
  ];
  if (!failedPayoutIds.length) {
    return { ok: true, reprocessed: 0, message: "No failed payouts to reprocess" };
  }

  const startedAt = new Date();
  const batch = await CdoPayoutBatch.create({
    shop: source.shop || null,
    reference: makeBatchReference(),
    mode: "manual_reprocess",
    trigger: `reprocess:${source.reference}`,
    executionTime: startedAt,
    startedAt,
    status: "running",
  });

  const items = [];
  try {
    for (const pid of failedPayoutIds) {
      const payout = await CdoPayout.findById(pid).lean();
      if (!payout || payout.status === "paid") continue; // already settled — skip
      batch.payoutIds.push(payout._id);
      await markPayoutCommissionsProcessing(payout, batch, items, startedAt);
    }
    batch.items = items;
    batch.totalCommissions = items.length;
    await batch.save();

    for (const pid of batch.payoutIds) {
      const payoutItems = items.filter((i) => String(i.payoutId) === String(pid));
      await settlePayoutForBatch(pid, payoutItems, { actor: actor || "admin" });
    }

    batch.practitionerPayouts = await buildPractitionerPayoutRollup(batch.payoutIds);
    finalizeBatchCounts(batch, items);
    await batch.save();
  } catch (wholeErr) {
    batch.status = "failed";
    batch.error = wholeErr?.message || String(wholeErr);
    batch.completedAt = new Date();
    await batch.save().catch(() => {});
    throw wholeErr;
  }

  return {
    ok: true,
    reprocessed: batch.totalCommissions,
    batchId: String(batch._id),
    reference: batch.reference,
    paid: batch.successCount,
    failed: batch.failedCount,
  };
}

// ── Orders module (top-level admin view over the full cdo_orders set) ─
//
// Unlike listOrders() (attributed-only, for the CDO Program tab), these
// power the standalone Orders module: EVERY synced order, with server-side
// pagination / filtering / sorting + a full per-order detail. Read-only.

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ORDER_SORT_FIELDS = ["placedAt", "amount", "commissionAmount", "createdAt"];

export async function listCdoOrders({
  page = 1,
  pageSize = 25,
  sort = "placedAt",
  dir = "desc",
  filters = {},
} = {}) {
  await connectDB();
  const f = filters || {};
  const and = [];

  if (f.orderNumber) {
    const rx = escapeRegex(f.orderNumber);
    and.push({ $or: [{ orderName: { $regex: rx, $options: "i" } }, { orderNumber: { $regex: rx, $options: "i" } }] });
  }
  if (f.customer) {
    const rx = escapeRegex(f.customer);
    and.push({ $or: [{ customerName: { $regex: rx, $options: "i" } }, { customerEmail: { $regex: rx, $options: "i" } }] });
  }
  if (f.practitioner) {
    const rx = escapeRegex(f.practitioner);
    and.push({ $or: [{ practitionerName: { $regex: rx, $options: "i" } }, { practitionerEmail: { $regex: rx, $options: "i" } }, { practitionerId: f.practitioner }] });
  }
  if (f.referralCode) and.push({ referralCode: { $regex: `^${escapeRegex(f.referralCode)}$`, $options: "i" } });
  if (f.status) and.push({ status: f.status });
  if (f.financialStatus) and.push({ financialStatus: f.financialStatus });
  if (f.commissionStatus === "attributed") and.push({ attributed: true });
  else if (f.commissionStatus === "unattributed") and.push({ attributed: { $ne: true } });
  if (f.dateFrom || f.dateTo) {
    const range = {};
    if (f.dateFrom) range.$gte = new Date(f.dateFrom);
    if (f.dateTo) {
      const d = new Date(f.dateTo);
      d.setHours(23, 59, 59, 999);
      range.$lte = d;
    }
    and.push({ placedAt: range });
  }
  const query = and.length ? { $and: and } : {};

  const sortField = ORDER_SORT_FIELDS.includes(sort) ? sort : "placedAt";
  const sortDir = dir === "asc" ? 1 : -1;
  const size = Math.min(Math.max(Number(pageSize) || 25, 1), 100);
  const pageNum = Math.max(Number(page) || 1, 1);

  const [total, rows] = await Promise.all([
    CdoOrder.countDocuments(query),
    CdoOrder.find(query)
      .sort({ [sortField]: sortDir, _id: -1 })
      .skip((pageNum - 1) * size)
      .limit(size)
      .select(
        "shopifyOrderId orderName orderNumber customerName customerEmail practitionerName practitionerEmail referralCode amount commissionAmount currency status financialStatus fulfillmentStatus fulfillments shippedAt attributed placedAt createdAt retailQbo",
      )
      .lean(),
  ]);

  return {
    rows: rows.map((r) => ({
      id: r._id.toString(),
      shopifyOrderId: r.shopifyOrderId || null,
      orderName: r.orderName || r.orderNumber || r.shopifyOrderId || "—",
      orderNumber: r.orderNumber || null,
      customerName: r.customerName || r.customerEmail || "—",
      practitionerName: r.attributed ? r.practitionerName || r.practitionerEmail || "—" : "—",
      referralCode: r.referralCode || "—",
      amount: r.amount || 0,
      commissionAmount: r.commissionAmount || 0,
      currency: r.currency || "USD",
      status: r.status || "pending",
      financialStatus: r.financialStatus || "—",
      // Raw Shopify field kept for back-compat; the derived keys below are what
      // the UI renders (self-healing, in sync with fulfillments[]).
      fulfillmentStatus: r.fulfillmentStatus || "unfulfilled",
      shippingStatus: deriveShippingStatus(r),
      deliveryStatus: deriveDeliveryStatus(r),
      // Carrier tracking number(s) + URL(s) for the Shipping status column —
      // clickable through to the carrier's tracking page (mirrors detail page).
      tracking: extractTracking(r),
      attributed: r.attributed === true,
      placedAt: r.placedAt || r.createdAt || null,
      // Ship + delivered dates shown alongside the shipping/delivery badges.
      shippedAt: r.shippedAt || null,
      deliveredAt: deriveDeliveredAt(r),
      // QBO invoice summary for the list's "QBO Invoice" column.
      qbo: r.retailQbo
        ? {
            invoiceId: r.retailQbo.qboInvoiceId || null,
            docNumber: r.retailQbo.qboInvoiceDocNumber || null,
            syncStatus: r.retailQbo.qboSyncStatus || null,
            invoiceUrl: r.retailQbo.invoiceUrl || null,
            // Invoice settlement state in QBO + Shopify payment status, so the
            // list can show a "Paid" indicator that matches the payment.
            invoiceStatus: r.retailQbo.invoiceStatus || null,
            paymentStatus: r.retailQbo.paymentSyncStatus || null,
            // Vendor Bill (A/P) summary — the dropship cost owed to the supplier
            // + its reconciliation (paid) state.
            billId: r.retailQbo.qboBillId || null,
            billStatus: r.retailQbo.billSyncStatus || null,
            billPaymentStatus: r.retailQbo.billPaymentStatus || null,
            billReconcileStatus: r.retailQbo.billReconcileStatus || null,
          }
        : null,
    })),
    total,
    page: pageNum,
    pageSize: size,
    pageCount: Math.max(1, Math.ceil(total / size)),
    sort: sortField,
    dir: sortDir === 1 ? "asc" : "desc",
  };
}

// Full per-order detail for the Orders detail page — the complete cdo_orders
// snapshot + any linked commission(s).
export async function getCdoOrderDetail(id) {
  if (!isValidObjectId(id)) return null;
  await connectDB();
  const o = await CdoOrder.findById(id).lean();
  if (!o) return null;
  const commissions = await CdoCommission.find({ orderId: o._id }).lean();

  return {
    id: o._id.toString(),
    shopifyOrderId: o.shopifyOrderId || null,
    orderName: o.orderName || o.orderNumber || o.shopifyOrderId || "—",
    orderNumber: o.orderNumber || null,
    status: o.status || "pending",
    financialStatus: o.financialStatus || null,
    fulfillmentStatus: o.fulfillmentStatus || null,
    // Derived, self-healing display statuses (in sync with fulfillments[]).
    shippingStatus: deriveShippingStatus(o),
    deliveryStatus: deriveDeliveryStatus(o),
    currency: o.currency || "USD",
    amount: o.amount || 0,
    commissionAmount: o.commissionAmount || 0,
    attributed: o.attributed === true,
    placedAt: o.placedAt || null,
    createdAt: o.createdAt || null,
    updatedAt: o.updatedAt || null,
    customer: {
      name: o.customerName || o.customer?.firstName || "—",
      email: o.customerEmail || o.customer?.email || null,
      phone: o.customer?.phone || null,
      shopifyCustomerId: o.customer?.shopifyCustomerId || null,
    },
    practitioner: o.attributed
      ? { id: o.practitionerId || null, name: o.practitionerName || null, email: o.practitionerEmail || null }
      : null,
    referral: o.referral || null,
    referralCode: o.referralCode || null,
    attribution: o.attribution || null,
    lineItems: o.lineItems || [],
    pricing: o.pricing || {},
    discountCodes: o.discountCodes || [],
    taxLines: o.taxLines || [],
    shippingLines: o.shippingLines || [],
    billingAddress: o.billingAddress || null,
    shippingAddress: o.shippingAddress || null,
    payment: o.payment || {},
    // ── Extra Shopify snapshot ──
    tags: o.tags || [],
    note: o.note || null,
    noteAttributes: o.noteAttributes || [],
    sourceName: o.sourceName || null,
    transactions: (o.transactions || []).map((t) => ({
      id: t.id || null,
      kind: t.kind || null,
      status: t.status || null,
      gateway: t.gateway || null,
      amount: t.amount ?? null,
      processedAt: t.processedAt || null,
    })),
    // ── Fulfillment + tracking ──
    shippedAt: o.shippedAt || null,
    fulfillments: (o.fulfillments || []).map((f) => ({
      fulfillmentId: f.fulfillmentId || null,
      trackingNumber: f.trackingNumber || null,
      trackingCompany: f.trackingCompany || null,
      trackingUrl: f.trackingUrl || null,
      shipmentStatus: f.shipmentStatus || null,
      status: f.status || null,
      fulfilledAt: f.fulfilledAt || null,
      updatedAt: f.updatedAt || null,
    })),
    trackingHistory: (o.trackingHistory || []).map((h) => ({
      at: h.at || null,
      trackingNumber: h.trackingNumber || null,
      trackingCompany: h.trackingCompany || null,
      shipmentStatus: h.shipmentStatus || null,
      event: h.event || null,
    })),
    // ── Retail QBO invoice ──
    retailQbo: o.retailQbo
      ? {
          qboCustomerId: o.retailQbo.qboCustomerId || null,
          qboInvoiceId: o.retailQbo.qboInvoiceId || null,
          qboInvoiceDocNumber: o.retailQbo.qboInvoiceDocNumber || null,
          qboInvoiceTotal: o.retailQbo.qboInvoiceTotal ?? null,
          invoiceUrl: o.retailQbo.invoiceUrl || null,
          qboCreatedAt: o.retailQbo.qboCreatedAt || null,
          qboSyncStatus: o.retailQbo.qboSyncStatus || null,
          qboSyncedAt: o.retailQbo.qboSyncedAt || null,
          qboSyncError: o.retailQbo.qboSyncError || null,
          // ── Payment (invoice marked Paid in QBO) ──
          invoiceStatus: o.retailQbo.invoiceStatus || null,
          qboPaymentId: o.retailQbo.qboPaymentId || null,
          qboPaymentRefNum: o.retailQbo.qboPaymentRefNum || null,
          qboPaymentTotal: o.retailQbo.qboPaymentTotal ?? null,
          qboPaymentUrl: o.retailQbo.qboPaymentUrl || null,
          shopifyTransactionId: o.retailQbo.shopifyTransactionId || null,
          shopifyPaymentGateway: o.retailQbo.shopifyPaymentGateway || null,
          paymentAppliedAt: o.retailQbo.paymentAppliedAt || null,
          paymentSyncStatus: o.retailQbo.paymentSyncStatus || null,
          paymentSyncError: o.retailQbo.paymentSyncError || null,
          invoiceSentAt: o.retailQbo.invoiceSentAt || null,
          invoiceEmailedTo: o.retailQbo.invoiceEmailedTo || null,
          invoiceEmailStatus: o.retailQbo.invoiceEmailStatus || null,
          lastShipmentNotifiedAt: o.retailQbo.lastShipmentNotifiedAt || null,
          lastNotifiedTracking: o.retailQbo.lastNotifiedTracking || null,
          // ── Vendor Bill (A/P — dropship cost owed to the wholesale supplier) ──
          qboVendorId: o.retailQbo.qboVendorId || null,
          qboBillId: o.retailQbo.qboBillId || null,
          qboBillDocNumber: o.retailQbo.qboBillDocNumber || null,
          qboBillTotal: o.retailQbo.qboBillTotal ?? null,
          billUrl: o.retailQbo.billUrl || null,
          billCreatedAt: o.retailQbo.billCreatedAt || null,
          billSyncStatus: o.retailQbo.billSyncStatus || null,
          billSyncedAt: o.retailQbo.billSyncedAt || null,
          billSyncError: o.retailQbo.billSyncError || null,
          // ── Bill reconciliation (vendor bill marked Paid via a Retail QBO
          //    BillPayment once the wholesale dropship invoice settles) ──
          wholesaleInvoiceMongoId: o.retailQbo.wholesaleInvoiceMongoId || null,
          wholesaleQboInvoiceId: o.retailQbo.wholesaleQboInvoiceId || null,
          wholesaleQboPaymentId: o.retailQbo.wholesaleQboPaymentId || null,
          qboBillPaymentId: o.retailQbo.qboBillPaymentId || null,
          billPaymentUrl: o.retailQbo.billPaymentUrl || null,
          billPaymentTotal: o.retailQbo.billPaymentTotal ?? null,
          billPaymentAppliedAt: o.retailQbo.billPaymentAppliedAt || null,
          billPaymentStatus: o.retailQbo.billPaymentStatus || null,
          billReconcileStatus: o.retailQbo.billReconcileStatus || null,
          billReconcileError: o.retailQbo.billReconcileError || null,
          billReconciledAt: o.retailQbo.billReconciledAt || null,
          syncLog: (o.retailQbo.syncLog || []).map((s) => ({
            at: s.at || null,
            event: s.event || null,
            ok: s.ok === true,
            message: s.message || null,
          })),
        }
      : null,
    commissions: commissions.map((c) => ({
      id: c._id.toString(),
      amount: c.amount || 0,
      rate: c.rate || 0,
      status: c.status || "pending",
      payoutStatus: c.payoutStatus || null,
      payoutDate: c.payoutDate || null,
      payoutTxnRef: c.payoutTxnRef || null,
      payoutId: c.payoutId ? String(c.payoutId) : null,
      earnedAt: c.earnedAt || null,
    })),
    timeline: [
      o.placedAt ? { label: "Order placed", at: o.placedAt } : null,
      o.attribution?.matchedAt
        ? { label: `Referral matched (${o.attribution.source || "code"})`, at: o.attribution.matchedAt }
        : null,
      o.createdAt ? { label: "Synced to CDO", at: o.createdAt } : null,
      o.retailQbo?.qboCreatedAt
        ? {
            label: `QBO invoice created${o.retailQbo.qboInvoiceDocNumber ? ` (#${o.retailQbo.qboInvoiceDocNumber})` : ""}`,
            at: o.retailQbo.qboCreatedAt,
          }
        : null,
      o.retailQbo?.billCreatedAt
        ? {
            label: `Vendor bill created${o.retailQbo.qboBillDocNumber ? ` (#${o.retailQbo.qboBillDocNumber})` : ""}`,
            at: o.retailQbo.billCreatedAt,
          }
        : null,
      o.retailQbo?.billPaymentAppliedAt
        ? { label: "Vendor bill paid (reconciled)", at: o.retailQbo.billPaymentAppliedAt }
        : null,
      o.shippedAt ? { label: "Shipped", at: o.shippedAt } : null,
      o.updatedAt ? { label: "Last updated", at: o.updatedAt } : null,
    ].filter(Boolean),
  };
}
