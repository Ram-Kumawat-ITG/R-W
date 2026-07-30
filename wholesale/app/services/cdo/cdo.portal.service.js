// Practitioner Portal service — aggregation/query logic for the practitioner
// dashboard (Theme App Extension, wholesale storefront), PLUS the
// practitioner self-service WRITES (referral code create / pause / resume).
// The read paths are the bulk of this file; the write paths live in the
// "Referral code self-service" section at the bottom.
//
// This is the wholesale port of ns-retail's cdo.portal.service.js. ns-retail
// still OWNS and WRITES cdo_orders / cdo_commissions / cdo_payouts /
// cdo_referrals — every model imported below is a READ-ONLY mirror (see
// app/models/cdo{Order,Commission,Payout,Referral}.server.js). Referral-code
// writes go to `cdo_practitioner_codes`, a collection BOTH apps write (see
// app/models/cdoPractitionerCode.server.js).
//
// PROJECT LAW: API handlers under app/api/portal/ are thin — they auth,
// validate, call one of these functions, and shape the response. All
// business logic lives here.
//
// SECURITY MODEL (the core requirement of this feature):
//   Identity is NEVER trusted from the client. The portal guard verifies the
//   Shopify App Proxy request and reads `logged_in_customer_id` (a WHOLESALE
//   store customer id — this portal runs on the wholesale storefront, where
//   practitioners already have accounts), which resolvePractitionerByCustomerId
//   maps directly to an APPROVED WholesaleApplication (same store, so no
//   cross-store email bridge is needed, unlike the ns-retail version this was
//   ported from). Every cdo_* query below is scoped by { practitionerId } so
//   a practitioner can only ever see their own data.

import { createLogger } from "../../utils/logger.utils";
import { normalizeReferralCode } from "../../utils/referralCode";
import WholesaleApplication from "../../models/wholesaleApplication.server";
import CdoPractitionerCode from "../../models/cdoPractitionerCode.server";
import CdoOrder from "../../models/cdoOrder.server";
import CdoCommission from "../../models/cdoCommission.server";
import CdoPayout from "../../models/cdoPayout.server";
import CdoReferral from "../../models/cdoReferral.server";
import { createRetailDiscount, setRetailDiscountActive } from "./cdo.service";
import { syncConfig, isFulfillmentSyncEnabled } from "../sync/sync.config";
import {
  notifyReferralCodeCreated,
  notifyReferralCodePaused,
  notifyReferralCodeResumed,
} from "../notifications/referralCodeNotification.service";

// Revenue expression shared by aggregations: prefer pricing.total, fall
// back to the flat `amount`, then 0. ns-retail writes both on most docs.
const REVENUE_EXPR = {
  $ifNull: ["$pricing.total", { $ifNull: ["$amount", 0] }],
};

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function clampPage(page) {
  const p = parseInt(page, 10);
  return Number.isFinite(p) && p > 0 ? p : 1;
}

function clampPageSize(pageSize, fallback = 20, max = 100) {
  const s = parseInt(pageSize, 10);
  if (!Number.isFinite(s) || s <= 0) return fallback;
  return Math.min(s, max);
}

// Escape user input before building a case-insensitive regex for search.
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ── Auth + tenant resolution ───────────────────────────────────────────────

const ERR_UNAUTHENTICATED = "UNAUTHENTICATED";
const ERR_FORBIDDEN = "FORBIDDEN";

const log = createLogger("cdo.portal.service");

/**
 * Resolve a logged-in wholesale-store customer (by GID, from App Proxy's
 * `logged_in_customer_id`) to an approved practitioner. Throws a typed Error:
 *   - code 'UNAUTHENTICATED' → no customer id (anonymous / not logged in)
 *   - code 'FORBIDDEN'       → logged in, but no matching approved application
 *
 * Unlike ns-retail's cross-store version (the portal ran on a different
 * store than the practitioner's wholesale account, requiring an email
 * bridge + a live Shopify tag check), this portal runs on the SAME store
 * the practitioner registered on — `wholesale_applications.customerId` is
 * already a wholesale-store GID, so a direct match is sufficient. Approval
 * state is tracked natively on `WholesaleApplication.status`, so there's no
 * separate Shopify-tag gate to enforce here.
 *
 * @param {string|null} customerId - gid://shopify/Customer/<id> from App Proxy
 * @returns {Promise<{ practitionerId: string, application: object }>}
 */
export async function resolvePractitionerByCustomerId(customerId) {
  if (!customerId) {
    const e = new Error("Not logged in");
    e.code = ERR_UNAUTHENTICATED;
    throw e;
  }

  const application = await WholesaleApplication.findOne({
    customerId,
    status: "approved",
  }).lean();

  if (!application) {
    log.info("resolve.no_approved_application", { customerId });
    const e = new Error("Not an approved practitioner");
    e.code = ERR_FORBIDDEN;
    throw e;
  }

  return { practitionerId: String(application._id), application };
}

