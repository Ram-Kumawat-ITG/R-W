// Retail order → QBO Vendor Bill (A/P "money out") orchestration.
//
// The accounts-PAYABLE counterpart to the customer Invoice flow
// (retailOrderInvoice.service.js). In addition to invoicing the retail
// customer, each dropship order records what the retail store OWES the
// wholesale supplier ("Natural Solution Wholesale") as an UNPAID QBO Bill in
// the SAME retail company (QBO_RETAIL_*), mirroring the wholesale invoice for
// the same order (per-product lines at the wholesale price factor + shipping).
//
// The Shopify Order ↔ Retail Customer Invoice ↔ Retail Vendor Bill mapping all
// lives on cdo_orders.retailQbo (the invoice block carries qboInvoiceId; this
// flow adds qboVendorId + qboBillId), so one document is the single source of
// truth for the three-way mapping.
//
// Like the invoice flow, everything here is best-effort + idempotent and NEVER
// throws to the caller. It is invoked AFTER the invoice flow on the same
// PAID-gated webhook path, and is fully independent of it — a bill failure can
// never affect (or undo) the customer invoice.

import connectDB from "../../db/mongo.server";
import CdoOrder from "../../models/cdoOrder.server";
import SyncIdMap from "../../models/syncIdMap.server";
import { isRetailQboConfigured, retailQboConfig } from "./retailQbo.config";
import {
  resolveDropshipVendorId,
  resolveDropshipExpenseAccountId,
  createBillForOrder,
  billWebUrl,
} from "./retailQbo.service";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("retail.vendor_bill");

function errMsg(err) {
  return String(err?.message || err || "unknown error").slice(0, 1000);
}

// Build a Map(retailVariantId → wholesale unit price) for an order's lines by
// reading the wholesale product sync's `sync_id_maps` snapshot. This is the
// SAME source the wholesale dropship invoice prices from, so the bill (A/P)
// matches the wholesale invoice (A/R). Single batched query; best-effort — a
// lookup failure or a missing/zero snapshot just leaves that variant out of
// the map, and createBillForOrder falls back to retail × wholesalePriceFactor.
async function buildWholesalePriceMap(lineItems) {
  const map = new Map();
  const ids = [
    ...new Set(
      (lineItems || [])
        .map((li) => li?.variantId)
        .filter((v) => v != null && v !== "")
        .map(String),
    ),
  ];
  if (ids.length === 0) return map;
  try {
    const rows = await SyncIdMap.find({
      entityType: "productVariant",
      retailId: { $in: ids },
    })
      .select("retailId wholesalePrice")
      .lean();
    for (const r of rows) {
      const wp = Number(r.wholesalePrice);
      if (Number.isFinite(wp) && wp > 0) {
        map.set(String(r.retailId), Math.round(wp * 100) / 100);
      }
    }
  } catch (err) {
    log.warn("wholesale_price_map_failed", { err: err?.message || err });
  }
  return map;
}

