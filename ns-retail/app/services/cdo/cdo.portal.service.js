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

import { unauthenticated } from "../../shopify.server";
import { createLogger } from "../../utils/logger.utils";
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

const log = createLogger("cdo.portal.service");

// Tags a Shopify customer MUST carry (BOTH) to access the Practitioner Portal.
// Matched case-insensitively and as EXACT whole tags — "archived-practitioner"
// or "wholesale-Practitioner" must NOT satisfy "practitioner".
const REQUIRED_PORTAL_TAGS = ["practitioner", "approved"];

// True only when `tags` contains every required tag (case-insensitive, exact).
export function hasRequiredPortalTags(tags) {
  if (!Array.isArray(tags)) return false;
  const owned = new Set(tags.map((t) => String(t).trim().toLowerCase()));
  return REQUIRED_PORTAL_TAGS.every((t) => owned.has(t));
}

// Look up a customer's email + tags on a given shop via the Admin GraphQL API.
//
// Two jobs:
//  1. AUTHORIZATION — `tags` is the source of truth for portal access (the
//     customer must carry BOTH "Practitioner" and "Approved"). Read from
//     Shopify (trusted), NEVER from the client or any MongoDB mirror.
//  2. IDENTITY BRIDGE — a wholesale_application's `customerId` is the customer
//     GID ON THE WHOLESALE STORE, but the portal runs on the ns-retail store,
//     where the same person has a DIFFERENT customer GID. Customer GIDs are
//     per-store; email is the stable, store-independent key.
//
// Requires the `read_customers` (or `write_customers`) scope + an installed
// offline session for `shop`. Returns null on any failure (caller denies).
//
// NO CACHING — this is a LIVE, real-time read on EVERY request, by design, so
// access is always decided on the customer's CURRENT Shopify tags. A tag
// added/removed in Shopify takes effect on the very next portal request (e.g.
// revoking "Approved" denies access immediately). The portal is low-traffic
// (a practitioner navigating a few tabs), so the per-call Admin query is a fine
// trade for never granting access on stale data.
async function fetchCustomerByGid(shop, customerGid) {
  if (!shop || !customerGid) return null;

  // unauthenticated.admin expects a bare shop domain (no protocol).
  let shopDomain = String(shop);
  try {
    if (/^https?:\/\//i.test(shopDomain)) shopDomain = new URL(shopDomain).host;
  } catch {
    /* use as-is */
  }
  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    const resp = await admin.graphql(
      `#graphql
       query PortalCustomer($id: ID!) {
         customer(id: $id) { email tags }
       }`,
      { variables: { id: customerGid } },
    );
    const body = await resp.json();
    const customer = body?.data?.customer;
    if (!customer) {
      log.info("resolve.customer_not_found", { shop: shopDomain, customerGid });
      return null;
    }
    return {
      email: customer.email || null,
      tags: Array.isArray(customer.tags) ? customer.tags : [],
    };
  } catch (e) {
    log.warn("resolve.customer_lookup_failed", {
      shop: shopDomain,
      err: e?.message || String(e),
    });
    return null;
  }
}

/**
 * Resolve a logged-in Shopify customer (by GID) to an approved practitioner,
 * enforcing the Practitioner-Portal access policy. The customer GID comes from
 * the verified session-token `sub` claim — the caller (portal guard) validates
 * the JWT first; this function never trusts a raw request. Throws a typed
 * Error on failure:
 *   - code 'UNAUTHENTICATED' → no customer GID (anonymous / sub claim absent)
 *   - code 'FORBIDDEN'       → logged in, but not authorized for the portal
 *
 * ACCESS POLICY (enforced on EVERY request, before any portal data is read):
 *   1. The customer must carry BOTH the "Practitioner" AND "Approved" tags on
 *      the store the portal runs on. Tags are read from Shopify (trusted) —
 *      never the client — and matched case-insensitively as exact whole tags.
 *   2. The customer must resolve to an APPROVED WholesaleApplication, whose
 *      _id is the tenant key (`practitionerId`) every cdo_* query scopes by.
 *   Both must hold; either failing → FORBIDDEN.
 *
 * `sessionToken.sub` is `gid://shopify/Customer/<id>` ON THE STORE THE PORTAL
 * RUNS ON (ns-retail). Customer GIDs are per-store, so we bridge to the
 * wholesale application by the customer's email (store-independent), resolved
 * from Shopify in the same lookup that reads the tags.
 *
 * @param {string} customerGid - gid://shopify/Customer/<id> (session token `sub`)
 * @param {string} [shop] - session token `dest` (the store the portal runs on),
 *   used to read the customer's tags + email via the Admin API.
 * @returns {Promise<{ practitionerId: string, application: object }>}
 */
export async function resolvePractitionerByCustomerGid(customerGid, shop) {
  if (!customerGid) {
    const e = new Error("Not logged in");
    e.code = ERR_UNAUTHENTICATED;
    throw e;
  }

  // Read the authoritative customer record (tags + email) from Shopify. This
  // is REQUIRED on every request — tags are the access gate and can't be
  // trusted from the client. If we can't read it, we can't authorize → deny.
  const customer = await fetchCustomerByGid(shop, customerGid);
  if (!customer) {
    const e = new Error("Could not verify your account");
    e.code = ERR_FORBIDDEN;
    throw e;
  }

  // GATE 1 — required tags. Must carry BOTH "Practitioner" and "Approved".
  if (!hasRequiredPortalTags(customer.tags)) {
    log.info("resolve.missing_required_tags", {
      customerGid,
      tags: customer.tags,
    });
    const e = new Error("Not an approved practitioner");
    e.code = ERR_FORBIDDEN;
    throw e;
  }

  // GATE 2 — resolve the tenant key. Try a direct GID match first (covers a
  // same-store setup), then bridge by email (the ns-retail case). Email match
  // is case-insensitive + anchored (exact email, not substring).
  let application = await WholesaleApplication.findOne({
    customerId: customerGid,
    status: "approved",
  }).lean();

  if (!application && customer.email) {
    const exact = new RegExp(`^${escapeRegex(customer.email.trim())}$`, "i");
    application = await WholesaleApplication.findOne({
      email: exact,
      status: "approved",
    }).lean();
    if (application) {
      log.info("resolve.matched_by_email", {
        practitionerId: String(application._id),
      });
    } else {
      // Tags present but no approved application for this email — usually a
      // data mismatch (different email on this store vs. their application).
      log.info("resolve.email_no_match", { email: customer.email.trim() });
    }
  }

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

// Per-payout commission breakdown — the order-level commissions that make up
// each payout, so a practitioner can reconcile what a payout paid for. Joined
// from cdo_commissions (linked via `payoutId`) to cdo_orders for the order
// date / patient name / revenue. Scoped by practitionerId so a practitioner
// can only ever read the breakdown of their own payouts. Returns a Map keyed
// by payout id → array of breakdown line rows.
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
  const toD = parseDate(to);
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
        // Full shareable referral link (Shopify storefront discount URL,
        // https://<retail-shop>/discount/<code>). Populated once the matching
        // Shopify discount is created on the retail store; null until then.
        referralUrl: c.shopifyDiscountUrl || null,
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