resolvePractitionerByCustomerId.ERR_UNAUTHENTICATED = ERR_UNAUTHENTICATED;
resolvePractitionerByCustomerId.ERR_FORBIDDEN = ERR_FORBIDDEN;

// ── Practitioner identity (for /me bootstrap) ────────────────────────────────

export async function getProfile(practitionerId, application) {
  const codes = await CdoPractitionerCode.find({ practitionerId })
    .select("code isPrimary status discountPercent commissionRate")
    .lean();
  const primary = codes.find((c) => c.isPrimary) || codes[0] || null;
  return {
    practitionerId,
    name:
      [application.firstName, application.lastName].filter(Boolean).join(" ") ||
      application.businessName ||
      null,
    email: application.email || null,
    businessName: application.businessName || null,
    primaryCode: primary?.code || null,
    codeCount: codes.length,
  };
}

// ── Summary cards ────────────────────────────────────────────────────────────

export async function getSummary(practitionerId) {
  const [revenue, referredPatients, commissions] = await Promise.all([
    getRevenue(practitionerId),
    // UNIQUE patients (deduped by email) — matches the Referred Customers tab.
    // (cdo_referrals has one row per referral event, so a patient who used
    // several codes would otherwise be over-counted here.)
    countReferredPatients(practitionerId),
    commissionTotals(practitionerId),
  ]);

  return {
    referredPatients,
    lifetimeRevenue: revenue.lifetime,
    lifetimeOrders: revenue.orderCount,
    revenueThisMonth: revenue.thisMonth,
    totalCommission: commissions.total,
    paidCommission: commissions.paid,
    pendingCommission: commissions.pending,
    awaitingPayoutCommission: commissions.awaitingPayout,
    activeReferralCodes: await CdoPractitionerCode.countDocuments({
      practitionerId,
      status: "active",
    }),
  };
}

// Count UNIQUE referred patients (by the schema-lowercased email; emailless
// referrals each count once). Uses the same identity key as
// getReferredCustomers so the Overview "Referred patients" card reconciles with
// the Referred Customers tab's row count.
async function countReferredPatients(practitionerId) {
  const rows = await CdoReferral.aggregate([
    { $match: { practitionerId } },
    {
      $group: {
        _id: {
          $cond: [
            { $gt: [{ $strLenCP: { $ifNull: ["$referredEmail", ""] } }, 0] },
            "$referredEmail",
            { $concat: ["ref:", { $toString: "$_id" }] },
          ],
        },
      },
    },
    { $count: "n" },
  ]);
  return rows[0]?.n || 0;
}

// ── Revenue (date-bucketed) ──────────────────────────────────────────────────

function monthBoundaries(now = new Date()) {
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const thisYear = new Date(now.getFullYear(), 0, 1);
  return { thisMonth, lastMonth, thisYear };
}

export async function getRevenue(practitionerId, { from, to } = {}) {
  const { thisMonth, lastMonth, thisYear } = monthBoundaries();
  const fromD = parseDate(from);
  const toParsed = parseDate(to);
  // A bare YYYY-MM-DD is parsed as UTC midnight. Extend the `to` bound to the
  // END of that day so the To date is INCLUSIVE — otherwise orders placed
  // later the same day are silently dropped from the range.
  const toD = toParsed ? new Date(toParsed.getTime() + 86_400_000 - 1) : null;
  const hasRange = !!(fromD || toD);

  const inRange = hasRange
    ? {
        $and: [
          fromD ? { $gte: ["$placedAt", fromD] } : true,
          toD ? { $lte: ["$placedAt", toD] } : true,
        ],
      }
    : null;

  const [row] = await CdoOrder.aggregate([
    { $match: { practitionerId } },
    {
      $group: {
        _id: null,
        lifetime: { $sum: REVENUE_EXPR },
        orderCount: { $sum: 1 },
        thisMonth: {
          $sum: { $cond: [{ $gte: ["$placedAt", thisMonth] }, REVENUE_EXPR, 0] },
        },
        lastMonth: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $gte: ["$placedAt", lastMonth] },
                  { $lt: ["$placedAt", thisMonth] },
                ],
              },
              REVENUE_EXPR,
              0,
            ],
          },
        },
        thisYear: {
          $sum: { $cond: [{ $gte: ["$placedAt", thisYear] }, REVENUE_EXPR, 0] },
        },
        range: { $sum: inRange ? { $cond: [inRange, REVENUE_EXPR, 0] } : 0 },
        rangeOrders: { $sum: inRange ? { $cond: [inRange, 1, 0] } : 0 },
      },
    },
  ]);

  return {
    lifetime: round2(row?.lifetime),
    thisMonth: round2(row?.thisMonth),
    lastMonth: round2(row?.lastMonth),
    thisYear: round2(row?.thisYear),
    range: hasRange ? round2(row?.range) : null,
    rangeOrderCount: hasRange ? row?.rangeOrders || 0 : null,
    orderCount: row?.orderCount || 0,
    currency: "USD",
  };
}

