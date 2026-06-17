// Apply a wholesale drop-ship order's fulfillment / cancellation onto the
// linked RETAIL Shopify order.
//
// Called (fire-and-forget) by app/api/sync/wholesale-fulfillment.js when the
// wholesale app notifies us that a drop-ship order shipped / updated tracking /
// delivered / was cancelled. We own the retail Shopify Admin token, so the
// actual Shopify mutation runs here:
//
//   fulfillment event  → create a Shopify fulfillment over the open fulfillment
//                        orders (with carrier + tracking, customer notified),
//                        or update tracking on an already-fulfilled order.
//   cancelled event    → tag the retail order `wholesale-cancelled` (a safe,
//                        non-destructive signal). We deliberately do NOT auto-
//                        cancel or refund the paid retail order — that's a
//                        manual money decision.
//
// After the Shopify mutation, we record the tracking onto cdo_orders + sync the
// retail QBO invoice via the existing recordFulfillmentAndSync (so the DB +
// QBO + the customer shipment email all flow through the one tested path; the
// retail store's own fulfillments/* webhook firing from our mutation is then a
// harmless idempotent re-run).
//
// Idempotent + best-effort: every failure is logged to cdo_orders.retailQbo
// .syncLog and returned, never thrown.

/* eslint-env node */
import connectDB from "../../db/mongo.server";
import CdoOrder from "../../models/cdoOrder.server";
import { unauthenticated } from "../../shopify.server";
import { recordFulfillmentAndSync } from "../retailQbo/retailOrderInvoice.service";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("sync.wholesale_fulfillment");

function errMsg(err) {
  return String(err?.message || err || "unknown error").slice(0, 1000);
}

function toOrderGid(payload) {
  if (payload?.retailOrderGid) return String(payload.retailOrderGid);
  if (payload?.retailOrderId) return `gid://shopify/Order/${payload.retailOrderId}`;
  return null;
}

// Append an audit row to cdo_orders.retailQbo.syncLog. Mirrors the pattern the
// retail-QBO service uses ($push tolerates an absent retailQbo — Mongo creates
// the nested path). Never throws.
async function pushSyncLog(orderId, event, ok, message) {
  try {
    await CdoOrder.updateOne(
      { _id: orderId },
      {
        $push: {
          "retailQbo.syncLog": {
            at: new Date(),
            event,
            ok,
            message: String(message || "").slice(0, 1000),
          },
        },
      },
    );
  } catch (err) {
    log.warn("synclog_failed", { err: errMsg(err) });
  }
}

const QUERY_ORDER_STATE = `#graphql
  query OrderFulfillmentState($id: ID!) {
    order(id: $id) {
      id
      name
      displayFulfillmentStatus
      fulfillmentOrders(first: 25) {
        nodes { id status }
      }
      fulfillments(first: 25) {
        id
        legacyResourceId
        status
        trackingInfo { number company url }
      }
    }
  }
`;

const MUTATION_FULFILLMENT_CREATE = `#graphql
  mutation CreateFulfillment($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment {
        id
        legacyResourceId
        status
        trackingInfo { number company url }
      }
      userErrors { field message }
    }
  }
`;

const MUTATION_TRACKING_UPDATE = `#graphql
  mutation UpdateTracking(
    $fulfillmentId: ID!
    $trackingInfoInput: FulfillmentTrackingInput!
    $notifyCustomer: Boolean
  ) {
    fulfillmentTrackingInfoUpdate(
      fulfillmentId: $fulfillmentId
      trackingInfoInput: $trackingInfoInput
      notifyCustomer: $notifyCustomer
    ) {
      fulfillment {
        id
        legacyResourceId
        status
        trackingInfo { number company url }
      }
      userErrors { field message }
    }
  }
`;

