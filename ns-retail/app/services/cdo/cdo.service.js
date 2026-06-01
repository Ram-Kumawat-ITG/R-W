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
import CdoPractitionerCode from "../../models/cdoPractitionerCode.server";
import {
  findOrCreateVendor,
  createBill,
  createBillPayment,
  billWebUrl,
} from "../qbo/qbo.service";

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
    commissionCount: Array.isArray(r.commissionIds) ? r.commissionIds.length : 0,
    qboBillId: r.qboBillId || null,
    qboBillUrl: r.qboBillId ? billWebUrl(r.qboBillId) : null,
    lastError: r.lastError || null,
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

// ── Phase 2: commission accrual + eligibility ────────────────────────

// Generate cdo_commissions for attributed orders that don't have one yet.
// Idempotent: skips orders that already have a linked commission. Rate is
// derived from the order (commissionAmount / amount) or the program
// default; status follows cdo_settings.autoApproveCommissions. Each new
// commission also posts a "commission" credit to the practitioner ledger.
export async function accrueCommissionsForOrders({ shop } = {}) {
  await connectDB();
  const settings = await getSettings();
  const autoApprove = settings.autoApproveCommissions === true;

  const orderFilter = { status: { $ne: "cancelled" } };
  if (shop) orderFilter.shop = shop;
  const orders = await CdoOrder.find(orderFilter).lean();

  const existing = await CdoCommission.find({
    orderId: { $in: orders.map((o) => o._id) },
  })
    .select("orderId")
    .lean();
  const seen = new Set(existing.map((c) => String(c.orderId)));

  let createdCount = 0;
  for (const o of orders) {
    if (seen.has(String(o._id))) continue;
    const amount = roundMoney(o.commissionAmount);
    if (amount <= 0) continue;
    const rate =
      Number(o.amount) > 0
        ? Number((amount / Number(o.amount)).toFixed(4))
        : settings.defaultCommissionRate;
    const earnedAt = o.placedAt || o.createdAt || new Date();
    const commission = await CdoCommission.create({
      shop: o.shop,
      practitionerId: o.practitionerId,
      practitionerEmail: o.practitionerEmail,
      practitionerName: o.practitionerName,
      orderId: o._id,
      orderName: o.orderName,
      currency: o.currency || settings.currency,
      amount,
      rate,
      status: autoApprove ? "approved" : "pending",
      earnedAt,
    });
    await appendLedgerEntry({
      shop: o.shop,
      practitionerId: o.practitionerId,
      practitionerEmail: o.practitionerEmail,
      practitionerName: o.practitionerName,
      currency: o.currency || settings.currency,
      type: "commission",
      amount,
      relatedType: "CdoCommission",
      relatedId: commission._id,
      description: `Commission earned on ${o.orderName || o.shopifyOrderId || "order"}`,
      occurredAt: earnedAt,
    });
    createdCount += 1;
  }
  return { createdCount, autoApprove };
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
  await c.save();
  return c.toObject();
}

// Approved, not-yet-paid, not-yet-batched commissions earned on/before
// the period end. The batch builder applies the per-practitioner minimum.
export async function getEligibleCommissions({ practitionerId, periodEnd } = {}) {
  await connectDB();
  const filter = { status: "approved", payoutId: null };
  if (practitionerId) filter.practitionerId = practitionerId;
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
        privateNote: `CDO commission payout ${payout.reference} (period ending ${payout.periodEnd?.toISOString().slice(0, 10)})`,
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

    // 3) BillPayment (records the disbursement in QBO).
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
        message: `QBO BillPayment ${payment.Id} recorded`,
        actor,
        source: actor ? "admin" : "cron",
      });
      await payout.save();
    }

    // 4) Settle commissions + ledger, finalize.
    await CdoCommission.updateMany(
      { _id: { $in: payout.commissionIds } },
      { $set: { status: "paid", payoutId: payout._id } },
    );
    const paidAt = new Date();
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
      description: `Payout ${payout.reference} via QBO Bill ${payout.qboBillId}`,
      occurredAt: paidAt,
    });

    payout.status = "paid";
    payout.paidAt = paidAt;
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