// ── Commissions ──────────────────────────────────────────────────────────────

// Bucket commissions by the accrual `status` lifecycle (pending → approved →
// paid, or reversed). See ns-retail's cdo.portal.service.js for the full
// reasoning — kept verbatim here since the schema is identical.
async function commissionTotals(practitionerId) {
  const rows = await CdoCommission.aggregate([
    { $match: { practitionerId } },
    {
      $group: {
        _id: null,
        paid: {
          $sum: { $cond: [{ $eq: ["$status", "paid"] }, "$amount", 0] },
        },
        pending: {
          $sum: { $cond: [{ $eq: ["$status", "pending"] }, "$amount", 0] },
        },
        awaitingPayout: {
          $sum: { $cond: [{ $eq: ["$status", "approved"] }, "$amount", 0] },
        },
        reversed: {
          $sum: { $cond: [{ $eq: ["$status", "reversed"] }, "$amount", 0] },
        },
        failed: {
          $sum: { $cond: [{ $eq: ["$payoutStatus", "failed"] }, "$amount", 0] },
        },
        count: { $sum: 1 },
      },
    },
  ]);
  const r = rows[0] || {};
  const paid = round2(r.paid);
  const pending = round2(r.pending);
  const awaitingPayout = round2(r.awaitingPayout);
  return {
    total: round2(paid + awaitingPayout + pending),
    paid,
    pending,
    awaitingPayout,
    reversed: round2(r.reversed),
    failed: round2(r.failed),
    count: r.count || 0,
  };
}

export async function getCommissions(
  practitionerId,
  { status, payoutStatus, patient, from, to, page, pageSize, pendingOnly } = {},
) {
  const match = { practitionerId };
  if (status) match.status = status;
  if (payoutStatus) match.payoutStatus = payoutStatus;
  if (pendingOnly) {
    match.payoutStatus = { $ne: "paid" };
  }
  const fromD = parseDate(from);
  const toParsed = parseDate(to);
  const toD = toParsed ? new Date(toParsed.getTime() + 86_400_000 - 1) : null;
  if (fromD || toD) {
    match.earnedAt = {};
    if (fromD) match.earnedAt.$gte = fromD;
    if (toD) match.earnedAt.$lte = toD;
  }

  if (patient && String(patient).trim()) {
    const orderIds = await CdoOrder.find({
      practitionerId,
      customerEmail: String(patient).trim().toLowerCase(),
    }).distinct("_id");
    match.orderId = { $in: orderIds };
  }

  const p = clampPage(page);
  const size = clampPageSize(pageSize);

  const [rows, total, totals, patients] = await Promise.all([
    CdoCommission.find(match)
      .sort({ earnedAt: -1, createdAt: -1 })
      .skip((p - 1) * size)
      .limit(size)
      .select(
        "orderName amount rate status payoutStatus payoutFailureReason earnedAt createdAt",
      )
      .lean(),
    CdoCommission.countDocuments(match),
    commissionTotals(practitionerId),
    listCommissionPatients(practitionerId),
  ]);

  return {
    rows: rows.map((r) => ({
      id: String(r._id),
      orderName: r.orderName,
      amount: round2(r.amount),
      rate: r.rate,
      status: r.status,
      payoutStatus: r.payoutStatus || null,
      payoutFailureReason: r.payoutFailureReason || null,
      earnedAt: r.earnedAt || r.createdAt || null,
    })),
    totals,
    patients,
    page: p,
    pageSize: size,
    total,
    totalPages: Math.max(1, Math.ceil(total / size)),
  };
}

// Distinct patients (by email) who have at least one commission — powers the
// Commission Summary "Patient" filter dropdown.
async function listCommissionPatients(practitionerId) {
  const rows = await CdoCommission.aggregate([
    { $match: { practitionerId, orderId: { $ne: null } } },
    {
      $lookup: {
        from: "cdo_orders",
        localField: "orderId",
        foreignField: "_id",
        as: "order",
      },
    },
    { $addFields: { order: { $arrayElemAt: ["$order", 0] } } },
    {
      $group: {
        _id: "$order.customerEmail",
        name: { $first: "$order.customerName" },
      },
    },
    { $match: { _id: { $ne: null } } },
    { $sort: { name: 1, _id: 1 } },
  ]);
  return rows
    .filter((r) => r._id)
    .map((r) => ({ value: r._id, label: r.name || r._id }));
}

// ── Payouts ──────────────────────────────────────────────────────────────────

