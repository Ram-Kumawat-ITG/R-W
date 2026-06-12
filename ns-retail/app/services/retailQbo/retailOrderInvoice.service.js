// Retail order → QBO invoice orchestration. Bridges the cdo_orders snapshot
// (written by the order-ingestion pipeline) and the retail QBO realm:
//
//   orders/create        → ensureRetailInvoiceForOrder  (create the invoice)
//   fulfillments/create  → recordFulfillmentAndSync     (capture tracking +
//   fulfillments/update  → recordFulfillmentAndSync      sync it to the invoice)
//
// Everything here is best-effort + idempotent and NEVER throws to the caller
// (the webhooks fire these and-forget). All QBO state lives under
// cdo_orders.retailQbo with an append-only syncLog for audit. The CDO
// commission/payout pipeline is untouched.

import connectDB from "../../db/mongo.server";
import CdoOrder from "../../models/cdoOrder.server";
import { isRetailQboConfigured, retailQboConfig } from "./retailQbo.config";
import {
  findOrCreateCustomer,
  resolveSalesItemId,
  createInvoiceForOrder,
  syncInvoiceShipping,
  sendInvoice,
  getInvoicePdf,
  invoiceWebUrl,
} from "./retailQbo.service";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("retail.order_invoice");

function errMsg(err) {
  return String(err?.message || err || "unknown error").slice(0, 1000);
}

function orderIsPaid(payload) {
  return String(payload?.financial_status || "").toLowerCase() === "paid";
}

// Low-level: email the invoice via QBO and record the outcome on the order.
// Never throws — a send failure is logged + recorded, leaving the (successful)
// invoice intact so a later event can retry the email.
async function doSendInvoice({ orderId, invoiceId, email, shopifyOrderId }) {
  try {
    const sent = await sendInvoice({ invoiceId, email });
    await CdoOrder.updateOne(
      { _id: orderId },
      {
        $set: {
          "retailQbo.invoiceSentAt": new Date(),
          "retailQbo.invoiceEmailedTo": email,
          "retailQbo.invoiceEmailStatus": sent?.EmailStatus || "EmailSent",
        },
        $push: {
          "retailQbo.syncLog": {
            at: new Date(),
            event: "invoice_sent",
            ok: true,
            message: `Invoice ${invoiceId} emailed to ${email}`,
          },
        },
      },
    );
    log.info("invoice.sent", { shopifyOrderId, invoiceId, email });
    return { ok: true };
  } catch (err) {
    const msg = errMsg(err);
    await CdoOrder.updateOne(
      { _id: orderId },
      {
        $set: { "retailQbo.invoiceEmailStatus": "error" },
        $push: { "retailQbo.syncLog": { at: new Date(), event: "invoice_send_failed", ok: false, message: msg } },
      },
    );
    log.error("invoice.send_failed", { shopifyOrderId, invoiceId, err });
    return { ok: false, error: msg };
  }
}

// Auto-send wrapper used after creation / on the already-invoiced retry path.
// Honors the CDO_QBO_Retail_SEND_INVOICE flag and no-ops (with an audit line)
// when there's no recipient email.
async function maybeSendInvoiceOnCreate({ orderId, invoiceId, email, shopifyOrderId }) {
  if (!retailQboConfig.sendInvoiceOnCreate) return;
  if (!email) {
    await CdoOrder.updateOne(
      { _id: orderId },
      {
        $push: {
          "retailQbo.syncLog": {
            at: new Date(),
            event: "invoice_send_skipped",
            ok: false,
            message: "No customer email on the order — invoice not emailed",
          },
        },
      },
    );
    return;
  }
  await doSendInvoice({ orderId, invoiceId, email, shopifyOrderId });
}