// Create the QBO Vendor Bill for a retail dropship order, once. Idempotent via
// an atomic claim on cdo_orders.retailQbo.qboBillId (only one worker creates; a
// re-delivery or concurrent webhook that finds an existing/creating bill exits)
// plus a QBO `requestid`. Reads everything from the already-ingested cdo_orders
// doc. A manual retry passes force=true to STEAL a stale claim (e.g. a prior
// attempt that crashed after setting billCreating=true).
export async function ensureRetailVendorBillForOrder({ shop, shopifyOrderId, force = false }) {
  if (!shopifyOrderId) return { ok: false, reason: "missing_order_id" };
  if (!isRetailQboConfigured()) {
    log.warn("skip.not_configured", { shopifyOrderId });
    return { ok: false, reason: "not_configured" };
  }
  if (!retailQboConfig.createVendorBill) {
    return { ok: false, reason: "bill_disabled" };
  }

  await connectDB();

  // Normalize a null/absent retailQbo to an empty object FIRST so the dot-path
  // claim below works (a scalar-null parent breaks `$set: "retailQbo.billCreating"`).
  // Only touches null/absent docs — no existing retailQbo data is lost. (Same
  // guard the invoice flow uses; harmless if the invoice flow already ran it.)
  await CdoOrder.updateOne(
    { shop, shopifyOrderId, retailQbo: null },
    { $set: { retailQbo: {} } },
  );

  // Atomic claim — match only orders without a bill (and, unless force, not
  // mid-create) so a concurrent webhook can't double-create.
  const claimFilter = {
    shop,
    shopifyOrderId,
    "retailQbo.qboBillId": { $in: [null, undefined, ""] },
    ...(force ? {} : { "retailQbo.billCreating": { $ne: true } }),
  };
  const order = await CdoOrder.findOneAndUpdate(
    claimFilter,
    {
      $set: {
        "retailQbo.billCreating": true,
        "retailQbo.billSyncStatus": "creating",
        "retailQbo.billLastAttemptAt": new Date(),
      },
    },
    { new: true },
  );

  if (!order) {
    // No such order, or it already has a bill, or another worker is creating it.
    const existing = await CdoOrder.findOne({ shop, shopifyOrderId })
      .select("retailQbo")
      .lean();
    if (!existing) return { ok: false, reason: "order_not_found" };
    if (existing.retailQbo?.qboBillId) {
      return { ok: true, reason: "already_billed", billId: existing.retailQbo.qboBillId };
    }
    return { ok: true, reason: "creating_elsewhere" };
  }

  if (!Array.isArray(order.lineItems) || order.lineItems.length === 0) {
    const msg = "Order has no line items — nothing to bill the vendor for";
    await CdoOrder.updateOne(
      { _id: order._id },
      {
        $set: {
          "retailQbo.billCreating": false,
          "retailQbo.billSyncStatus": "error",
          "retailQbo.billSyncError": msg,
          "retailQbo.billSyncedAt": new Date(),
        },
        $push: { "retailQbo.syncLog": { at: new Date(), event: "bill_create_failed", ok: false, message: msg } },
      },
    );
    log.warn("skip.no_line_items", { shopifyOrderId });
    return { ok: false, reason: "no_line_items" };
  }

  try {
    const vendorId = await resolveDropshipVendorId();
    const expenseAccountId = await resolveDropshipExpenseAccountId();

    // Resolve each line's actual WHOLESALE product price from sync_id_maps
    // (written by the wholesale product sync) so the vendor bill matches the
    // wholesale dropship invoice for the same order. Lines with no mapping
    // fall back to retail × wholesalePriceFactor inside createBillForOrder.
    const wholesalePriceByVariantId = await buildWholesalePriceMap(order.lineItems);

    // QBO caps requestid at 50 chars; key off the short numeric tail of the GID.
    const shortOrderId = String(shopifyOrderId).split("/").pop() || shopifyOrderId;
    const bill = await createBillForOrder({
      order,
      vendorId,
      expenseAccountId,
      apAccountId: retailQboConfig.apAccountId,
      priceFactor: retailQboConfig.wholesalePriceFactor,
      wholesalePriceByVariantId,
      includeShipping: retailQboConfig.billIncludesShipping,
      requestId: `retail-bill-${shortOrderId}`.slice(0, 50),
    });

    const url = billWebUrl(bill.Id);
    await CdoOrder.updateOne(
      { _id: order._id },
      {
        $set: {
          "retailQbo.qboVendorId": String(vendorId),
          "retailQbo.qboBillId": String(bill.Id),
          "retailQbo.qboBillDocNumber": bill.DocNumber || null,
          "retailQbo.qboBillSyncToken": bill.SyncToken || null,
          "retailQbo.qboBillTotal": bill.TotalAmt ?? null,
          "retailQbo.billUrl": url,
          "retailQbo.billCreatedAt": new Date(),
          "retailQbo.billSyncStatus": "created",
          "retailQbo.billSyncedAt": new Date(),
          "retailQbo.billSyncError": null,
          "retailQbo.billCreating": false,
        },
        $push: {
          "retailQbo.syncLog": {
            at: new Date(),
            event: "bill_created",
            ok: true,
            message: `Vendor bill ${bill.DocNumber || bill.Id} created — total ${bill.TotalAmt} (unpaid)`,
          },
        },
      },
    );

    log.info("bill.created", { shopifyOrderId, billId: bill.Id, vendorId, total: bill.TotalAmt });
    return { ok: true, billId: String(bill.Id) };
  } catch (err) {
    const msg = errMsg(err);
    await CdoOrder.updateOne(
      { _id: order._id },
      {
        $set: {
          "retailQbo.billCreating": false,
          "retailQbo.billSyncStatus": "error",
          "retailQbo.billSyncError": msg,
          "retailQbo.billSyncedAt": new Date(),
        },
        $push: { "retailQbo.syncLog": { at: new Date(), event: "bill_create_failed", ok: false, message: msg } },
      },
    );
    log.error("bill.create_failed", { shopifyOrderId, err });
    return { ok: false, reason: "error", error: msg };
  }
}