// Per-payout commission breakdown — the order-level commissions that make up
// each payout, so a practitioner can reconcile what a payout paid for.
async function getPayoutBreakdowns(practitionerId, payoutIds) {
  const map = new Map();
  if (!payoutIds || payoutIds.length === 0) return map;

  const rows = await CdoCommission.aggregate([
    { $match: { practitionerId, payoutId: { $in: payoutIds } } },
    {
      $lookup: {
        from: "cdo_orders",
        localField: "orderId",
        foreignField: "_id",
        as: "order",
      },
    },
    { $addFields: { order: { $arrayElemAt: ["$order", 0] } } },
    { $sort: { earnedAt: -1, createdAt: -1 } },
    {
      $project: {
        payoutId: 1,
        orderName: 1,
        amount: 1,
        rate: 1,
        status: 1,
        orderDate: { $ifNull: ["$order.placedAt", "$earnedAt"] },
        customerName: {
          $ifNull: ["$order.customerName", "$order.customer.name"],
        },
        revenue: {
          $ifNull: ["$order.pricing.total", { $ifNull: ["$order.amount", 0] }],
        },
      },
    },
  ]);

  for (const r of rows) {
    const key = String(r.payoutId);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      id: String(r._id),
      orderName: r.orderName || null,
      orderDate: r.orderDate || null,
      customerName: r.customerName || null,
      revenue: round2(r.revenue),
      rate: r.rate,
      amount: round2(r.amount),
      status: r.status || null,
    });
  }
  return map;
}

export async function getPayouts(
  practitionerId,
  { status, from, to, page, pageSize } = {},
) {
  const match = { practitionerId };
  if (status) match.status = status;
  const fromD = parseDate(from);
  const toParsed = parseDate(to);
  const toD = toParsed ? new Date(toParsed.getTime() + 86_400_000 - 1) : null;
  if (fromD || toD) {
    match.paidAt = {};
    if (fromD) match.paidAt.$gte = fromD;
    if (toD) match.paidAt.$lte = toD;
  }

  const p = clampPage(page);
  const size = clampPageSize(pageSize);

  const [docs, total] = await Promise.all([
    CdoPayout.find(match)
      .sort({ paidAt: -1, createdAt: -1 })
      .skip((p - 1) * size)
      .limit(size)
      .select(
        "amount currency method status reference qboBillId paidAt createdAt periodStart periodEnd rejectionReason commissionIds",
      )
      .lean(),
    CdoPayout.countDocuments(match),
  ]);

  const breakdowns = await getPayoutBreakdowns(
    practitionerId,
    docs.map((d) => d._id),
  );

  return {
    rows: docs.map((r) => ({
      id: String(r._id),
      date: r.paidAt || r.createdAt || null,
      amount: round2(r.amount),
      currency: r.currency || "USD",
      method: r.method || null,
      status: r.status || null,
      reference: r.reference || null,
      transactionId: r.qboBillId || null,
      periodStart: r.periodStart || null,
      periodEnd: r.periodEnd || null,
      rejectionReason: r.rejectionReason || null,
      breakdown: breakdowns.get(String(r._id)) || [],
    })),
    page: p,
    pageSize: size,
    total,
    totalPages: Math.max(1, Math.ceil(total / size)),
  };
}

// ── Referred customers (patients) ────────────────────────────────────────────