// Create the QBO invoice for a retail order, once. Idempotent via an atomic
// claim on cdo_orders.retailQbo (only one worker creates; a re-delivery or
// concurrent webhook that finds an existing/creating invoice exits) plus a
// QBO `requestid`. Reads everything from the already-ingested cdo_orders doc.
export async function ensureRetailInvoiceForOrder({ shop, shopifyOrderId, force = false }) {
  if (!shopifyOrderId) return { ok: false, reason: "missing_order_id" };
  if (!isRetailQboConfigured()) {
    log.warn("skip.not_configured", { shopifyOrderId });
    return { ok: false, reason: "not_configured" };
  }

  await connectDB();

  // Atomic claim — match only orders without an invoice. Normally we also
  // require not-mid-create (`creating != true`) so a concurrent webhook can't
  // double-create; a manual retry passes force=true to STEAL a stale claim
  // (e.g. a prior attempt that crashed after setting creating=true).
  const claimFilter = {
    shop,
    shopifyOrderId,
    "retailQbo.qboInvoiceId": { $in: [null, undefined] },
    ...(force ? {} : { "retailQbo.creating": { $ne: true } }),
  };
  // A dot-path `$set: { "retailQbo.creating": true }` throws "Cannot create
  // field 'creating' in element {retailQbo: null}" when retailQbo is a scalar
  // null (the model's prior default on legacy rows). So FIRST normalize a
  // null/absent retailQbo to an empty object (this also matches docs where the
  // field is missing), THEN run the dot-path claim — which works on an object.
  // (A pipeline `[ { $set… } ]` update would also handle null, but this
  // Mongoose version rejects array updates: "Cannot pass an array to query
  // updates unless the `updatePipeline` option is set".) Normalizing only
  // touches null/absent docs, so no existing retailQbo data is lost, and the
  // findOneAndUpdate below remains the atomic concurrency guard.
  await CdoOrder.updateOne(
    { shop, shopifyOrderId, retailQbo: null },
    { $set: { retailQbo: {} } },
  );
  const order = await CdoOrder.findOneAndUpdate(
    claimFilter,
    {
      $set: {
        "retailQbo.creating": true,
        "retailQbo.qboSyncStatus": "creating",
        "retailQbo.lastAttemptAt": new Date(),
      },
    },
    { new: true },
  );

  if (!order) {
    // Either no such order, or it already has an invoice, or another worker is
    // creating it. Distinguish "already invoiced" so a manual retry can report
    // it clearly instead of looking like a silent no-op.
    const existing = await CdoOrder.findOne({ shop, shopifyOrderId })
      .select("customerEmail customer retailQbo")
      .lean();
    if (!existing) return { ok: false, reason: "order_not_found" };
    if (existing.retailQbo?.qboInvoiceId) {
      // Already invoiced. Self-heal a previously-failed email send so the
      // customer still receives the invoice on a later order event.
      if (!existing.retailQbo.invoiceSentAt) {
        const email = existing.customerEmail || existing.customer?.email || null;
        await maybeSendInvoiceOnCreate({
          orderId: existing._id,
          invoiceId: existing.retailQbo.qboInvoiceId,
          email,
          shopifyOrderId,
        });
      }
      return { ok: true, reason: "already_invoiced", invoiceId: existing.retailQbo.qboInvoiceId };
    }
    return { ok: true, reason: "creating_elsewhere" };
  }

  const email = order.customerEmail || order.customer?.email || null;
  if (!email && !order.customerName) {
    const msg = "Order has no customer email or name — cannot create a QBO customer";
    await CdoOrder.updateOne(
      { _id: order._id },
      {
        $set: {
          "retailQbo.creating": false,
          "retailQbo.qboSyncStatus": "error",
          "retailQbo.qboSyncError": msg,
          "retailQbo.qboSyncedAt": new Date(),
        },
        $push: { "retailQbo.syncLog": { at: new Date(), event: "invoice_create_failed", ok: false, message: msg } },
      },
    );
    log.warn("skip.no_customer", { shopifyOrderId });
    return { ok: false, reason: "no_customer" };
  }

  try {
    const customer = await findOrCreateCustomer({
      email,
      firstName: order.customer?.firstName,
      lastName: order.customer?.lastName,
      name: order.customerName,
      phone: order.customer?.phone,
      billingAddress: order.billingAddress,
      shippingAddress: order.shippingAddress,
    });

    const itemId = await resolveSalesItemId();

    // QBO caps requestid at 50 chars. shopifyOrderId is the full GID
    // (gid://shopify/Order/<id>), so key off the short numeric tail — still
    // stable + unique per order, preserving QBO's retry idempotency.
    const shortOrderId = String(shopifyOrderId).split("/").pop() || shopifyOrderId;
    const invoice = await createInvoiceForOrder({
      order,
      customerId: customer.id,
      itemId,
      requestId: `retail-inv-${shortOrderId}`.slice(0, 50),
    });

    const url = invoiceWebUrl(invoice.Id);
    await CdoOrder.updateOne(
      { _id: order._id },
      {
        $set: {
          "retailQbo.qboCustomerId": customer.id,
          "retailQbo.qboInvoiceId": String(invoice.Id),
          "retailQbo.qboInvoiceDocNumber": invoice.DocNumber || null,
          "retailQbo.qboSyncToken": invoice.SyncToken || null,
          "retailQbo.qboInvoiceTotal": invoice.TotalAmt ?? null,
          "retailQbo.invoiceUrl": url,
          "retailQbo.qboCreatedAt": new Date(),
          "retailQbo.qboSyncStatus": "created",
          "retailQbo.qboSyncedAt": new Date(),
          "retailQbo.qboSyncError": null,
          "retailQbo.creating": false,
        },
        $push: {
          "retailQbo.syncLog": {
            at: new Date(),
            event: "invoice_created",
            ok: true,
            message: `Invoice ${invoice.DocNumber || invoice.Id} created — total ${invoice.TotalAmt}`,
          },
        },
      },
    );

    log.info("invoice.created", { shopifyOrderId, invoiceId: invoice.Id });

    // Email the invoice to the customer (best-effort; recorded separately so a
    // send failure never undoes the successful creation — a later order event
    // retries the email via the already-invoiced path above).
    await maybeSendInvoiceOnCreate({
      orderId: order._id,
      invoiceId: String(invoice.Id),
      email,
      shopifyOrderId,
    });

    return { ok: true, invoiceId: String(invoice.Id) };
  } catch (err) {
    const msg = errMsg(err);
    await CdoOrder.updateOne(
      { _id: order._id },
      {
        $set: {
          "retailQbo.creating": false,
          "retailQbo.qboSyncStatus": "error",
          "retailQbo.qboSyncError": msg,
          "retailQbo.qboSyncedAt": new Date(),
        },
        $push: { "retailQbo.syncLog": { at: new Date(), event: "invoice_create_failed", ok: false, message: msg } },
      },
    );
    log.error("invoice.create_failed", { shopifyOrderId, err });
    return { ok: false, reason: "error", error: msg };
  }
}

