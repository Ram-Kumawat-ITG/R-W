// Practitioner Portal service — all read-only aggregation/query logic for
// the practitioner dashboard (Customer Account UI extension, full-page).
//
// PROJECT LAW: API handlers under app/api/portal/ are thin — they auth,
// validate, call one of these functions, and shape the response. All
// business logic lives here.
//
// SECURITY MODEL (the core requirement of this feature):
//   Identity is NEVER trusted from the client. The portal guard verifies
//   the customer-account session-token JWT (authenticate.public.customerAccount)
//   and passes its `sub` claim (the logged-in customer's GID) to
//   `resolvePractitionerByCustomerGid`, which maps it to an APPROVED
//   WholesaleApplication and uses that application's _id as the tenant key.
//   Every cdo_* query below is scoped by { practitionerId } so a
//   practitioner can only ever see their own data.

import WholesaleApplication from "../../models/wholesaleApplication.server";
import CdoPractitionerCode from "../../models/cdoPractitionerCode.server";
import CdoOrder from "../../models/cdoOrder.server";
import CdoCommission from "../../models/cdoCommission.server";
import CdoPayout from "../../models/cdoPayout.server";
import CdoReferral from "../../models/cdoReferral.server";

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

/**
 * Resolve a logged-in Shopify customer (by GID) to an approved practitioner.
 * The customer GID comes from the verified session-token `sub` claim — the
 * caller (portal guard) is responsible for validating the JWT first; this
 * function never trusts a raw request. Throws a typed Error on failure:
 *   - code 'UNAUTHENTICATED' → no customer GID (anonymous / sub claim absent)
 *   - code 'FORBIDDEN'       → logged in, but not an approved practitioner
 *
 * `sessionToken.sub` is already in `gid://shopify/Customer/<id>` form, which
 * matches how `wholesale_applications.customerId` is stored.
 *
 * @param {string} customerGid - gid://shopify/Customer/<id> (session token `sub`)
 * @returns {Promise<{ practitionerId: string, application: object }>}
 */
export async function resolvePractitionerByCustomerGid(customerGid) {
  if (!customerGid) {
    const e = new Error("Not logged in");
    e.code = ERR_UNAUTHENTICATED;
    throw e;
  }

  const application = await WholesaleApplication.findOne({
    customerId: customerGid,
    status: "approved",
  }).lean();

  if (!application) {
    const e = new Error("Not an approved practitioner");
    e.code = ERR_FORBIDDEN;
    throw e;
  }

  return { practitionerId: String(application._id), application };
}

resolvePractitionerByCustomerGid.ERR_UNAUTHENTICATED = ERR_UNAUTHENTICATED;
resolvePractitionerByCustomerGid.ERR_FORBIDDEN = ERR_FORBIDDEN;

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
    CdoReferral.countDocuments({ practitionerId }),
    commissionTotals(practitionerId),
  ]);

  return {
    referredPatients,
    lifetimeRevenue: revenue.lifetime,
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
  const toD = parseDate(to);

  const rangeCond =
    fromD || toD
      ? {
          $cond: [
            {
              $and: [
                fromD ? { $gte: ["$placedAt", fromD] } : true,
                toD ? { $lte: ["$placedAt", toD] } : true,
              ],
            },
            REVENUE_EXPR,
            0,
          ],
        }
      : { $literal: 0 };

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
        range: { $sum: rangeCond },
      },
    },
  ]);

  return {
    lifetime: round2(row?.lifetime),
    thisMonth: round2(row?.thisMonth),
    lastMonth: round2(row?.lastMonth),
    thisYear: round2(row?.thisYear),
    range: fromD || toD ? round2(row?.range) : null,
    orderCount: row?.orderCount || 0,
    currency: "USD",
  };
}

// ── Commissions ──────────────────────────────────────────────────────────────

// Bucket commissions into the four states the dashboard cares about:
//   paid           → payoutStatus === 'paid'
//   pending        → status === 'pending' (not yet earned/approved for payout)
//   awaitingPayout → earned (status 'paid') but payout not completed
//   failed         → payoutStatus === 'failed' (subset, surfaced separately)
async function commissionTotals(practitionerId) {
  const rows = await CdoCommission.aggregate([
    { $match: { practitionerId } },
    {
      $group: {
        _id: null,
        total: { $sum: "$amount" },
        paid: {
          $sum: { $cond: [{ $eq: ["$payoutStatus", "paid"] }, "$amount", 0] },
        },
        pending: {
          $sum: { $cond: [{ $eq: ["$status", "pending"] }, "$amount", 0] },
        },
        awaitingPayout: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$status", "paid"] },
                  { $ne: ["$payoutStatus", "paid"] },
                ],
              },
              "$amount",
              0,
            ],
          },
        },
        failed: {
          $sum: { $cond: [{ $eq: ["$payoutStatus", "failed"] }, "$amount", 0] },
        },
        count: { $sum: 1 },
      },
    },
  ]);
  const r = rows[0] || {};
  return {
    total: round2(r.total),
    paid: round2(r.paid),
    pending: round2(r.pending),
    awaitingPayout: round2(r.awaitingPayout),
    failed: round2(r.failed),
    count: r.count || 0,
  };
}