export async function getReferredCustomers(
  practitionerId,
  { search, page, pageSize } = {},
) {
  const match = { practitionerId };
  if (search && String(search).trim()) {
    const re = new RegExp(escapeRegex(String(search).trim()), "i");
    match.$or = [{ referredName: re }, { referredEmail: re }];
  }

  const p = clampPage(page);
  const size = clampPageSize(pageSize);

  const [result] = await CdoReferral.aggregate([
    { $match: match },
    { $sort: { referredAt: -1, createdAt: -1 } },
    {
      $group: {
        _id: {
          $cond: [
            { $gt: [{ $strLenCP: { $ifNull: ["$referredEmail", ""] } }, 0] },
            "$referredEmail",
            { $concat: ["ref:", { $toString: "$_id" }] },
          ],
        },
        refId: { $first: "$_id" },
        pid: { $first: "$practitionerId" },
        referredName: { $first: "$referredName" },
        referredEmail: { $first: "$referredEmail" },
        registeredAt: { $min: "$referredAt" },
        lastReferredAt: { $max: "$referredAt" },
        codes: {
          $push: {
            code: "$referralCode",
            status: "$status",
            usedAt: "$referredAt",
          },
        },
      },
    },
    { $sort: { lastReferredAt: -1, refId: -1 } },
    {
      $lookup: {
        from: "cdo_orders",
        let: { email: "$referredEmail", pid: "$pid" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$customerEmail", "$$email"] },
                  { $eq: ["$practitionerId", "$$pid"] },
                ],
              },
            },
          },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              ltv: { $sum: REVENUE_EXPR },
            },
          },
        ],
        as: "orderAgg",
      },
    },
    {
      $addFields: {
        totalOrders: { $ifNull: [{ $arrayElemAt: ["$orderAgg.count", 0] }, 0] },
        lifetimeValue: {
          $ifNull: [{ $arrayElemAt: ["$orderAgg.ltv", 0] }, 0],
        },
      },
    },
    {
      // The AUTHORITATIVE current/active code lives on cdo_applications.referral
      // (this is what the practitioner reassigns via "Assign discount code", and
      // what order attribution + the discount Function honor). It is NOT written
      // back to cdo_referrals, so we must read it here or the tab shows the stale
      // first-touch code. cdo_applications isn't mirrored as a model in wholesale,
      // but a $lookup addresses the collection by name (same as the cdo_orders
      // lookup above) — no model needed. Matched by email (case-insensitive).
      $lookup: {
        from: "cdo_applications",
        let: { email: "$referredEmail" },
        pipeline: [
          {
            $match: {
              $expr: {
                $eq: [
                  { $toLower: { $ifNull: ["$email", ""] } },
                  { $toLower: { $ifNull: ["$$email", ""] } },
                ],
              },
            },
          },
          {
            $project: {
              _id: 0,
              code: "$referral.code",
              history: { $ifNull: ["$referralHistory", []] },
            },
          },
          { $limit: 1 },
        ],
        as: "appAgg",
      },
    },
    {
      $addFields: {
        currentCode: { $ifNull: [{ $arrayElemAt: ["$appAgg.code", 0] }, null] },
        appHistory: { $ifNull: [{ $arrayElemAt: ["$appAgg.history", 0] }, []] },
      },
    },
    {
      $facet: {
        rows: [
          { $skip: (p - 1) * size },
          { $limit: size },
          {
            $project: {
              refId: 1,
              referredName: 1,
              referredEmail: 1,
              registeredAt: 1,
              totalOrders: 1,
              lifetimeValue: 1,
              codes: 1,
              currentCode: 1,
              appHistory: 1,
            },
          },
        ],
        total: [{ $count: "n" }],
      },
    },
  ]);

  const total = result?.total?.[0]?.n || 0;
  return {
    rows: (result?.rows || []).map((r) => {
      const seen = new Set();
      const codes = [];
      const pushCode = (code, status, usedAt) => {
        if (!code) return;
        const key = normalizeReferralCode(code) || String(code).toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        codes.push({ code, status: status || null, usedAt: usedAt || null });
      };
      // The assigned/active code (cdo_applications.referral.code) is the source
      // of truth; fall back to the newest cdo_referrals row when a patient was
      // attributed at checkout without an application. It ALWAYS goes first so
      // the "Latest" row + the Code column reflect what the practitioner
      // assigned — even when that code has no conversion row in cdo_referrals.
      const currentCode = r.currentCode || (r.codes || [])[0]?.code || null;
      pushCode(currentCode, "active", null);
      // Then codes seen on actual conversions, then prior codes from history.
      for (const c of r.codes || []) pushCode(c.code, c.status, c.usedAt);
      for (const h of r.appHistory || []) pushCode(h.code, "replaced", h.replacedAt);
      return {
        id: String(r.refId),
        name: r.referredName || null,
        email: r.referredEmail || null,
        referralCode: currentCode,
        codes,
        registeredAt: r.registeredAt || null,
        totalOrders: r.totalOrders || 0,
        lifetimeValue: round2(r.lifetimeValue),
      };
    }),
    page: p,
    pageSize: size,
    total,
    totalPages: Math.max(1, Math.ceil(total / size)),
  };
}

// ── Referral codes + per-code usage ──────────────────────────────────────────

export async function getReferralCodes(practitionerId, { page, pageSize } = {}) {
  const p = clampPage(page);
  const size = clampPageSize(pageSize);

  const [total, usedRaw] = await Promise.all([
    CdoPractitionerCode.countDocuments({ practitionerId }),
    CdoPractitionerCode.find({ practitionerId, status: "active" }).distinct(
      "discountPercent",
    ),
  ]);
  const usedActivePercents = usedRaw
    .map((v) => Math.round((Number(v) || 0) * 100))
    .filter((n) => n > 0);

  const base = {
    rows: [],
    usedActivePercents,
    page: p,
    pageSize: size,
    total,
    totalPages: Math.max(1, Math.ceil(total / size)),
  };

  const codes = await CdoPractitionerCode.find({ practitionerId })
    .sort({ isPrimary: -1, createdAt: 1 })
    .skip((p - 1) * size)
    .limit(size)
    .lean();

  if (codes.length === 0) return base;

  const [orderStats, referralStats] = await Promise.all([
    CdoOrder.aggregate([
      { $match: { practitionerId } },
      {
        $group: {
          _id: "$referralCode",
          orders: { $sum: 1 },
          revenue: { $sum: REVENUE_EXPR },
          commission: { $sum: { $ifNull: ["$commissionAmount", 0] } },
        },
      },
    ]),
    CdoReferral.aggregate([
      { $match: { practitionerId } },
      { $group: { _id: "$referralCode", referrals: { $sum: 1 } } },
    ]),
  ]);

  const byCodeOrders = new Map(
    orderStats.map((s) => [String(s._id || "").toLowerCase(), s]),
  );
  const byCodeReferrals = new Map(
    referralStats.map((s) => [String(s._id || "").toLowerCase(), s]),
  );

  base.rows = codes.map((c) => {
    const key = String(c.code || "").toLowerCase();
    const o = byCodeOrders.get(key) || {};
    const r = byCodeReferrals.get(key) || {};
    return {
      id: String(c._id),
      code: c.code,
      isPrimary: !!c.isPrimary,
      status: c.status || null,
      discountPercent: c.discountPercent || 0,
      commissionRate: c.commissionRate ?? null,
      referrals: r.referrals || 0,
      orders: o.orders || 0,
      revenue: round2(o.revenue),
      commission: round2(o.commission),
      referralUrl: c.shopifyDiscountUrl || null,
    };
  });
  return base;
}

