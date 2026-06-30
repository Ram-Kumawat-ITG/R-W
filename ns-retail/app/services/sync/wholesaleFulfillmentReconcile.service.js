// Pull-based backstop for the Wholesale→Retail drop-ship fulfillment mirror.
//
// The PUSH path (wholesale POSTs to /api/sync/wholesale-fulfillment when its
// order is fulfilled) fires exactly once and depends on ns-retail being
// reachable at that instant. In dev/staging the two apps talk over rotating
// Shopify-CLI tunnels, and ns-retail isn't always up at the moment a wholesale
// order is fulfilled — so the push frequently fails (Cloudflare 530 /
// "fetch failed") and the retail order is left UNFULFILLED.
//
// This reconciler removes that timing dependency entirely. ns-retail owns the
// retail Shopify Admin token AND shares the wholesale workspace's MongoDB, so it
// reads the wholesale order's fulfillment state directly and fulfills the linked
// retail order in-process — no cross-app HTTP, no tunnel. It runs on a CRON
// (reconcile-wholesale-fulfillments) and reuses the exact same
// applyWholesaleFulfillment used by the push receiver, so there's one code path
// for the Shopify mutation + cdo_orders/QBO bookkeeping.
//
// Idempotent + safe:
//   - only drop-ship mappings with a fulfilled WHOLESALE order are considered;
//   - the linked retail order is skipped once it already has a recorded
//     fulfillment (recordFulfillmentAndSync writes cdo_orders.fulfillments), so
//     a customer shipment email is sent at most once;
//   - applyWholesaleFulfillment only fulfills OPEN fulfillment orders, so a race
//     with the push path (or a concurrent run) can't double-fulfill.

/* eslint-env node */
import connectDB from "../../db/mongo.server";
import DropshipMapping from "../../models/dropshipMapping.server";
import WholesaleOrder from "../../models/wholesaleOrder.server";
import CdoOrder from "../../models/cdoOrder.server";
import { applyWholesaleFulfillment } from "./wholesaleFulfillment.service";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("sync.wholesale_fulfillment_reconcile");

// Project a wholesale shopify_orders fulfillments[] entry into the payload shape
// applyWholesaleFulfillment consumes. The wholesale store already stored the
// human carrier name in trackingCompany, and ns-retail's pickTracking uses
// `carrier || trackingCompany`, so we just pass it through (no carrier table).
function projectFulfillments(wo) {
  return (wo.fulfillments || []).map((f) => ({
    wholesaleFulfillmentId: f.fulfillmentId,
    trackingNumber: f.trackingNumber || null,
    trackingCompany: f.trackingCompany || null,
    carrier: f.trackingCompany || null,
    trackingUrl: f.trackingUrl || f.shopifyTrackingUrl || null,
    shipmentStatus: f.shipmentStatus || null,
    status: f.status || null,
    fulfilledAt: f.fulfilledAt || null,
    deliveredAt: f.deliveredAt || null,
  }));
}

