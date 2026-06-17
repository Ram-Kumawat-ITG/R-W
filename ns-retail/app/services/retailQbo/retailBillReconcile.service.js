// Retail Vendor Bill reconciliation — mark the retail QBO Vendor Bill PAID once
// the WHOLESALE dropship invoice for the same Shopify order has been paid.
//
// Both apps share one MongoDB. The chain that links a retail order to its
// wholesale invoice lives in the wholesale-owned `dropship_mappings`:
//
//   cdo_orders.shopifyOrderId (retail GID)
//     → dropship_mappings.retailOrderGid          (the mapping)
//       → dropship_mappings.wholesaleOrderId      (wholesale numeric order id)
//         → invoices.shopifyOrderId (isDropship)  (the WHOLESALE invoice)
//           → paymentStatus === 'paid'            (the trigger)
//
// When that wholesale invoice is paid, we record a Retail QBO BillPayment that
// fully applies to the retail vendor bill (→ Paid) and persist the complete
// five-way mapping on cdo_orders.retailQbo:
//   Shopify Order ↔ Retail Vendor Bill ↔ Wholesale Invoice ↔ Wholesale Payment
//   ↔ Retail Bill Payment   (+ processing/payment status + last sync date)
//
// Everything is best-effort + idempotent and NEVER throws to the caller:
//   - atomic claim on cdo_orders.retailQbo.qboBillPaymentId (one worker pays)
//   - a stable QBO `requestid` (QBO dedups a retried POST server-side)
//   - re-fetch of the bill's live Balance (skips if already settled in QBO)
// so a re-delivered webhook / overlapping CRON tick can't double-pay.
//
// ns-retail only READS the wholesale-owned collections (single-owner
// discipline) — it writes solely to cdo_orders (the retail-owned source of
// truth for this mapping).

import connectDB from "../../db/mongo.server";
import CdoOrder from "../../models/cdoOrder.server";
import DropshipMapping from "../../models/dropshipMapping.server";
import WholesaleInvoice from "../../models/wholesaleInvoice.server";
import { isRetailQboConfigured, retailQboConfig } from "./retailQbo.config";
import {
  resolveDropshipVendorId,
  getBill,
  createBillPaymentForBill,
  billPaymentWebUrl,
} from "./retailQbo.service";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("retail.bill_reconcile");

function errMsg(err) {
  return String(err?.message || err || "unknown error").slice(0, 1000);
}