// ── Referral code self-service (practitioner WRITE paths) ────────────────────
//
// The portal lets a practitioner create their own referral codes + links and
// pause/resume them. These are the ONLY write paths in the portal. Every
// query is still scoped by the trusted `practitionerId` (the guard's tenant
// key) — identity is never taken from the request body. Each created code is
// backed by a real Shopify discount on the RETAIL store (created via
// cdo.service.js's direct-token GraphQL client) so the generated link works
// at checkout there.

// The discount tiers offered in the portal dropdown (integer percents). Kept
// in sync with the frontend's own DISCOUNT_PERCENTS (the storefront bundle
// can't import server modules) — update both if this list changes.
export const PORTAL_DISCOUNT_PERCENTS = [10, 15, 20, 25, 30, 35, 40];

// 3–40 chars, lowercase alphanumeric + hyphen/underscore, starting alphanumeric.
const CODE_RE = /^[a-z0-9][a-z0-9_-]{2,39}$/;

// Typed error the thin route handler maps to an HTTP status:
//   INVALID         → 400   (bad code/percent/id)
//   CONFLICT        → 409   (code taken / tier already active)
//   DISCOUNT_FAILED → 502   (Shopify discount write failed)
function portalError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Shape a CdoPractitionerCode doc into the row the dashboard renders
// (matching getReferralCodes()'s row shape). Usage stats are zeroed — the
// frontend reloads the full list (with aggregated stats) right after a
// mutation.
function shapeCodeRow(c) {
  return {
    id: String(c._id),
    code: c.code,
    isPrimary: !!c.isPrimary,
    status: c.status || null,
    discountPercent: c.discountPercent || 0,
    commissionRate: c.commissionRate ?? null,
    referrals: 0,
    orders: 0,
    revenue: 0,
    commission: 0,
    referralUrl: c.shopifyDiscountUrl || null,
  };
}

/**
 * Create a practitioner-owned referral code + its Shopify discount link on
 * the retail store.
 *
 * Rules enforced (server-side is authoritative):
 *   - code: valid format AND unique store-wide (catalogue + Shopify).
 *   - discountPercent: one of PORTAL_DISCOUNT_PERCENTS.
 *   - at most ONE active code per discount tier for this practitioner.
 *
 * The DB row is the atomic claim (unique {shop, code} index); if the Shopify
 * discount can't be created (real failure OR the code already exists on
 * Shopify) the row is rolled back so a code never lingers without a live
 * link.
 *
 * @param {string} practitionerId            trusted tenant key (from the guard)
 * @param {{ code: string, discountPercent: number }} input  discountPercent = integer percent
 * @param {{ application: object }} ctx
 * @returns {Promise<object>} the new code row (getReferralCodes row shape)
 * @throws {Error & { code: 'INVALID'|'CONFLICT'|'DISCOUNT_FAILED' }}
 */
