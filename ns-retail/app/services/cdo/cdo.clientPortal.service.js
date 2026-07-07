// Client Portal data access layer (Theme App Extension, ns-retail
// storefront). Every logged-in retail customer is authorized — there is no
// approval gate like the practitioner portal's. Every query is scoped by
// the trusted `customerId` (a Shopify Customer GID resolved by the guard
// from App Proxy's `logged_in_customer_id`) — never by client-supplied
// email or order id alone.
//
// PROJECT LAW (mirrors cdo.portal.service.js): API handlers under
// app/api/client-portal/ are thin — all business logic lives here.

import mongoose from "mongoose";
import connectDB from "../../db/mongo.server";
import CdoApplication from "../../models/cdoApplication.server";
import CdoOrder from "../../models/cdoOrder.server";
import { deriveShippingStatus, deriveDeliveryStatus, extractTracking } from "../../utils/orderStatus";
import { getInvoicePdf } from "../retailQbo/retailQbo.service";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("cdo.clientPortal.service");

function isValidObjectId(id) {
  return typeof id === "string" && mongoose.isValidObjectId(id);
}

function clampPage(page) {
  return Math.max(Number(page) || 1, 1);
}

function clampPageSize(pageSize) {
  return Math.min(Math.max(Number(pageSize) || 10, 1), 50);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Shared date-range clause builder for `placedAt` — inclusive on both
// ends (dateTo is bumped to end-of-day so a same-day from/to range still
// matches orders placed any time that day).
function dateRangeClause(dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return null;
  const range = {};
  if (dateFrom) range.$gte = new Date(dateFrom);
  if (dateTo) {
    const d = new Date(dateTo);
    d.setHours(23, 59, 59, 999);
    range.$lte = d;
  }
  return range;
}

// Resolve the App-Proxy-verified customer GID into portal context. Never
// throws — a customer with no `cdo_applications` doc (most retail
// customers never went through an attribution/signup path) is a normal,
// fully-authorized case.
export async function resolveClientContext(customerGid) {
  await connectDB();
  const application = await CdoApplication.findOne({ customerId: customerGid }).lean();
  return { customerId: customerGid, application };
}

export async function getDashboard(customerId) {
  await connectDB();
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [agg, pendingCount, recentOrders, application] = await Promise.all([
    CdoOrder.aggregate([
      { $match: { "customer.shopifyCustomerId": customerId } },
      {
        $group: {
          _id: null,
          orderCount: { $sum: 1 },
          lifetimeSpend: { $sum: { $ifNull: ["$amount", 0] } },
          lastOrderAt: { $max: { $ifNull: ["$placedAt", "$createdAt"] } },
          firstOrderAt: { $min: { $ifNull: ["$placedAt", "$createdAt"] } },
          currency: { $first: "$currency" },
          thisMonthSpend: {
            $sum: {
              $cond: [
                { $gte: [{ $ifNull: ["$placedAt", "$createdAt"] }, monthStart] },
                { $ifNull: ["$amount", 0] },
                0,
              ],
            },
          },
          ordersThisMonth: {
            $sum: { $cond: [{ $gte: [{ $ifNull: ["$placedAt", "$createdAt"] }, monthStart] }, 1, 0] },
          },
          fulfilledCount: {
            $sum: { $cond: [{ $eq: ["$fulfillmentStatus", "fulfilled"] }, 1, 0] },
          },
          cancelledCount: {
            $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] },
          },
        },
      },
    ]),
    CdoOrder.countDocuments({
      "customer.shopifyCustomerId": customerId,
      financialStatus: { $in: ["pending", "partially_paid"] },
    }),
    // Small "recent orders" preview for the dashboard — same shape as
    // getOrders' rows, capped at 5, no pagination needed here.
    CdoOrder.find({ "customer.shopifyCustomerId": customerId })
      .sort({ placedAt: -1, _id: -1 })
      .limit(5)
      .select("orderName orderNumber amount currency financialStatus fulfillmentStatus fulfillments placedAt createdAt")
      .lean(),
    CdoApplication.findOne({ customerId }).select("referral").lean(),
  ]);

  const stats = agg[0] || {
    orderCount: 0,
    lifetimeSpend: 0,
    lastOrderAt: null,
    firstOrderAt: null,
    currency: "USD",
    thisMonthSpend: 0,
    ordersThisMonth: 0,
    fulfilledCount: 0,
    cancelledCount: 0,
  };
  const orderCount = stats.orderCount || 0;
  const lifetimeSpend = stats.lifetimeSpend || 0;

  return {
    orderCount,
    lifetimeSpend,
    averageOrderValue: orderCount > 0 ? lifetimeSpend / orderCount : 0,
    thisMonthSpend: stats.thisMonthSpend || 0,
    ordersThisMonth: stats.ordersThisMonth || 0,
    fulfilledCount: stats.fulfilledCount || 0,
    cancelledCount: stats.cancelledCount || 0,
    pendingCount: pendingCount || 0,
    currency: stats.currency || "USD",
    lastOrderAt: stats.lastOrderAt || null,
    firstOrderAt: stats.firstOrderAt || null,
    attributed: !!application?.referral,
    referral: application?.referral || null,
    recentOrders: recentOrders.map((r) => ({
      id: r._id.toString(),
      orderName: r.orderName || r.orderNumber || "—",
      amount: r.amount || 0,
      currency: r.currency || "USD",
      financialStatus: r.financialStatus || null,
      fulfillmentStatus: r.fulfillmentStatus || null,
      shippingStatus: deriveShippingStatus(r),
      placedAt: r.placedAt || r.createdAt || null,
    })),
  };
}