export async function reconcileWholesaleFulfillments({ limit = 200 } = {}) {
  const summary = { checked: 0, fulfilled: 0, delivered: 0, skipped: 0, errors: 0 };
  await connectDB();

  let mappings;
  try {
    mappings = await DropshipMapping.find({
      wholesaleOrderId: { $nin: [null, ""] },
      retailOrderGid: { $nin: [null, ""] },
    })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean();
  } catch (err) {
    log.error("query_failed", { err: err?.message || String(err) });
    return summary;
  }

  for (const m of mappings) {
    summary.checked += 1;
    try {
      // 1. Is the WHOLESALE order actually fulfilled? (no fulfillment recorded =
      //    nothing to mirror yet — never fulfill the retail order pre-emptively.)
      const wo = await WholesaleOrder.findOne({
        shopifyOrderId: String(m.wholesaleOrderId),
      })
        .select(
          "shopifyOrderId shopifyOrderName fulfillmentStatus shippedAt deliveredAt cancelledAt fulfillments",
        )
        .lean();
      if (!wo || !(wo.fulfillments || []).length) {
        summary.skipped += 1;
        continue;
      }

      // 2. Compare the RETAIL order's state to decide what (if anything) to sync:
      //      - retail not yet fulfilled                          → initial fulfillment
      //      - retail fulfilled, wholesale DELIVERED, retail not  → delivered milestone
      //    (The delivered milestone arrives AFTER fulfillment — carrier marks the
      //    shipment delivered — so we must keep syncing past the first fulfillment,
      //    not stop at it.) Reading cdo_orders is a cheap DB gate before any
      //    Shopify call, and it converges: once the retail order reflects the
      //    state, later ticks skip — so the customer shipment email fires at most
      //    once and we don't churn Shopify between fulfillment and delivery.
      const co = await CdoOrder.findOne({ shopifyOrderId: m.retailOrderGid })
        .select("shop fulfillments")
        .lean();
      if (!co) {
        summary.skipped += 1;
        continue;
      }
      const isDeliveredFf = (f) =>
        Boolean(f?.deliveredAt) ||
        String(f?.shipmentStatus || "").toLowerCase() === "delivered";
      const coFulfilled = (co.fulfillments || []).length > 0;
      // Retail "delivered" = Shopify has CONFIRMED it — which
      // applyWholesaleFulfillment records as shipmentStatus 'delivered' ONLY
      // after the Shopify DELIVERED fulfillment event succeeds. `deliveredAt`
      // alone is NOT enough: orders delivered-synced under older code (or before
      // the write_fulfillments scope was granted) carry deliveredAt but never
      // got the Shopify event — they must keep re-syncing until the native
      // Shopify "Delivery status" actually flips to Delivered.
      const coDeliveredOnShopify = (co.fulfillments || []).some(
        (f) => String(f?.shipmentStatus || "").toLowerCase() === "delivered",
      );
      const woDelivered =
        Boolean(wo.deliveredAt) || (wo.fulfillments || []).some(isDeliveredFf);
      const needsInitialFulfillment = !coFulfilled;
      const needsDeliveredSync = coFulfilled && woDelivered && !coDeliveredOnShopify;
      if (!needsInitialFulfillment && !needsDeliveredSync) {
        summary.skipped += 1;
        continue;
      }

      // 3. Mirror it — same applier the push receiver uses.
      const payload = {
        event: "fulfillment",
        retailShop: m.retailShop || co.shop || undefined,
        retailOrderGid: m.retailOrderGid,
        retailOrderId: m.retailOrderId || null,
        retailOrderName: m.retailOrderName || null,
        wholesaleOrderId: String(m.wholesaleOrderId),
        wholesaleOrderName: wo.shopifyOrderName || m.wholesaleOrderName || null,
        fulfillmentStatus: wo.fulfillmentStatus || null,
        shippedAt: wo.shippedAt || null,
        deliveredAt: wo.deliveredAt || null,
        delivered: Boolean(wo.deliveredAt),
        fulfillments: projectFulfillments(wo),
        // The wholesale push owns the mapping's retailFulfillmentSync signature;
        // this pull path doesn't write it.
        signature: null,
      };

      const res = await applyWholesaleFulfillment(payload);
      if (res?.ok && (res.applied === "created" || res.applied === "tracking_updated")) {
        summary.fulfilled += 1;
        log.info("reconciled", {
          retailOrderName: m.retailOrderName,
          wholesaleOrderName: wo.shopifyOrderName,
          applied: res.applied,
        });
      } else if (res?.ok && res.applied === "delivered") {
        summary.delivered += 1;
        log.info("reconciled.delivered", {
          retailOrderName: m.retailOrderName,
          wholesaleOrderName: wo.shopifyOrderName,
        });
      } else {
        // noop / status_synced / not-found — nothing actionable this tick.
        summary.skipped += 1;
      }
    } catch (err) {
      summary.errors += 1;
      log.warn("reconcile_item_failed", {
        retailOrderName: m.retailOrderName,
        wholesaleOrderId: m.wholesaleOrderId,
        err: err?.message || String(err),
      });
    }
  }

  if (summary.checked) log.info("reconcile.done", summary);
  return summary;
}