export async function createReferralCode(
  practitionerId,
  { code, discountPercent } = {},
  { application } = {},
) {
  const raw = normalizeReferralCode(code);
  if (!CODE_RE.test(raw)) {
    throw portalError(
      "INVALID",
      "Code must be 3–40 characters using lowercase letters, numbers, hyphens or underscores, and start with a letter or number.",
    );
  }

  const pct = Number(discountPercent);
  if (!PORTAL_DISCOUNT_PERCENTS.includes(pct)) {
    throw portalError(
      "INVALID",
      `Discount must be one of: ${PORTAL_DISCOUNT_PERCENTS.map((p) => `${p}%`).join(", ")}.`,
    );
  }
  const fraction = pct / 100;

  // Rule A — one ACTIVE code per discount tier (paused/archived don't count).
  const tierClash = await CdoPractitionerCode.findOne({
    practitionerId,
    status: "active",
    discountPercent: fraction,
  })
    .select("code")
    .lean();
  if (tierClash) {
    throw portalError(
      "CONFLICT",
      `You already have an active code at ${pct}% (${tierClash.code}). Pause it first to create another at this discount.`,
    );
  }

  // Rule B — store-wide code uniqueness (our catalogue; Shopify is checked at
  // discount-create time below). Case-insensitive exact match.
  const codeClash = await CdoPractitionerCode.findOne({
    code: { $regex: `^${escapeRegex(raw)}$`, $options: "i" },
  })
    .select("_id")
    .lean();
  if (codeClash) {
    throw portalError("CONFLICT", `The code "${raw}" is already taken. Choose another.`);
  }

  const fullName =
    [application?.firstName, application?.lastName].filter(Boolean).join(" ").trim() ||
    application?.businessName ||
    null;

  let created;
  try {
    created = await CdoPractitionerCode.create({
      shop: application?.shop || null,
      practitionerId,
      practitionerEmail: application?.email || null,
      practitionerName: fullName,
      code: raw,
      isPrimary: false,
      discountPercent: fraction,
      commissionRate: null,
      status: "active",
      createdBy: "portal-self-service",
      updatedBy: "portal-self-service",
    });
  } catch (err) {
    if (err?.code === 11000) {
      throw portalError("CONFLICT", `The code "${raw}" is already taken. Choose another.`);
    }
    throw err;
  }

  // Create the Shopify discount on the retail store. Roll back the row on
  // any failure so we never leave a code with a dead/absent link.
  const disc = await createRetailDiscount({
    code: raw,
    discountPercent: fraction,
    practitionerId,
    practitionerName: fullName,
  });

  if (!disc.ok || disc.duplicate) {
    await CdoPractitionerCode.deleteOne({ _id: created._id });
    if (disc.duplicate) {
      throw portalError("CONFLICT", `The code "${raw}" is already taken. Choose another.`);
    }
    log.error("create_referral.discount_failed", {
      practitionerId,
      code: raw,
      err: disc.error,
    });
    throw portalError(
      "DISCOUNT_FAILED",
      "We couldn't create the discount on the store. Please try again.",
    );
  }

  await CdoPractitionerCode.updateOne(
    { _id: created._id },
    {
      $set: {
        shopifyDiscountId: disc.shopifyDiscountId || null,
        shopifyDiscountUrl: disc.shopifyDiscountUrl || null,
      },
    },
  );
  created.shopifyDiscountId = disc.shopifyDiscountId || null;
  created.shopifyDiscountUrl = disc.shopifyDiscountUrl || null;

  log.info("create_referral.ok", {
    practitionerId,
    code: raw,
    discountPercent: fraction,
  });

  // Archive nudge: return the practitioner's OTHER active codes alongside the
  // new one so the portal can prompt "you now have N active codes — archive
  // the older ones?" with a one-click archive.
  const otherActive = await CdoPractitionerCode.find({
    practitionerId,
    status: "active",
    _id: { $ne: created._id },
  })
    .sort({ createdAt: -1 })
    .lean();

  const row = shapeCodeRow(created);
  row.otherActiveCodes = otherActive.map((c) => shapeCodeRow(c));

  // Best-effort — never blocks the already-created code on an SMTP hiccup.
  await notifyReferralCodeCreated({
    email: application?.email,
    practitionerName: fullName,
    code: raw,
    discountPercent: fraction,
    referralUrl: row.referralUrl,
  }).catch((e) => log.error("create_referral.notification_failed", { err: e?.message || e }));

  return row;
}

/**
 * Pause or resume a practitioner's referral code. Pausing deactivates the
 * retail Shopify discount (the link stops applying) and frees its discount
 * tier for re-use; resuming reactivates it. The Shopify toggle runs FIRST so
 * the DB status and the storefront never disagree.
 *
 * @param {string} practitionerId        trusted tenant key (from the guard)
 * @param {{ codeId: string, status: 'active'|'paused' }} input
 * @returns {Promise<object>} the updated code row
 * @throws {Error & { code: 'INVALID'|'CONFLICT'|'DISCOUNT_FAILED' }}
 */