// Webhook convenience — derive the order GID from a Shopify order payload and
// ensure its retail QBO invoice exists. Called fire-and-forget from the
// orders/create|paid|updated webhooks (each AFTER ingestShopifyOrder, so the
// cdo_orders doc exists). Idempotent across all three (claim + QBO requestid),
// so the later events simply retry a missed/failed create. Logs the outcome so
// automatic-invoice failures are traceable. Never throws.
export async function ensureRetailInvoiceFromPayload({ shop, payload, trigger = "order" }) {
  const orderGid =
    payload?.admin_graphql_api_id ||
    (payload?.id ? `gid://shopify/Order/${payload.id}` : null);
  if (!orderGid) {
    log.warn("auto_invoice.no_order_gid", { trigger });
    return { ok: false, reason: "no_order_gid" };
  }

  // Gate automatic creation on PAID — invoice a retail order only once its
  // payment is captured. Unpaid orders are ingested (cdo_orders) but not
  // invoiced; when payment lands, the orders/paid (or orders/updated) webhook
  // re-fires this and the order is invoiced then. (The manual "Create QBO
  // invoice" admin button calls ensureRetailInvoiceForOrder directly and is
  // NOT gated — it's an explicit operator override.)
  if (!orderIsPaid(payload)) {
    console.log(
      `[retail-invoice] (${trigger}) order ${orderGid} not paid yet ` +
        `(financial_status=${payload?.financial_status || "none"}) — deferring invoice`,
    );
    log.info("auto_invoice.deferred_unpaid", {
      trigger,
      shopifyOrderId: orderGid,
      financialStatus: payload?.financial_status || null,
    });
    return { ok: true, reason: "not_paid" };
  }

  let r;
  try {
    r = await ensureRetailInvoiceForOrder({ shop, shopifyOrderId: orderGid });
  } catch (err) {
    log.error("auto_invoice.threw", { trigger, shopifyOrderId: orderGid, err });
    return { ok: false, reason: "error", error: errMsg(err) };
  }
  if (r.ok && (r.invoiceId || r.reason === "already_invoiced")) {
    console.log(
      `[retail-invoice] (${trigger}) order ${orderGid} → invoice ${r.invoiceId || "(existing)"}`,
    );
    log.info("auto_invoice.ready", { trigger, shopifyOrderId: orderGid, invoiceId: r.invoiceId });
  } else {
    console.warn(
      `[retail-invoice] (${trigger}) order ${orderGid} NOT invoiced — ${r.reason || "?"}${
        r.error ? `: ${r.error}` : ""
      }`,
    );
    log.warn("auto_invoice.not_created", {
      trigger,
      shopifyOrderId: orderGid,
      reason: r.reason,
      error: r.error,
    });
  }
  return r;
}

