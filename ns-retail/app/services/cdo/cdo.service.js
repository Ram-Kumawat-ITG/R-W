// CDO Program data access + aggregation layer.
//
// All reads for the CDO Program tabs route through here so the route
// loaders stay thin and the queries are reusable across the Dashboard,
// Reports, and per-tab list pages. Each function ensures the shared
// Mongo connection (connectDB is cached + idempotent) before querying.
//
// `cdo_*` collections are owned by this module. CDO practitioners are
// read from the wholesale workspace's `wholesale_applications`
// collection (approved applicants who resell) — the same source the
// standalone CDO Practitioners page uses.

import connectDB from "../../db/mongo.server";
import WholesaleApplication from "../../models/wholesaleApplication.server";
import CdoOrder from "../../models/cdoOrder.server";
import CdoCommission from "../../models/cdoCommission.server";
import CdoPayout from "../../models/cdoPayout.server";
import CdoReferral from "../../models/cdoReferral.server";
import CdoTransaction from "../../models/cdoTransaction.server";
import CdoSetting from "../../models/cdoSetting.server";

const PRACTITIONER_FILTER = {
  "tax.itemsToResell": "yes",
  status: "approved",
};

function sum(rows, field) {
  return rows.reduce((acc, r) => acc + (Number(r[field]) || 0), 0);
}

export async function listPractitioners() {
  await connectDB();
  const rows = await WholesaleApplication.find(PRACTITIONER_FILTER)
    .sort({ submittedAt: -1 })
    .select(
      "firstName lastName email phone businessName submittedAt customerId status tax.itemsToResell",
    )
    .lean();

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
  }));
}

export async function countPractitioners() {
  await connectDB();
  return WholesaleApplication.countDocuments(PRACTITIONER_FILTER);
}

export async function listOrders({ limit = 0 } = {}) {
  await connectDB();
  const q = CdoOrder.find({}).sort({ placedAt: -1, createdAt: -1 });
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
    practitionerName: r.practitionerName || r.practitionerEmail || "—",
    orderName: r.orderName || "—",
    amount: r.amount || 0,
    rate: r.rate || 0,
    currency: r.currency || "USD",
    status: r.status || "pending",
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
    configured: Boolean(doc),
  };
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
    referrals,
    convertedReferrals,
    activePractitioners,
  ] = await Promise.all([
    CdoOrder.find({}).select("amount commissionAmount placedAt createdAt").lean(),
    CdoCommission.find({}).select("amount status").lean(),
    CdoPayout.find({ status: { $in: ["pending", "processing"] } })
      .select("amount")
      .lean(),
    CdoPayout.find({ status: "paid" }).select("amount").lean(),
    CdoReferral.countDocuments({}),
    CdoReferral.countDocuments({ status: "converted" }),
    countPractitioners(),
  ]);

  const totalRevenue = sum(orders, "amount");
  const totalCommissions = sum(commissions, "amount");
  const pendingPayoutTotal = sum(pendingPayouts, "amount");
  const paidPayoutTotal = sum(paidPayouts, "amount");

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

  return {
    kpis: {
      totalRevenue,
      totalCommissions,
      pendingPayoutTotal,
      paidPayoutTotal,
      totalReferrals: referrals,
      convertedReferrals,
      conversionRate,
      activePractitioners,
      totalOrders: orders.length,
    },
    monthlyPerformance,
    topPractitioners,
    recentOrders,
  };
}

// Top practitioners by attributed revenue + commission, aggregated from
// cdo_orders. Returns [] when there are no attributed orders yet.
export async function getTopPractitioners({ limit = 5 } = {}) {
  await connectDB();
  const rows = await CdoOrder.aggregate([
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
