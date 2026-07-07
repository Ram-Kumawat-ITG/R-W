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

function isValidObjectId(id) {
  return typeof id === "string" && mongoose.isValidObjectId(id);
}

function clampPage(page) {
  return Math.max(Number(page) || 1, 1);
}

function clampPageSize(pageSize) {
  return Math.min(Math.max(Number(pageSize) || 10, 1), 50);
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
  const [agg, application] = await Promise.all([
    CdoOrder.aggregate([
      { $match: { "customer.shopifyCustomerId": customerId } },
      {
        $group: {
          _id: null,
          orderCount: { $sum: 1 },
          lifetimeSpend: { $sum: { $ifNull: ["$amount", 0] } },
          lastOrderAt: { $max: { $ifNull: ["$placedAt", "$createdAt"] } },
          currency: { $first: "$currency" },
        },
      },
    ]),
    CdoApplication.findOne({ customerId }).select("referral").lean(),
  ]);
  const stats = agg[0] || { orderCount: 0, lifetimeSpend: 0, lastOrderAt: null, currency: "USD" };
  return {
    orderCount: stats.orderCount || 0,
    lifetimeSpend: stats.lifetimeSpend || 0,
    currency: stats.currency || "USD",
    lastOrderAt: stats.lastOrderAt || null,
    attributed: !!application?.referral,
    referral: application?.referral || null,
  };
}

export async function getOrders(customerId, { page, pageSize, financialStatus, fulfillmentStatus } = {}) {
  await connectDB();
  const query = { "customer.shopifyCustomerId": customerId };
  if (financialStatus) query.financialStatus = financialStatus;
  if (fulfillmentStatus) query.fulfillmentStatus = fulfillmentStatus;

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

export async function getPaymentHistory(customerId, { page, pageSize } = {}) {
  await connectDB();
  const query = { "customer.shopifyCustomerId": customerId };
  const size = clampPageSize(pageSize);
  const pageNum = clampPage(page);

  const [total, rows] = await Promise.all([
    CdoOrder.countDocuments(query),
    CdoOrder.find(query)
      .sort({ placedAt: -1, _id: -1 })
      .skip((pageNum - 1) * size)
      .limit(size)
      .select("orderName orderNumber amount currency financialStatus placedAt createdAt retailQbo")
      .lean(),
  ]);

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
  const [application, latestOrder] = await Promise.all([
    CdoApplication.findOne({ customerId }).select("firstName lastName email referral").lean(),
    CdoOrder.findOne({ "customer.shopifyCustomerId": customerId })
      .sort({ placedAt: -1 })
      .select("customerName customerEmail billingAddress shippingAddress")
      .lean(),
  ]);

  const name =
    latestOrder?.customerName ||
    [application?.firstName, application?.lastName].filter(Boolean).join(" ") ||
    null;

  return {
    name,
    email: latestOrder?.customerEmail || application?.email || fallbackEmail || null,
    billingAddress: latestOrder?.billingAddress || null,
    shippingAddress: latestOrder?.shippingAddress || null,
    attributed: !!application?.referral,
    hasOrders: !!latestOrder,
  };
}