// Normalize a Shopify Fulfillment REST payload to our stored tracking shape.
function normalizeFulfillment(f) {
  return {
    fulfillmentId: String(f?.id ?? ""),
    trackingNumber: f?.tracking_number || f?.tracking_numbers?.[0] || null,
    trackingCompany: f?.tracking_company || null,
    trackingUrl: f?.tracking_url || f?.tracking_urls?.[0] || null,
    shipmentStatus: f?.shipment_status || null,
    status: f?.status || null,
    fulfilledAt: f?.created_at ? new Date(f.created_at) : null,
  };
}

// Capture a fulfillment's carrier + tracking onto the cdo_orders doc and, when
// the order already has a retail QBO invoice, mirror the shipping detail onto
// that invoice. Idempotent: fulfillments[] upserts by id, trackingHistory[] is
// append-only. Best-effort — never throws.
export async function recordFulfillmentAndSync({ shop, shopifyOrderId, fulfillment, event = "updated" }) {
  if (!fulfillment?.id || !shopifyOrderId) return { ok: false, reason: "missing_ids" };

  await connectDB();
  const order = await CdoOrder.findOne({ shop, shopifyOrderId });
  if (!order) {
    log.warn("fulfillment.no_order", { shop, shopifyOrderId });
    return { ok: false, reason: "no_order" };
  }

  const n = normalizeFulfillment(fulfillment);
  if (!Array.isArray(order.fulfillments)) order.fulfillments = [];
  if (!Array.isArray(order.trackingHistory)) order.trackingHistory = [];

  const now = new Date();
  const existing = order.fulfillments.find((x) => x.fulfillmentId === n.fulfillmentId);
  const changed =
    !existing ||
    existing.trackingNumber !== n.trackingNumber ||
    existing.trackingCompany !== n.trackingCompany ||
    existing.shipmentStatus !== n.shipmentStatus ||
    existing.status !== n.status;

  if (existing) {
    existing.trackingNumber = n.trackingNumber;
    existing.trackingCompany = n.trackingCompany;
    existing.trackingUrl = n.trackingUrl;
    existing.shipmentStatus = n.shipmentStatus;
    existing.status = n.status;
    if (n.fulfilledAt) existing.fulfilledAt = n.fulfilledAt;
    existing.updatedAt = now;
  } else {
    order.fulfillments.push({
      fulfillmentId: n.fulfillmentId,
      trackingNumber: n.trackingNumber,
      trackingCompany: n.trackingCompany,
      trackingUrl: n.trackingUrl,
      shipmentStatus: n.shipmentStatus,
      status: n.status,
      fulfilledAt: n.fulfilledAt,
      createdAt: now,
      updatedAt: now,
    });
  }

  if (changed) {
    order.trackingHistory.push({
      at: now,
      fulfillmentId: n.fulfillmentId,
      trackingNumber: n.trackingNumber,
      trackingCompany: n.trackingCompany,
      shipmentStatus: n.shipmentStatus,
      event: existing ? "updated" : "created",
    });
  }

  // Earliest fulfillment date = the order's ship date.
  const times = order.fulfillments
    .map((x) => (x.fulfilledAt ? new Date(x.fulfilledAt).getTime() : NaN))
    .filter((t) => Number.isFinite(t));
  if (times.length) order.shippedAt = new Date(Math.min(...times));

  // Self-heal the order-level fulfillmentStatus from the fulfillments we hold.
  // The order-level field is normally written by orders/updated, but that
  // webhook can be missed/late — leaving a shipped order reading "unfulfilled".
  // Only UPGRADE from an empty/unfulfilled value to "fulfilled"; never clobber a
  // Shopify-reported "partial"/"restocked" (orders/updated remains authoritative
  // for the partial-vs-full distinction).
  const currentFf = String(order.fulfillmentStatus || "").toLowerCase();
  if (!["fulfilled", "partial", "restocked"].includes(currentFf)) {
    const active = order.fulfillments.filter(
      (x) => String(x.status || "").toLowerCase() !== "cancelled",
    );
    const anyShipped = active.some(
      (x) => x.shipmentStatus || ["success", "open"].includes(String(x.status || "").toLowerCase()),
    );
    if (anyShipped) order.fulfillmentStatus = "fulfilled";
  }

  await order.save();
  log.info("fulfillment.captured", {
    shopifyOrderId,
    fulfillmentId: n.fulfillmentId,
    carrier: n.trackingCompany,
    tracking: n.trackingNumber,
    event,
    changed,
  });

  // Mirror onto the QBO invoice when one exists.
  return syncOrderShippingToInvoice(order);
}