export async function getOrders(
  customerId,
  { page, pageSize, financialStatus, fulfillmentStatus, search, dateFrom, dateTo } = {},
) {
  await connectDB();
  const query = { "customer.shopifyCustomerId": customerId };
  if (financialStatus) query.financialStatus = financialStatus;
  if (fulfillmentStatus) query.fulfillmentStatus = fulfillmentStatus;
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    query.$or = [{ orderName: rx }, { orderNumber: rx }];
  }
  const dateRange = dateRangeClause(dateFrom, dateTo);
  if (dateRange) query.placedAt = dateRange;

  const size = clampPageSize(pageSize);
  const pageNum = clampPage(page);

  const [total, rows, summaryAgg] = await Promise.all([
    CdoOrder.countDocuments(query),
    CdoOrder.find(query)
      .sort({ placedAt: -1, _id: -1 })
      .skip((pageNum - 1) * size)
      .limit(size)
      .select(
        "orderName orderNumber amount currency financialStatus fulfillmentStatus fulfillments placedAt createdAt retailQbo",
      )
      .lean(),
    // Analytics stat cards reflect the SAME filters as the list below (so
    // "how much did I spend this quarter" works when a date range is
    // applied), just without pagination.
    CdoOrder.aggregate([
      { $match: query },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          totalSpend: { $sum: { $ifNull: ["$amount", 0] } },
          totalPaid: {
            $sum: { $cond: [{ $eq: ["$financialStatus", "paid"] }, { $ifNull: ["$amount", 0] }, 0] },
          },
          totalPending: {
            $sum: {
              $cond: [
                { $in: ["$financialStatus", ["pending", "partially_paid"]] },
                { $ifNull: ["$amount", 0] },
                0,
              ],
            },
          },
          fulfilledCount: {
            $sum: { $cond: [{ $eq: ["$fulfillmentStatus", "fulfilled"] }, 1, 0] },
          },
          cancelledCount: {
            $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] },
          },
          currency: { $first: "$currency" },
        },
      },
    ]),
  ]);

  const summary = summaryAgg[0] || {
    totalOrders: 0,
    totalSpend: 0,
    totalPaid: 0,
    totalPending: 0,
    fulfilledCount: 0,
    cancelledCount: 0,
    currency: "USD",
  };

  return {
    rows: rows.map((r) => ({
      id: r._id.toString(),
      orderName: r.orderName || r.orderNumber || "—",
      amount: r.amount || 0,
      currency: r.currency || "USD",
      financialStatus: r.financialStatus || null,
      fulfillmentStatus: r.fulfillmentStatus || null,
      shippingStatus: deriveShippingStatus(r),
      placedAt: r.placedAt || r.createdAt || null,
      // Invoice info — surfaced here (list) and on the order detail page
      // instead of a separate Payment History tab.
      invoiceStatus: r.retailQbo?.invoiceStatus || null, // 'open' | 'paid' | null (sync pending/not started)
      docNumber: r.retailQbo?.qboInvoiceDocNumber || null, // already carries its own "#", e.g. "#1414"
      hasInvoice: !!r.retailQbo?.qboInvoiceId,
    })),
    total,
    page: pageNum,
    pageSize: size,
    pageCount: Math.max(1, Math.ceil(total / size)),
    summary: {
      totalOrders: summary.totalOrders || 0,
      totalSpend: summary.totalSpend || 0,
      totalPaid: summary.totalPaid || 0,
      totalPending: summary.totalPending || 0,
      fulfilledCount: summary.fulfilledCount || 0,
      cancelledCount: summary.cancelledCount || 0,
      currency: summary.currency || "USD",
    },
  };
}