const MUTATION_TAGS_ADD = `#graphql
  mutation AddOrderTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

// Open fulfillment-order statuses we can fulfill against.
const OPEN_FO_STATUSES = new Set(["OPEN", "IN_PROGRESS", "SCHEDULED"]);

// Pick the primary shipment from the wholesale fulfillments payload — the
// most-recently-fulfilled entry that carries tracking OR a carrier status /
// delivery date (so a pure "delivered" status push, even without a number, is
// still picked up). The drop-ship case is a single shipment for the whole
// order, so one set applies.
function pickTracking(fulfillments) {
  const candidates = (fulfillments || []).filter(
    (f) =>
      f.trackingNumber ||
      f.carrier ||
      f.trackingCompany ||
      f.shipmentStatus ||
      f.deliveredAt,
  );
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const ta = a.fulfilledAt ? new Date(a.fulfilledAt).getTime() : 0;
    const tb = b.fulfilledAt ? new Date(b.fulfilledAt).getTime() : 0;
    return tb - ta;
  });
  const f = candidates[0];
  return {
    number: f.trackingNumber || null,
    company: f.carrier || f.trackingCompany || null,
    url: f.trackingUrl || null,
    shipmentStatus: f.shipmentStatus || null,
    status: f.status || null,
    fulfilledAt: f.fulfilledAt || null,
    deliveredAt: f.deliveredAt || null,
  };
}

// True when this shipment's carrier status is `delivered`.
function isDelivered(tracking) {
  return String(tracking?.shipmentStatus || "").toLowerCase() === "delivered";
}

// Build a FulfillmentTrackingInput from our tracking shape (omit empty keys so
// we never send `null` where Shopify wants a String/URL).
function trackingInfoInput(tracking) {
  if (!tracking) return null;
  const t = {};
  if (tracking.number) t.number = tracking.number;
  if (tracking.company) t.company = tracking.company;
  if (tracking.url) t.url = tracking.url;
  return Object.keys(t).length ? t : null;
}

export async function applyWholesaleFulfillment(payload) {
  const event = payload?.event || "fulfillment";
  const retailShop = String(
    payload?.retailShop || process.env.RETAIL_SHOP_DOMAIN || "",
  ).trim();
  const orderGid = toOrderGid(payload);

  if (!retailShop) return { ok: false, reason: "no_retail_shop" };
  if (!orderGid) return { ok: false, reason: "no_retail_order" };

  await connectDB();
  const order = await CdoOrder.findOne({ shop: retailShop, shopifyOrderId: orderGid });
  if (!order) {
    log.warn("no_cdo_order", { retailShop, orderGid });
    return { ok: false, reason: "no_cdo_order" };
  }

  let admin;
  try {
    const ctx = await unauthenticated.admin(retailShop);
    admin = ctx.admin;
  } catch (err) {
    log.error("admin_ctx_failed", { retailShop, err });
    await pushSyncLog(order._id, "wholesale_sync_failed", false, `admin ctx: ${errMsg(err)}`);
    return { ok: false, reason: "admin_ctx", error: errMsg(err) };
  }

  if (event === "cancelled") {
    return applyCancellation({ admin, order, orderGid, payload });
  }
  return applyFulfillment({ admin, order, orderGid, retailShop, payload });
}

// Cancellation: tag the retail order so the merchant sees the wholesale order
// was cancelled. We never auto-cancel/refund the (paid) retail order.
async function applyCancellation({ admin, order, orderGid, payload }) {
  const reason = payload?.cancel?.reason || "cancelled in wholesale";
  try {
    const res = await admin.graphql(MUTATION_TAGS_ADD, {
      variables: { id: orderGid, tags: ["wholesale-cancelled"] },
    });
    const data = await res.json();
    const errs = data?.data?.tagsAdd?.userErrors || [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
    await pushSyncLog(
      order._id,
      "wholesale_cancelled",
      true,
      `Wholesale order cancelled (${reason}); retail order tagged "wholesale-cancelled". ` +
        `Refund/cancel left as a manual decision.`,
    );
    log.info("cancelled.tagged", { orderGid, reason });
    return { ok: true, applied: "tagged_cancelled" };
  } catch (err) {
    await pushSyncLog(order._id, "wholesale_cancel_failed", false, errMsg(err));
    log.error("cancelled.failed", { orderGid, err });
    return { ok: false, reason: "cancel_error", error: errMsg(err) };
  }
}

async function applyFulfillment({ admin, order, orderGid, retailShop, payload }) {
  const tracking = pickTracking(payload?.fulfillments);
  const tInput = trackingInfoInput(tracking);

  // 1. Read the retail order's current fulfillment state.
  let state;
  try {
    const res = await admin.graphql(QUERY_ORDER_STATE, { variables: { id: orderGid } });
    const data = await res.json();
    state = data?.data?.order;
  } catch (err) {
    await pushSyncLog(order._id, "wholesale_sync_failed", false, `state query: ${errMsg(err)}`);
    log.error("state_query_failed", { orderGid, err });
    return { ok: false, reason: "state_query", error: errMsg(err) };
  }
  if (!state) {
    await pushSyncLog(order._id, "wholesale_sync_failed", false, "retail order not found in Shopify");
    log.warn("order_not_found_in_shopify", { orderGid });
    return { ok: false, reason: "order_not_found" };
  }

  const openFOs = (state.fulfillmentOrders?.nodes || []).filter((fo) =>
    OPEN_FO_STATUSES.has(String(fo.status || "").toUpperCase()),
  );
  const existing = state.fulfillments || [];

  let retailFulfillmentId = null;
  let action = null;

  try {
    if (openFOs.length) {
      // CREATE — fulfill the whole order (all open fulfillment orders). Omitting
      // line items per pair fulfills all of that fulfillment order. Notify the
      // customer with the shipping confirmation + tracking.
      const input = {
        lineItemsByFulfillmentOrder: openFOs.map((fo) => ({ fulfillmentOrderId: fo.id })),
        notifyCustomer: true,
        ...(tInput ? { trackingInfo: tInput } : {}),
      };
      const res = await admin.graphql(MUTATION_FULFILLMENT_CREATE, {
        variables: { fulfillment: input },
      });
      const data = await res.json();
      const errs = data?.data?.fulfillmentCreate?.userErrors || [];
      if (errs.length) throw new Error(errs.map((e) => `${e.field}: ${e.message}`).join("; "));
      const ff = data?.data?.fulfillmentCreate?.fulfillment;
      retailFulfillmentId = ff?.legacyResourceId || null;
      action = "created";
    } else if (existing.length) {
      // Already fulfilled, nothing open → a tracking / carrier-status change
      // (incl. DELIVERED). Target the most recent fulfillment.
      const target = existing[existing.length - 1];
      retailFulfillmentId = target.legacyResourceId || null;
      const numberChanged =
        Boolean(tInput) &&
        String(target.trackingInfo?.number || "") !== String(tInput.number || "");

      if (tInput && numberChanged) {
        // The tracking NUMBER actually changed → push it to Shopify + notify.
        const res = await admin.graphql(MUTATION_TRACKING_UPDATE, {
          variables: {
            fulfillmentId: target.id,
            trackingInfoInput: tInput,
            notifyCustomer: true,
          },
        });
        const data = await res.json();
        const errs = data?.data?.fulfillmentTrackingInfoUpdate?.userErrors || [];
        if (errs.length) throw new Error(errs.map((e) => `${e.field}: ${e.message}`).join("; "));
        const ff = data?.data?.fulfillmentTrackingInfoUpdate?.fulfillment;
        retailFulfillmentId = ff?.legacyResourceId || target.legacyResourceId || null;
        action = "tracking_updated";
      } else {
        // Carrier status-only change (e.g. DELIVERED) with the same tracking
        // number — do NOT call Shopify: `shipment_status` is carrier-driven and
        // can't be set via the Admin API, and re-sending the same tracking is a
        // pointless customer email. We still record the latest status + delivery
        // date onto cdo_orders below (the order's derived Delivery status/date
        // reflect it). This is the Delivered-milestone path.
        action = isDelivered(tracking) ? "delivered" : "status_synced";
      }
    } else {
      // Nothing open to fulfill and no existing fulfillment to update — there's
      // no Shopify fulfillment to attach a status to yet. Record-only is
      // impossible without an id; ack as a no-op.
      await pushSyncLog(
        order._id,
        "wholesale_fulfillment_noop",
        true,
        "No open fulfillment orders and no existing retail fulfillment to update — nothing to apply.",
      );
      log.info("fulfillment.noop", { orderGid });
      return { ok: true, applied: "noop" };
    }
  } catch (err) {
    await pushSyncLog(order._id, "wholesale_fulfillment_failed", false, errMsg(err));
    log.error("fulfillment.apply_failed", { orderGid, err });
    return { ok: false, reason: "apply_error", error: errMsg(err) };
  }

  // 2. Record the tracking onto cdo_orders + sync the retail QBO invoice via the
  //    existing path, keyed on the RETAIL fulfillment id (so it lines up with
  //    the retail fulfillments/* webhook this mutation will also trigger).
  if (retailFulfillmentId) {
    const restLike = {
      id: retailFulfillmentId,
      tracking_number: tracking?.number || null,
      tracking_company: tracking?.company || null,
      tracking_url: tracking?.url || null,
      shipment_status: tracking?.shipmentStatus || null,
      status: tracking?.status || "success",
      created_at: tracking?.fulfilledAt || new Date().toISOString(),
      // Carries the delivery date through to cdo_orders.fulfillments[].deliveredAt
      // so the retail order's derived Delivery date matches the wholesale one.
      delivered_at: tracking?.deliveredAt || null,
    };
    try {
      await recordFulfillmentAndSync({
        shop: retailShop,
        shopifyOrderId: orderGid,
        fulfillment: restLike,
        event: action === "created" ? "created" : "updated",
      });
    } catch (err) {
      // recordFulfillmentAndSync is itself best-effort, but guard anyway.
      log.warn("record_sync_failed", { orderGid, err });
    }
  }

  const delivered = action === "delivered";
  await pushSyncLog(
    order._id,
    delivered ? "wholesale_delivered" : "wholesale_fulfillment_synced",
    true,
    (delivered
      ? `Retail order marked DELIVERED from wholesale${tracking?.deliveredAt ? ` on ${new Date(tracking.deliveredAt).toISOString()}` : ""}`
      : `Retail order ${action} from wholesale fulfillment`) +
      (tracking?.number ? ` — ${tracking.company || "Carrier"} ${tracking.number}` : ""),
  );
  log.info(delivered ? "fulfillment.delivered" : "fulfillment.applied", {
    orderGid,
    action,
    retailFulfillmentId,
    tracking: tracking?.number || null,
    deliveredAt: tracking?.deliveredAt || null,
  });
  return { ok: true, applied: action, retailFulfillmentId, deliveredAt: tracking?.deliveredAt || null };
}