// Push the order's current carrier + tracking + ship date onto its QBO
// invoice (memo + TrackingNum + ShipDate) and record the result on
// cdo_orders.retailQbo. Shared by the fulfillment webhooks and the manual
// "Re-sync shipping" admin action. `order` is a loaded mongoose doc.
// Best-effort — never throws.
async function syncOrderShippingToInvoice(order) {
  const invoiceId = order.retailQbo?.qboInvoiceId;
  if (!invoiceId) return { ok: true, synced: false, reason: "no_invoice" };
  if (!isRetailQboConfigured()) return { ok: true, synced: false, reason: "not_configured" };

  const shopifyOrderId = order.shopifyOrderId;
  try {
    const tracked = (order.fulfillments || []).filter((x) => x.trackingNumber || x.trackingCompany);
    const memoLines = tracked.map((x) => {
      const carrier = x.trackingCompany || "Carrier";
      const num = x.trackingNumber || "no number";
      const head = `${carrier} — ${num}${x.shipmentStatus ? ` (${x.shipmentStatus})` : ""}`;
      return x.trackingUrl ? `${head}\n  Track: ${x.trackingUrl}` : head;
    });
    const trackingNum =
      tracked
        .filter((x) => x.trackingNumber)
        .map((x) => `${x.trackingCompany || ""} ${x.trackingNumber}`.trim())
        .join(" | ") || undefined;
    const memo =
      `Retail order ${order.orderName || order.shopifyOrderId || ""}`.trim() +
      (memoLines.length ? `\nShipping:\n${memoLines.join("\n")}` : "");

    const updated = await syncInvoiceShipping({
      invoiceId,
      shipDate: order.shippedAt,
      trackingNum,
      memo,
    });

    await CdoOrder.updateOne(
      { _id: order._id },
      {
        $set: {
          "retailQbo.qboSyncToken": updated.SyncToken || order.retailQbo?.qboSyncToken || null,
          "retailQbo.qboSyncedAt": new Date(),
          "retailQbo.qboSyncStatus": "shipping_synced",
          "retailQbo.qboSyncError": null,
        },
        $push: {
          "retailQbo.syncLog": {
            at: new Date(),
            event: "shipping_synced",
            ok: true,
            message: `Shipping synced to invoice ${invoiceId}${trackingNum ? ` — ${trackingNum}` : ""}`,
          },
        },
      },
    );
    log.info("fulfillment.synced", { shopifyOrderId, invoiceId });

    // Notify the customer of the shipment. QBO is the channel: re-send the
    // invoice, whose memo now carries the order number + carrier + tracking
    // number + tracking URL + shipment status. Deduped on the tracking string
    // (`lastNotifiedTracking`) so we email once per tracking change, never on
    // an unchanged re-sync. Gated by CDO_QBO_Retail_NOTIFY_ON_SHIP.
    const email = order.customerEmail || order.customer?.email || null;
    const alreadyNotified = order.retailQbo?.lastNotifiedTracking || null;
    if (retailQboConfig.notifyOnShip && trackingNum && email && trackingNum !== alreadyNotified) {
      try {
        const sent = await sendInvoice({ invoiceId, email });
        await CdoOrder.updateOne(
          { _id: order._id },
          {
            $set: {
              "retailQbo.lastShipmentNotifiedAt": new Date(),
              "retailQbo.lastNotifiedTracking": trackingNum,
              "retailQbo.invoiceEmailStatus": sent?.EmailStatus || "EmailSent",
              "retailQbo.invoiceSentAt": order.retailQbo?.invoiceSentAt || new Date(),
              "retailQbo.invoiceEmailedTo": order.retailQbo?.invoiceEmailedTo || email,
            },
            $push: {
              "retailQbo.syncLog": {
                at: new Date(),
                event: "shipment_notified",
                ok: true,
                message: `Shipment notification emailed to ${email} — ${trackingNum}`,
              },
            },
          },
        );
        log.info("shipment.notified", { shopifyOrderId, invoiceId, email, trackingNum });
      } catch (err) {
        const msg = errMsg(err);
        await CdoOrder.updateOne(
          { _id: order._id },
          {
            $push: {
              "retailQbo.syncLog": { at: new Date(), event: "shipment_notify_failed", ok: false, message: msg },
            },
          },
        );
        log.error("shipment.notify_failed", { shopifyOrderId, invoiceId, err });
      }
    }

    return { ok: true, synced: true };
  } catch (err) {
    const msg = errMsg(err);
    await CdoOrder.updateOne(
      { _id: order._id },
      {
        $set: { "retailQbo.qboSyncedAt": new Date(), "retailQbo.qboSyncError": msg },
        $push: { "retailQbo.syncLog": { at: new Date(), event: "shipping_sync_failed", ok: false, message: msg } },
      },
    );
    log.error("fulfillment.sync_failed", { shopifyOrderId, invoiceId, err });
    return { ok: false, reason: "sync_error", error: msg };
  }
}