export async function getCommissions(
  practitionerId,
  { status, from, to, page, pageSize, pendingOnly } = {},
) {
  const match = { practitionerId };
  if (status) match.status = status;
  if (pendingOnly) {
    // "Pending commissions" view: earned-but-not-paid-out.
    match.payoutStatus = { $ne: "paid" };
  }
  const fromD = parseDate(from);
  const toD = parseDate(to);
  if (fromD || toD) {
    match.earnedAt = {};
    if (fromD) match.earnedAt.$gte = fromD;
    if (toD) match.earnedAt.$lte = toD;
  }

  const p = clampPage(page);
  const size = clampPageSize(pageSize);

  const [rows, total, totals] = await Promise.all([
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
    page: p,
    pageSize: size,
    total,
    totalPages: Math.max(1, Math.ceil(total / size)),
  };
}

// ── Payouts ──────────────────────────────────────────────────────────────────

export async function getPayouts(
  practitionerId,
  { status, from, to, page, pageSize } = {},
) {
  const match = { practitionerId };
  if (status) match.status = status;
  const fromD = parseDate(from);
  const toD = parseDate(to);
  if (fromD || toD) {
    match.paidAt = {};
    if (fromD) match.paidAt.$gte = fromD;
    if (toD) match.paidAt.$lte = toD;
  }

  const p = clampPage(page);
  const size = clampPageSize(pageSize);

  const [rows, total] = await Promise.all([
    CdoPayout.find(match)
      .sort({ paidAt: -1, createdAt: -1 })
      .skip((p - 1) * size)
      .limit(size)
      .select(
        "amount currency method status reference qboBillId paidAt createdAt periodStart periodEnd rejectionReason",
      )
      .lean(),
    CdoPayout.countDocuments(match),
  ]);

  return {
    rows: rows.map((r) => ({
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
      $lookup: {
        from: "cdo_orders",
        let: { email: "$referredEmail", pid: "$practitionerId" },
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
      $facet: {
        rows: [
          { $skip: (p - 1) * size },
          { $limit: size },
          {
            $project: {
              referredName: 1,
              referredEmail: 1,
              referralCode: 1,
              status: 1,
              referredAt: 1,
              convertedAt: 1,
              totalOrders: 1,
              lifetimeValue: 1,
            },
          },
        ],
        total: [{ $count: "n" }],
      },
    },
  ]);

  const total = result?.total?.[0]?.n || 0;
  return {
    rows: (result?.rows || []).map((r) => ({
      id: String(r._id),
      name: r.referredName || null,
      email: r.referredEmail || null,
      referralCode: r.referralCode || null,
      status: r.status || null,
      registeredAt: r.referredAt || null,
      convertedAt: r.convertedAt || null,
      totalOrders: r.totalOrders || 0,
      lifetimeValue: round2(r.lifetimeValue),
    })),
    page: p,
    pageSize: size,
    total,
    totalPages: Math.max(1, Math.ceil(total / size)),
  };
}

// ── Referral codes + per-code usage ──────────────────────────────────────────

// Aggregate order-derived usage stats grouped by referral code, then merge
// with the practitioner's code list. Commission-per-code is summed from
// cdo_orders.commissionAmount (commissions link to orders, not codes).
export async function getReferralCodes(practitionerId) {
  const codes = await CdoPractitionerCode.find({ practitionerId })
    .sort({ isPrimary: -1, createdAt: 1 })
    .lean();

  if (codes.length === 0) return { rows: [] };

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

  return {
    rows: codes.map((c) => {
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
      };
    }),
  };
}

// ── Discounts & promotions (derived from practitioner codes) ─────────────────

export async function getDiscounts(practitionerId) {
  const codes = await CdoPractitionerCode.find({ practitionerId }).lean();
  if (codes.length === 0) return { rows: [] };

  const usage = await CdoOrder.aggregate([
    { $match: { practitionerId } },
    { $group: { _id: "$referralCode", count: { $sum: 1 } } },
  ]);
  const usageByCode = new Map(
    usage.map((u) => [String(u._id || "").toLowerCase(), u.count]),
  );

  return {
    rows: codes.map((c) => ({
      id: String(c._id),
      code: c.code,
      type: "Percentage",
      value: round2((c.discountPercent || 0) * 100),
      status: c.status === "active" ? "Active" : "Inactive",
      usageCount: usageByCode.get(String(c.code || "").toLowerCase()) || 0,
      // ns-retail practitioner codes have no expiry in the current schema.
      expiresAt: null,
    })),
  };
}
