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

import mongoose from "mongoose";
import connectDB from "../../db/mongo.server";
import WholesaleApplication from "../../models/wholesaleApplication.server";
import CdoOrder from "../../models/cdoOrder.server";
import CdoCommission from "../../models/cdoCommission.server";
import CdoPayout from "../../models/cdoPayout.server";
import CdoReferral from "../../models/cdoReferral.server";
import CdoTransaction from "../../models/cdoTransaction.server";
import CdoSetting from "../../models/cdoSetting.server";
import CdoPractitionerCode from "../../models/cdoPractitionerCode.server";

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

// ── Per-practitioner detail helpers ──────────────────────────────────
//
// Drive the CDO Customers detail page (`/app/cdo-program/customers/:id`).
// Every helper takes the practitioner's wholesale_applications `_id` as
// its primary key — that's the same id the CDO Customers list page
// hands to the row link.

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

export async function createPractitionerCode({
  practitionerId,
  code,
  discountPercent,
  commissionRate,
  isPrimary,
  note,
  actor,
}) {
  const profile = await getPractitionerProfile(practitionerId);
  if (!profile) throw new Error("Practitioner not found");

  const normalized = normalizeAndValidateCode(code);
  const discount = normalizeFraction(discountPercent, "Discount percent") ?? 0;
  const commission = normalizeFraction(commissionRate, "Commission rate");

  await connectDB();

  // Cheap pre-check for the per-shop-uniqueness — surfaces a friendly
  // error before the DB layer throws E11000.
  const clash = await CdoPractitionerCode.findOne({ code: normalized }).lean();
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
    practitionerId: profile.id,
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
      const clash = await CdoPractitionerCode.findOne({
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

  const [
    orderAgg,
    commissionAgg,
    pendingPayouts,
    paidPayouts,
    totalReferrals,
    convertedReferrals,
    codeCount,
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
      {
        $group: {
          _id: null,
          total: { $sum: "$amount" },
        },
      },
    ]),
    CdoPayout.aggregate([
      { $match: { ...match, status: { $in: ["pending", "processing"] } } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    CdoPayout.aggregate([
      { $match: { ...match, status: "paid" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    CdoReferral.countDocuments(referralMatch),
    CdoReferral.countDocuments({ ...referralMatch, status: "converted" }),
    CdoPractitionerCode.countDocuments({ practitionerId: profile.id }),
  ]);

  const orderRow = orderAgg[0] || { revenue: 0, commissionFromOrders: 0, orders: 0 };
  const conversionRate =
    totalReferrals > 0 ? convertedReferrals / totalReferrals : 0;

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