// Manual entry point — re-push the order's stored shipping/tracking onto its
// QBO invoice (admin "Re-sync shipping" button). No-op with a clear reason if
// there's no invoice or no tracking captured yet.
export async function resyncInvoiceShippingForOrder({ shop, shopifyOrderId }) {
  if (!shopifyOrderId) return { ok: false, reason: "missing_order_id" };
  await connectDB();
  const order = await CdoOrder.findOne({ shop, shopifyOrderId });
  if (!order) return { ok: false, reason: "order_not_found" };
  if (!order.retailQbo?.qboInvoiceId) return { ok: false, reason: "no_invoice" };
  return syncOrderShippingToInvoice(order);
}

// Manual entry point — (re)email the invoice to the customer (admin "Send
// invoice" button). Not gated by the SEND_INVOICE flag — an explicit operator
// action always sends.
export async function sendRetailInvoiceForOrder({ shop, shopifyOrderId }) {
  if (!shopifyOrderId) return { ok: false, reason: "missing_order_id" };
  if (!isRetailQboConfigured()) return { ok: false, reason: "not_configured" };
  await connectDB();
  const order = await CdoOrder.findOne({ shop, shopifyOrderId })
    .select("customerEmail customer retailQbo")
    .lean();
  if (!order) return { ok: false, reason: "order_not_found" };
  const invoiceId = order.retailQbo?.qboInvoiceId;
  if (!invoiceId) return { ok: false, reason: "no_invoice" };
  const email = order.customerEmail || order.customer?.email || null;
  if (!email) return { ok: false, reason: "no_email" };
  const r = await doSendInvoice({ orderId: order._id, invoiceId, email, shopifyOrderId });
  return r.ok ? { ok: true, invoiceId, email } : { ok: false, reason: "error", error: r.error };
}

// Fetch the order's QBO invoice PDF for the admin "Preview invoice" action.
// Returns the PDF base64-encoded (the route relays it in its JSON envelope and
// the browser turns it into a blob URL). Never throws.
export async function getRetailInvoicePdf({ shop, shopifyOrderId }) {
  if (!shopifyOrderId) return { ok: false, reason: "missing_order_id" };
  if (!isRetailQboConfigured()) return { ok: false, reason: "not_configured" };
  await connectDB();
  const order = await CdoOrder.findOne({ shop, shopifyOrderId }).select("retailQbo").lean();
  if (!order) return { ok: false, reason: "order_not_found" };
  const invoiceId = order.retailQbo?.qboInvoiceId;
  if (!invoiceId) return { ok: false, reason: "no_invoice" };
  try {
    const pdf = await getInvoicePdf(invoiceId);
    return {
      ok: true,
      base64: pdf.buffer.toString("base64"),
      contentType: pdf.contentType || "application/pdf",
      filename: `invoice-${order.retailQbo?.qboInvoiceDocNumber || invoiceId}.pdf`,
    };
  } catch (err) {
    log.error("invoice.pdf_failed", { shopifyOrderId, invoiceId, err });
    return { ok: false, reason: "error", error: errMsg(err) };
  }
}