export async function setReferralCodeStatus(practitionerId, { codeId, status } = {}) {
  if (status !== "active" && status !== "paused") {
    throw portalError("INVALID", "Invalid status.");
  }
  if (!codeId) throw portalError("INVALID", "A code id is required.");

  let doc;
  try {
    doc = await CdoPractitionerCode.findOne({ _id: codeId, practitionerId });
  } catch {
    doc = null;
  }
  if (!doc) throw portalError("INVALID", "Referral code not found.");
  if (doc.status === "archived") {
    throw portalError("INVALID", "Archived codes can't be changed.");
  }

  if (doc.status === status) return shapeCodeRow(doc);

  if (status === "active") {
    const clash = await CdoPractitionerCode.findOne({
      practitionerId,
      status: "active",
      discountPercent: doc.discountPercent,
      _id: { $ne: doc._id },
    })
      .select("code")
      .lean();
    if (clash) {
      const pct = Math.round((doc.discountPercent || 0) * 100);
      throw portalError(
        "CONFLICT",
        `You already have an active code at ${pct}% (${clash.code}). Pause it first.`,
      );
    }
  }

  if (doc.shopifyDiscountId) {
    const r = await setRetailDiscountActive({
      discountId: doc.shopifyDiscountId,
      active: status === "active",
    });
    if (!r.ok) {
      log.error("set_status.discount_failed", {
        practitionerId,
        codeId: String(doc._id),
        status,
        err: r.error,
      });
      throw portalError(
        "DISCOUNT_FAILED",
        "We couldn't update the discount on the store. Please try again.",
      );
    }
  }

  doc.status = status;
  doc.updatedBy = "portal-self-service";
  await doc.save();
  log.info("set_status.ok", { practitionerId, codeId: String(doc._id), status });

  // Best-effort — never blocks the already-applied status change.
  const notify = status === "active" ? notifyReferralCodeResumed : notifyReferralCodePaused;
  await notify({
    email: doc.practitionerEmail,
    practitionerName: doc.practitionerName,
    code: doc.code,
    discountPercent: doc.discountPercent,
  }).catch((e) => log.error("set_status.notification_failed", { err: e?.message || e }));

  return shapeCodeRow(doc);
}

/**
 * Assign/reassign the ACTIVE discount code for one of the practitioner's
 * patients (Patients tab → "Change code"). The authoritative write lives in
 * ns-retail (it owns cdo_applications + the retail Shopify customer), so this
 * only validates + orchestrates: it re-checks the code is one of THIS
 * practitioner's active codes (defense in depth), then POSTs to the ns-retail
 * internal endpoint, which reassigns cdo_applications.referral, sets the
 * customer `cdo.active_code` metafield the discount Function enforces, and
 * syncs the `code:` tag. The patient must already be attributed to this
 * practitioner (ns-retail rejects otherwise) — this never attributes a new
 * patient or steals another practitioner's.
 *
 * @param {string} practitionerId  trusted tenant key (from the guard)
 * @param {{ referredEmail: string, codeId: string }} input
 * @param {{ application: object }} ctx
 * @returns {Promise<{ email: string, code: string, previousCode: string|null }>}
 * @throws {Error & { code: 'INVALID'|'CONFLICT'|'DISCOUNT_FAILED' }}
 */
export async function assignPatientCode(
  practitionerId,
  { referredEmail, codeId } = {},
  { application } = {},
) {
  const email = String(referredEmail || "").trim().toLowerCase();
  if (!email) throw portalError("INVALID", "Patient email is required.");
  if (!codeId) throw portalError("INVALID", "Select a discount code to assign.");

  // Defense in depth: the code must be one of THIS practitioner's ACTIVE codes.
  // (ns-retail re-validates authoritatively, but fail fast with a clear message.)
  const codeDoc = await CdoPractitionerCode.findOne({ _id: codeId, practitionerId })
    .lean()
    .catch(() => null);
  if (!codeDoc) throw portalError("INVALID", "That discount code isn't one of yours.");
  if (codeDoc.status !== "active") {
    throw portalError("CONFLICT", `"${codeDoc.code}" isn't active — resume it or pick another code.`);
  }

  if (!isFulfillmentSyncEnabled()) {
    throw portalError(
      "DISCOUNT_FAILED",
      "Code assignment is temporarily unavailable — the retail link is not configured.",
    );
  }

  const url = `${syncConfig.nsRetailApiBase.replace(/\/+$/, "")}/api/cdo-internal/assign-patient-code`;
  let res;
  let data;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-sync-secret": syncConfig.syncSecret,
      },
      body: JSON.stringify({
        practitionerId: String(practitionerId),
        referredEmail: email,
        codeId: String(codeId),
        shop: syncConfig.retailShop,
        actor: application?.email || "practitioner",
      }),
      signal: AbortSignal.timeout(syncConfig.fulfillmentSyncTimeoutMs),
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    log.error("assign_patient_code.network", { practitionerId, email, err: e?.message || e });
    throw portalError("DISCOUNT_FAILED", "Could not reach the assignment service. Please try again.");
  }

  if (!res.ok || data?.status !== "success") {
    const msg = data?.message || "Could not assign the discount code.";
    if (res.status === 409) throw portalError("CONFLICT", msg);
    if (res.status === 400) throw portalError("INVALID", msg);
    throw portalError("DISCOUNT_FAILED", msg);
  }

  return {
    email,
    code: data?.result?.code || codeDoc.code,
    previousCode: data?.result?.oldCode || null,
  };
}
