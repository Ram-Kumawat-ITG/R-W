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
  };
  const orderCount = stats.orderCount || 0;
  const lifetimeSpend = stats.lifetimeSpend || 0;

  return {
    orderCount,
    lifetimeSpend,
    averageOrderValue: orderCount > 0 ? lifetimeSpend / orderCount : 0,
    thisMonthSpend: stats.thisMonthSpend || 0,
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

  const [total, rows] = await Promise.all([
    CdoOrder.countDocuments(query),
    CdoOrder.find(query)
      .sort({ placedAt: -1, _id: -1 })
      .skip((pageNum - 1) * size)
      .limit(size)
      .select("orderName orderNumber amount currency financialStatus fulfillmentStatus fulfillments placedAt createdAt")
      .lean(),
  ]);

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
    })),
    total,
    page: pageNum,
    pageSize: size,
    pageCount: Math.max(1, Math.ceil(total / size)),
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

export async function getPaymentHistory(customerId, { page, pageSize, financialStatus, dateFrom, dateTo } = {}) {
  await connectDB();
  const query = { "customer.shopifyCustomerId": customerId };
  if (financialStatus) query.financialStatus = financialStatus;
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
      .select("orderName orderNumber amount currency financialStatus placedAt createdAt retailQbo")
      .lean(),
    // Summary stat cards reflect the SAME filters as the list below (so
    // "how much did I pay this quarter" works when a date range is
    // applied), just without pagination.
    CdoOrder.aggregate([
      { $match: query },
      {
        $group: {
          _id: null,
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
          totalInvoiced: { $sum: { $ifNull: ["$amount", 0] } },
          currency: { $first: "$currency" },
        },
      },
    ]),
  ]);

  const summary = summaryAgg[0] || { totalPaid: 0, totalPending: 0, totalInvoiced: 0, currency: "USD" };

  return {
    rows: rows.map((r) => ({
      id: r._id.toString(),
      orderName: r.orderName || r.orderNumber || "—",
      amount: r.amount || 0,
      currency: r.currency || "USD",
      financialStatus: r.financialStatus || null,
      placedAt: r.placedAt || r.createdAt || null,
      invoiceStatus: r.retailQbo?.invoiceStatus || null, // 'open' | 'paid' | null (sync pending/not started)
      invoiceUrl: r.retailQbo?.invoiceUrl || null,
      docNumber: r.retailQbo?.qboInvoiceDocNumber || null,
      paidAt: r.retailQbo?.paymentAppliedAt || null,
    })),
    total,
    page: pageNum,
    pageSize: size,
    pageCount: Math.max(1, Math.ceil(total / size)),
    summary: {
      totalPaid: summary.totalPaid || 0,
      totalPending: summary.totalPending || 0,
      totalInvoiced: summary.totalInvoiced || 0,
      currency: summary.currency || "USD",
    },
  };
}

// Returns { attributed:false } for a customer with no active practitioner
// referral — the frontend hides the CDO tab entirely on that shape.
export async function getCdoInfo(customerId) {
  await connectDB();
  const application = await CdoApplication.findOne({ customerId }).select("referral").lean();
  if (!application?.referral) return { attributed: false };

  const { referral } = application;
  const usage = await CdoOrder.find({
    "customer.shopifyCustomerId": customerId,
    "discountCodes.code": referral.code,
  })
    .select("orderName orderNumber placedAt createdAt discountCodes amount currency")
    .sort({ placedAt: -1 })
    .lean();

  return {
    attributed: true,
    practitionerName: referral.practitionerName || null,
    discountPercent: referral.discountPercent || 0,
    code: referral.code,
    linkedAt: referral.linkedAt || null,
    usage: usage.map((o) => ({
      orderName: o.orderName || o.orderNumber || "—",
      placedAt: o.placedAt || o.createdAt || null,
      discountCodes: o.discountCodes || [],
      amount: o.amount || 0,
      currency: o.currency || "USD",
    })),
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