// Ownership is enforced here, not by trusting the client-supplied id — a
// mismatch (or a missing order) returns null so the route can respond with
// a generic "not found", never a 403 that would confirm the id exists.
export async function getOrderDetail(customerId, orderId) {
  if (!isValidObjectId(orderId)) return null;
  await connectDB();
  const o = await CdoOrder.findById(orderId).lean();
  if (!o) return null;
  if (String(o.customer?.shopifyCustomerId || "") !== String(customerId)) return null;

  return {
    id: o._id.toString(),
    orderName: o.orderName || o.orderNumber || "—",
    placedAt: o.placedAt || o.createdAt || null,
    amount: o.amount || 0,
    currency: o.currency || "USD",
    financialStatus: o.financialStatus || null,
    fulfillmentStatus: o.fulfillmentStatus || null,
    shippingStatus: deriveShippingStatus(o),
    deliveryStatus: deriveDeliveryStatus(o),
    tracking: extractTracking(o),
    lineItems: (o.lineItems || []).map((li) => ({
      title: li.title || "—",
      variantTitle: li.variantTitle || null,
      sku: li.sku || null,
      quantity: li.quantity || 0,
      price: li.price || 0,
    })),
    pricing: o.pricing || null,
    billingAddress: o.billingAddress || null,
    shippingAddress: o.shippingAddress || null,
    invoiceStatus: o.retailQbo?.invoiceStatus || null,
    docNumber: o.retailQbo?.qboInvoiceDocNumber || null,
    hasInvoice: !!o.retailQbo?.qboInvoiceId,
    paidAt: o.retailQbo?.paymentAppliedAt || null,
  };
}

// Fetch the order's real QBO-rendered invoice PDF (base64) for in-browser
// viewing — never a link to QBO's hosted portal. Ownership is enforced the
// same way as getOrderDetail (mismatch/missing → a generic "not found"
// reason, never a signal that the id exists but belongs to someone else).
// Mirrors the admin "Preview invoice" action
// (services/retailQbo/retailOrderInvoice.service.getRetailInvoicePdf) but
// scoped by customer ownership instead of shop, since there's no admin
// session here — only the App-Proxy-verified customerId.
export async function getOrderInvoicePdf(customerId, orderId) {
  if (!isValidObjectId(orderId)) return { ok: false, reason: "not_found" };
  await connectDB();
  const o = await CdoOrder.findById(orderId).select("customer retailQbo").lean();
  if (!o) return { ok: false, reason: "not_found" };
  if (String(o.customer?.shopifyCustomerId || "") !== String(customerId)) {
    return { ok: false, reason: "not_found" };
  }

  const invoiceId = o.retailQbo?.qboInvoiceId;
  if (!invoiceId) return { ok: false, reason: "no_invoice" };

  try {
    const pdf = await getInvoicePdf(invoiceId);
    return {
      ok: true,
      base64: pdf.buffer.toString("base64"),
      contentType: pdf.contentType || "application/pdf",
      filename: `invoice-${o.retailQbo?.qboInvoiceDocNumber || invoiceId}.pdf`,
    };
  } catch (err) {
    log.error("invoice_pdf.failed", { orderId, invoiceId, err: err?.message || String(err) });
    return { ok: false, reason: "error", error: err?.message || String(err) };
  }
}