function money2(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

const WHOLESALE_PAID = "paid";

// List retail orders whose vendor bill exists but has no recorded bill payment
// yet (the reconciliation candidate set). Scopes to a shop when given. Returns
// lean docs with just the identifiers the per-order reconcile needs.
export async function listOrdersAwaitingBillReconcile({ shop, limit = 500 } = {}) {
  await connectDB();
  const filter = {
    "retailQbo.qboBillId": { $nin: [null, undefined, ""] },
    "retailQbo.qboBillPaymentId": { $in: [null, undefined, ""] },
    "retailQbo.billPaymentCreating": { $ne: true },
    ...(shop ? { shop } : {}),
  };
  return CdoOrder.find(filter)
    .select("shop shopifyOrderId")
    .limit(limit)
    .lean();
}

// Locate the WHOLESALE dropship invoice mapped to a retail order via
// dropship_mappings, and read its current payment state. Returns
// { mapping, invoice } (either may be null). Read-only.
async function findWholesaleInvoiceForRetailOrder(shopifyOrderId) {
  const numericId = String(shopifyOrderId).split("/").pop() || shopifyOrderId;
  const mapping =
    (await DropshipMapping.findOne({ retailOrderGid: shopifyOrderId }).lean()) ||
    (await DropshipMapping.findOne({ retailOrderId: numericId }).lean());
  if (!mapping) return { mapping: null, invoice: null };

  // Prefer the explicit invoice ref when present; otherwise join the wholesale
  // order id → invoices.shopifyOrderId (the dropship invoice for that order).
  let invoice = null;
  if (mapping.wholesaleInvoiceId) {
    invoice = await WholesaleInvoice.findById(mapping.wholesaleInvoiceId).lean();
  }
  if (!invoice && mapping.wholesaleOrderId) {
    // invoices is uniquely indexed on (shop, shopifyOrderId); scope by the
    // wholesale shop when known so we resolve exactly the one dropship invoice.
    const q = { shopifyOrderId: String(mapping.wholesaleOrderId) };
    if (mapping.shop) q.shop = mapping.shop;
    invoice = await WholesaleInvoice.findOne(q).lean();
  }
  return { mapping, invoice };
}

// Reconcile ONE retail order's vendor bill: if the mapped wholesale dropship
// invoice is paid, record a Retail QBO BillPayment marking the bill Paid and
// persist the full mapping. Idempotent + best-effort. `force=true` steals a
// stale in-flight claim (manual admin retry).
export async function reconcileRetailVendorBillForOrder({ shop, shopifyOrderId, force = false }) {
  if (!shopifyOrderId) return { ok: false, reason: "missing_order_id" };
  if (!isRetailQboConfigured()) {
    log.warn("skip.not_configured", { shopifyOrderId });
    return { ok: false, reason: "not_configured" };
  }
  if (!retailQboConfig.reconcileVendorBill) {
    return { ok: false, reason: "reconcile_disabled" };
  }

  await connectDB();

  // Need a created vendor bill to pay. (Bill creation is owned by the
  // retailVendorBill flow; if it's missing we no-op with a clear reason.)
  const current = await CdoOrder.findOne({ shop, shopifyOrderId }).select("retailQbo").lean();
  if (!current) return { ok: false, reason: "order_not_found" };
  if (!current.retailQbo?.qboBillId) return { ok: true, reason: "no_bill" };
  if (current.retailQbo?.qboBillPaymentId) {
    return { ok: true, reason: "already_paid", billPaymentId: current.retailQbo.qboBillPaymentId };
  }

  // Is the wholesale dropship invoice paid yet? (the trigger)
  const { mapping, invoice } = await findWholesaleInvoiceForRetailOrder(shopifyOrderId);
  if (!mapping) return { ok: true, reason: "no_mapping" };
  if (!invoice) return { ok: true, reason: "wholesale_invoice_pending" };

  // Capture the wholesale-side ids regardless of paid state, so the mapping is
  // visible/traceable even while we're still waiting for payment.
  const wholesaleQboInvoiceId = invoice.qboInvoiceId || null;
  const wholesalePaymentIds = Array.isArray(invoice.qboPaymentIds) ? invoice.qboPaymentIds : [];
  const wholesaleQboPaymentId = wholesalePaymentIds[wholesalePaymentIds.length - 1] || null;
  const wholesaleInvoiceMongoId = invoice._id ? String(invoice._id) : null;

  const wholesalePaid = String(invoice.paymentStatus || "").toLowerCase() === WHOLESALE_PAID;
  if (!wholesalePaid) {
    // Persist the mapping refs + a clear "waiting" state without claiming.
    await CdoOrder.updateOne(
      { shop, shopifyOrderId },
      {
        $set: {
          "retailQbo.wholesaleInvoiceMongoId": wholesaleInvoiceMongoId,
          "retailQbo.wholesaleQboInvoiceId": wholesaleQboInvoiceId,
          "retailQbo.wholesaleQboPaymentId": wholesaleQboPaymentId,
          "retailQbo.billPaymentStatus": "unpaid",
          "retailQbo.billReconcileStatus": "pending",
          "retailQbo.billReconciledAt": new Date(),
        },
      },
    );
    return { ok: true, reason: "wholesale_not_paid", wholesaleStatus: invoice.paymentStatus || null };
  }

  // Atomic claim — only an order with a bill, no bill payment yet, not mid-pay.
  const claimFilter = {
    shop,
    shopifyOrderId,
    "retailQbo.qboBillId": { $nin: [null, undefined, ""] },
    "retailQbo.qboBillPaymentId": { $in: [null, undefined, ""] },
    ...(force ? {} : { "retailQbo.billPaymentCreating": { $ne: true } }),
  };
  const order = await CdoOrder.findOneAndUpdate(
    claimFilter,
    {
      $set: {
        "retailQbo.billPaymentCreating": true,
        "retailQbo.billReconcileStatus": "reconciling",
        "retailQbo.billReconciledAt": new Date(),
        "retailQbo.wholesaleInvoiceMongoId": wholesaleInvoiceMongoId,
        "retailQbo.wholesaleQboInvoiceId": wholesaleQboInvoiceId,
        "retailQbo.wholesaleQboPaymentId": wholesaleQboPaymentId,
      },
    },
    { new: true },
  );

  if (!order) {
    const existing = await CdoOrder.findOne({ shop, shopifyOrderId }).select("retailQbo").lean();
    if (existing?.retailQbo?.qboBillPaymentId) {
      return { ok: true, reason: "already_paid", billPaymentId: existing.retailQbo.qboBillPaymentId };
    }
    return { ok: true, reason: "creating_elsewhere" };
  }

  const billId = order.retailQbo.qboBillId;
  try {
    // Fetch the bill for its CURRENT balance + vendor + currency. A fresh read
    // also guards against double-paying: if it's already settled in QBO we
    // record that and skip the create.
    const bill = await getBill(billId);
    if (!bill?.Id) throw new Error(`bill ${billId} not found in QBO`);

    const vendorId =
      bill.VendorRef?.value || order.retailQbo.qboVendorId || (await resolveDropshipVendorId());
    const currency = bill.CurrencyRef?.value || order.currency || undefined;
    const balance =
      money2(bill.Balance) ?? money2(bill.TotalAmt) ?? money2(order.retailQbo.qboBillTotal) ?? 0;

    if (!(balance > 0)) {
      await CdoOrder.updateOne(
        { _id: order._id },
        {
          $set: {
            "retailQbo.billPaymentCreating": false,
            "retailQbo.billPaymentStatus": "paid",
            "retailQbo.billReconcileStatus": "paid",
            "retailQbo.billReconciledAt": new Date(),
            "retailQbo.billReconcileError": null,
          },
          $push: {
            "retailQbo.syncLog": {
              at: new Date(),
              event: "bill_reconcile_skipped",
              ok: true,
              message: `Vendor bill ${billId} already fully paid in QBO (balance ${balance})`,
            },
          },
        },
      );
      log.info("bill.already_settled", { shopifyOrderId, billId });
      return { ok: true, reason: "bill_already_settled", billId };
    }

    const shortOrderId = String(shopifyOrderId).split("/").pop() || shopifyOrderId;
    const privateNote =
      `Dropship cost settled — retail order ${order.orderName || shopifyOrderId}` +
      (wholesaleQboInvoiceId ? ` · WS invoice ${wholesaleQboInvoiceId}` : "") +
      (wholesaleQboPaymentId ? ` · WS payment ${wholesaleQboPaymentId}` : "");

    const payment = await createBillPaymentForBill({
      vendorId,
      billId,
      amount: balance,
      txnDate: new Date(),
      currency,
      privateNote,
      requestId: `retail-billpay-${shortOrderId}`.slice(0, 50),
    });

    await CdoOrder.updateOne(
      { _id: order._id },
      {
        $set: {
          "retailQbo.qboVendorId": String(vendorId),
          "retailQbo.qboBillPaymentId": String(payment.Id),
          "retailQbo.billPaymentUrl": billPaymentWebUrl(payment.Id),
          "retailQbo.billPaymentTotal": payment.TotalAmt ?? balance,
          "retailQbo.billPaymentAppliedAt": new Date(),
          "retailQbo.billPaymentStatus": "paid",
          "retailQbo.billReconcileStatus": "paid",
          "retailQbo.billReconciledAt": new Date(),
          "retailQbo.billReconcileError": null,
          "retailQbo.billPaymentCreating": false,
        },
        $push: {
          "retailQbo.syncLog": {
            at: new Date(),
            event: "bill_payment_created",
            ok: true,
            message:
              `Bill payment ${payment.Id} recorded & applied to bill ${billId} — ${payment.TotalAmt ?? balance}` +
              (wholesaleQboPaymentId ? ` (wholesale payment ${wholesaleQboPaymentId})` : ""),
          },
        },
      },
    );

    log.info("bill.reconciled", {
      shopifyOrderId,
      billId,
      billPaymentId: payment.Id,
      total: payment.TotalAmt ?? balance,
      wholesaleQboInvoiceId,
      wholesaleQboPaymentId,
    });
    return { ok: true, billPaymentId: String(payment.Id), billId };
  } catch (err) {
    const msg = errMsg(err);
    await CdoOrder.updateOne(
      { _id: order._id },
      {
        $set: {
          "retailQbo.billPaymentCreating": false,
          "retailQbo.billReconcileStatus": "error",
          "retailQbo.billReconcileError": msg,
          "retailQbo.billReconciledAt": new Date(),
        },
        $push: {
          "retailQbo.syncLog": { at: new Date(), event: "bill_payment_failed", ok: false, message: msg },
        },
      },
    );
    log.error("bill.reconcile_failed", { shopifyOrderId, billId, err });
    return { ok: false, reason: "error", error: msg };
  }
}