// Returns { attributed:false } for a customer with no active practitioner
// referral — the frontend hides the CDO tab entirely on that shape.
//
// A customer can carry MORE than one CDO discount code over their
// lifetime — `referral` is only the CURRENTLY active one; `referralHistory[]`
// holds every prior code they used before switching/upgrading (see
// cdo.service.upsertCustomerApplication). Shopify also allows more than one
// discount code to apply to the SAME order. Both cases are handled here:
// usage/analytics cover every known code (current + history), and a single
// order's `codes[]` can list more than one matched code with its own
// percent + dollar amount.
export async function getCdoInfo(customerId) {
  await connectDB();
  const application = await CdoApplication.findOne({ customerId })
    .select("referral referralHistory")
    .lean();
  if (!application?.referral) return { attributed: false };

  const { referral } = application;

  // Every code this customer has ever been bound to, keyed by lowercase
  // code (the canonical form both cdo_applications and cdo_orders use).
  // The CURRENT code wins on a key collision (shouldn't happen, but a
  // customer can't be re-linked to the exact same code as their own
  // history — this is just defensive).
  const codeMap = new Map();
  for (const h of application.referralHistory || []) {
    if (!h.code) continue;
    codeMap.set(h.code, { discountPercent: h.discountPercent || 0, practitionerName: h.practitionerName || null });
  }
  codeMap.set(referral.code, { discountPercent: referral.discountPercent || 0, practitionerName: referral.practitionerName || null });
  const knownCodes = [...codeMap.keys()];

  const orders = await CdoOrder.find({
    "customer.shopifyCustomerId": customerId,
    "discountCodes.code": { $in: knownCodes },
  })
    .select("orderName orderNumber placedAt createdAt discountCodes amount currency")
    .sort({ placedAt: -1 })
    .lean();

  let totalSaved = 0;
  let totalSpend = 0;
  let currency = "USD";
  const usage = orders.map((o) => {
    // One entry per matched code on THIS order — an order can carry more
    // than one CDO code (e.g. combined with a legacy code right after a
    // practitioner switch), each with its own percent + dollar amount.
    const codes = (o.discountCodes || [])
      .filter((c) => codeMap.has(c.code))
      .map((c) => ({
        code: c.code,
        discountPercent: codeMap.get(c.code).discountPercent,
        amountSaved: c.amount || 0,
      }));
    const amountSaved = codes.reduce((sum, c) => sum + c.amountSaved, 0);
    totalSaved += amountSaved;
    totalSpend += o.amount || 0;
    if (o.currency) currency = o.currency;
    return {
      orderName: o.orderName || o.orderNumber || "—",
      placedAt: o.placedAt || o.createdAt || null,
      amount: o.amount || 0,
      currency: o.currency || "USD",
      codes,
      amountSaved,
    };
  });

  const totalOrders = usage.length;

  return {
    attributed: true,
    practitionerName: referral.practitionerName || null,
    discountPercent: referral.discountPercent || 0,
    code: referral.code,
    linkedAt: referral.linkedAt || null,
    // Exposed so the UI can note "you've also used N earlier code(s)" —
    // usage/analytics already cover them, this is just for context.
    priorCodes: (application.referralHistory || []).map((h) => ({
      code: h.code,
      discountPercent: h.discountPercent || 0,
      replacedAt: h.replacedAt || null,
    })),
    usage,
    // "Benefits of using your discount" — lifetime totals across every
    // order that used ANY of this customer's known CDO codes.
    analytics: {
      totalOrders,
      totalSaved,
      totalSpend,
      // What they would have paid with no discount at all — the plain-
      // language number for "here's the benefit you got".
      totalWithoutDiscount: totalSpend + totalSaved,
      averageSavingsPerOrder: totalOrders > 0 ? totalSaved / totalOrders : 0,
      currency,
    },
  };
}

// Read-only. Addresses are sourced from the customer's most recent order
// snapshot — cdo_applications.billingAddress/shippingAddress are always
// null (nothing populates them) and a live Shopify Admin lookup was
// deliberately avoided (no extra latency/failure mode for an informational
// field) — see the plan's confirmed decision.
export async function getProfile(customerId, fallbackEmail) {
  await connectDB();
  const [application, latestOrder, agg] = await Promise.all([
    CdoApplication.findOne({ customerId }).select("firstName lastName email referral").lean(),
    CdoOrder.findOne({ "customer.shopifyCustomerId": customerId })
      .sort({ placedAt: -1 })
      .select("customerName customerEmail customer billingAddress shippingAddress")
      .lean(),
    CdoOrder.aggregate([
      { $match: { "customer.shopifyCustomerId": customerId } },
      {
        $group: {
          _id: null,
          orderCount: { $sum: 1 },
          lifetimeSpend: { $sum: { $ifNull: ["$amount", 0] } },
          memberSince: { $min: { $ifNull: ["$placedAt", "$createdAt"] } },
          currency: { $first: "$currency" },
        },
      },
    ]),
  ]);

  const name =
    latestOrder?.customerName ||
    [application?.firstName, application?.lastName].filter(Boolean).join(" ") ||
    null;
  const stats = agg[0] || { orderCount: 0, lifetimeSpend: 0, memberSince: null, currency: "USD" };

  return {
    name,
    email: latestOrder?.customerEmail || application?.email || fallbackEmail || null,
    phone: latestOrder?.customer?.phone || null,
    billingAddress: latestOrder?.billingAddress || null,
    shippingAddress: latestOrder?.shippingAddress || null,
    attributed: !!application?.referral,
    hasOrders: !!latestOrder,
    memberSince: stats.memberSince || null,
    orderCount: stats.orderCount || 0,
    lifetimeSpend: stats.lifetimeSpend || 0,
    currency: stats.currency || "USD",
  };
}
