import { Fragment } from "react";
import mongoose from "mongoose";
import { useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import connectDB from "../services/APIService/mongo.service";
import ShopifyOrder from "../models/order.server";
import {
  RETAIL_CUSTOMER_EMAIL,
  isRetailCustomerEmail,
} from "../services/dropship/dropship.config";
import { syncFulfillmentsFromShopify } from "../services/order/order.service";
import { KV, TotalsRow, ProcessingBadge, ShipmentStatusBadge } from "../components/admin-ui";
import { carrierDisplayName } from "../utils/shipping.constants";
import { formatAmount, fmtDateTime } from "../utils/format.utils";

// Admin Order Details — read-only view of a single order placed by the retail
// drop-ship customer (DROPSHIP_RETAIL_CUSTOMER_EMAIL). These orders are
// already paid and run on a separate flow: no QBO invoice, no NMI charge, and
// the payment/commission CRON never touches them. So unlike the wholesale
// Order Details page, there are no payment actions here — just everything
// Shopify told us about the order, for auditing the drop-ship fulfillment.

export const loader = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const { id } = params;
  if (!id || !mongoose.isValidObjectId(id)) {
    throw new Response("Invalid id", { status: 400 });
  }

  await connectDB();
  const order = await ShopifyOrder.findOne({ _id: id, shop: session.shop }).lean();
  if (!order) throw new Response("Not found", { status: 404 });

  // Hard guard: this route serves ONLY Admin Orders. A wholesale order id must
  // not resolve here (and vice versa) — the two flows stay strictly separate.
  if (!isRetailCustomerEmail(order.customerEmail)) {
    throw new Response("Not an admin order", { status: 404 });
  }

  // Best-effort live fulfillment/tracking pull from Shopify, persisted onto the
  // order doc — same reliability fallback the wholesale detail page uses for
  // missed fulfillments/* webhooks. Safe for Admin Orders: the service's
  // QBO-memo push is gated on invoiceRef (which Admin Orders never have), so
  // this only reads Shopify + writes tracking locally. A Shopify outage must
  // never 500 the page — fall back to whatever's already stored.
  if (order.shopifyOrderId) {
    try {
      const synced = await syncFulfillmentsFromShopify({
        shop: session.shop,
        shopifyOrderId: order.shopifyOrderId,
        admin,
      });
      if (synced) {
        order.fulfillments = synced.fulfillments || order.fulfillments;
        order.trackingHistory = synced.trackingHistory || order.trackingHistory;
        order.trackingUpdatedAt = synced.trackingUpdatedAt || order.trackingUpdatedAt;
        order.fulfillmentStatus = synced.fulfillmentStatus ?? order.fulfillmentStatus;
        order.shippedAt = synced.shippedAt ?? order.shippedAt;
      }
    } catch (e) {
      console.error("[admin-order-detail] fulfillment live-sync failed:", e?.message || e);
    }
  }

  // Project everything we render out of the raw Shopify webhook payload so we
  // don't ship the whole blob (gateway data, etc.) to the client.
  const details = extractDetails(order.rawPayload, order.currency);
  const orderForClient = serialize(order);
  delete orderForClient.rawPayload;

  return { order: orderForClient, details, retailCustomerEmail: RETAIL_CUSTOMER_EMAIL };
};

// Project a Shopify REST address into the flat shape the UI renders.
function projectAddress(a) {
  if (!a || typeof a !== "object") return null;
  const name =
    a.name || [a.first_name, a.last_name].filter(Boolean).join(" ") || null;
  return {
    name,
    company: a.company || null,
    address1: a.address1 || null,
    address2: a.address2 || null,
    city: a.city || null,
    province: a.province || a.province_code || null,
    zip: a.zip || null,
    country: a.country || a.country_code || null,
    phone: a.phone || null,
  };
}

// Pull the fields we render from the orders/create webhook payload. Coerce
// Shopify's string money values to Number so the UI can format them.
function extractDetails(rawPayload, fallbackCurrency) {
  const currency =
    (rawPayload && rawPayload.currency) || fallbackCurrency || "USD";
  if (!rawPayload || typeof rawPayload !== "object") {
    return {
      currency,
      lineItems: [],
      totals: null,
      shippingAddress: null,
      billingAddress: null,
      shippingLines: [],
      tags: [],
      note: null,
      noteAttributes: [],
      customer: null,
      meta: {},
    };
  }

  const lineItems = Array.isArray(rawPayload.line_items)
    ? rawPayload.line_items.map((li) => {
        const qty = Number(li.quantity ?? 0);
        const price = Number(li.price ?? 0);
        const discount = Number(li.total_discount ?? 0);
        const lineTotal = Number((price * qty - discount).toFixed(2));
        return {
          id: String(li.id ?? ""),
          name: li.name || li.title || "(unnamed)",
          variantTitle: li.variant_title || null,
          sku: li.sku || null,
          vendor: li.vendor || null,
          quantity: qty,
          unitPrice: price,
          discount,
          lineTotal,
          giftCard: Boolean(li.gift_card),
          fulfillmentStatus: li.fulfillment_status || null,
        };
      })
    : [];

  const discounts = Number(rawPayload.total_discounts ?? 0);
  const shipping = Number(
    rawPayload.total_shipping_price_set?.shop_money?.amount ?? 0,
  );
  const lineItemsTotal = Number(
    rawPayload.total_line_items_price ??
      Number(rawPayload.subtotal_price ?? 0) + discounts,
  );
  const totals = {
    lineItemsTotal,
    subtotal: Number(
      rawPayload.subtotal_price ?? rawPayload.total_line_items_price ?? 0,
    ),
    discounts,
    shipping,
    tax: Number(rawPayload.total_tax ?? 0),
    taxesIncluded: Boolean(rawPayload.taxes_included),
    grandTotal: Number(rawPayload.total_price ?? 0),
  };

  const shippingLines = Array.isArray(rawPayload.shipping_lines)
    ? rawPayload.shipping_lines.map((s) => ({
        title: s.title || "Shipping",
        carrier: s.carrier_identifier || s.source || null,
        code: s.code || null,
        price: Number(s.price ?? 0),
      }))
    : [];

  const tags = String(rawPayload.tags || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const noteAttributes = Array.isArray(rawPayload.note_attributes)
    ? rawPayload.note_attributes
        .map((a) => ({ name: a?.name || "", value: a?.value ?? "" }))
        .filter((a) => a.name || a.value)
    : [];

  const c = rawPayload.customer || null;
  const customer = {
    name: c
      ? [c.first_name, c.last_name].filter(Boolean).join(" ") || null
      : null,
    email: (c && c.email) || rawPayload.email || null,
    phone: (c && c.phone) || rawPayload.phone || null,
    id: c && c.id ? String(c.id) : null,
  };

  const meta = {
    createdAt: rawPayload.created_at || null,
    processedAt: rawPayload.processed_at || null,
    updatedAt: rawPayload.updated_at || null,
    closedAt: rawPayload.closed_at || null,
    cancelledAt: rawPayload.cancelled_at || null,
    cancelReason: rawPayload.cancel_reason || null,
    financialStatus: rawPayload.financial_status || null,
    fulfillmentStatus: rawPayload.fulfillment_status || null,
    sourceName: rawPayload.source_name || null,
    processingMethod: rawPayload.processing_method || null,
    paymentGateways: Array.isArray(rawPayload.payment_gateway_names)
      ? rawPayload.payment_gateway_names.join(", ")
      : null,
    confirmationNumber:
      rawPayload.confirmation_number || rawPayload.checkout_id
        ? rawPayload.confirmation_number || String(rawPayload.checkout_id)
        : null,
    orderStatusUrl: rawPayload.order_status_url || null,
    test: Boolean(rawPayload.test),
    totalWeight:
      rawPayload.total_weight != null ? Number(rawPayload.total_weight) : null,
  };

  return {
    currency,
    lineItems,
    totals,
    shippingAddress: projectAddress(rawPayload.shipping_address),
    billingAddress: projectAddress(rawPayload.billing_address),
    shippingLines,
    tags,
    note: rawPayload.note || null,
    noteAttributes,
    customer,
    meta,
  };
}

// Mongoose ObjectIds + Dates → strings before crossing the loader boundary.
// Shallow conversion mirrors app.orders.$id.jsx; nested fulfillments[] Dates
// are serialized natively by React Router's loader transport.
function serialize(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (v && typeof v === "object" && v._bsontype === "ObjectId") {
      out[k] = v.toString();
    } else if (v instanceof Date) {
      out[k] = v.toISOString();
    } else {
      out[k] = v;
    }
  }
  if (out._id && typeof out._id !== "string") out._id = String(out._id);
  return out;
}

function AddressBlock({ address }) {
  if (!address) return <s-paragraph tone="subdued">—</s-paragraph>;
  const lines = [
    address.name,
    address.company,
    address.address1,
    address.address2,
    [address.city, address.province, address.zip].filter(Boolean).join(", "),
    address.country,
    address.phone,
  ].filter(Boolean);
  if (!lines.length) return <s-paragraph tone="subdued">—</s-paragraph>;
  return (
    <s-stack direction="block" gap="none">
      {lines.map((l, i) => (
        <s-text key={i} tone={i === 0 ? undefined : "subdued"}>
          {l}
        </s-text>
      ))}
    </s-stack>
  );
}

export default function AdminOrderDetail() {
  const { order, details, retailCustomerEmail } = useLoaderData();
  const navigate = useNavigate();

  const orderLabel =
    order.shopifyOrderName ||
    (order.shopifyOrderNumber
      ? `#${order.shopifyOrderNumber}`
      : order.shopifyOrderId);

  const { currency } = details;
  const totals = details.totals;
  const fulfillments = Array.isArray(order.fulfillments)
    ? order.fulfillments
    : [];

  return (
    <s-page inlineSize="large" heading={`Admin Order ${orderLabel}`}>
      <s-box padding="base">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-button
            variant="tertiary"
            icon="arrow-left"
            onClick={() => navigate("/app/admin-orders")}
          >
            Admin Orders
          </s-button>
          <ProcessingBadge status={order.processingStatus} />
        </s-stack>
      </s-box>

      <s-box paddingInline="base" paddingBlockEnd="base">
        <s-banner tone="info" heading="Admin order — already paid">
          <s-paragraph>
            This order was placed by the retail drop-ship customer
            {retailCustomerEmail ? ` (${retailCustomerEmail})` : ""}. It is
            handled separately from the wholesale flow: no QBO invoice is
            created and the payment / commission jobs never process it.
          </s-paragraph>
        </s-banner>
      </s-box>

      {/* ───── Order information ───── */}
      <s-section heading="Order information">
        <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="large-100">
          <s-grid-item>
            <KV label="Order name" value={order.shopifyOrderName} />
          </s-grid-item>
          <s-grid-item>
            <KV
              label="Order number"
              value={
                order.shopifyOrderNumber ? `#${order.shopifyOrderNumber}` : null
              }
            />
          </s-grid-item>
          <s-grid-item>
            <KV label="Shopify order ID" value={order.shopifyOrderId} />
          </s-grid-item>
          <s-grid-item>
            <KV label="Currency" value={currency} />
          </s-grid-item>
          <s-grid-item>
            <KV
              label="Order total"
              value={
                order.totalAmount != null
                  ? formatAmount(order.totalAmount, currency)
                  : null
              }
            />
          </s-grid-item>
          <s-grid-item>
            <KV
              label="Financial status"
              value={details.meta.financialStatus || order.financialStatus}
            />
          </s-grid-item>
          <s-grid-item>
            <KV
              label="Fulfillment status"
              value={details.meta.fulfillmentStatus || order.fulfillmentStatus}
            />
          </s-grid-item>
          <s-grid-item>
            <KV
              label="Order date"
              value={fmtDateTime(details.meta.createdAt || order.receivedAt)}
            />
          </s-grid-item>
          <s-grid-item>
            <KV label="Processed at" value={fmtDateTime(details.meta.processedAt)} />
          </s-grid-item>
        </s-grid>
      </s-section>

      {/* ───── Customer ───── */}
      <s-section heading="Customer">
        <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="large-100">
          <s-grid-item>
            <KV
              label="Name"
              value={details.customer?.name}
            />
          </s-grid-item>
          <s-grid-item>
            <KV
              label="Email"
              value={details.customer?.email || order.customerEmail}
            />
          </s-grid-item>
          <s-grid-item>
            <KV label="Phone" value={details.customer?.phone} />
          </s-grid-item>
          <s-grid-item>
            <KV
              label="Shopify customer ID"
              value={details.customer?.id || order.shopifyCustomerId}
            />
          </s-grid-item>
        </s-grid>
      </s-section>

      {/* ───── Tags ───── */}
      <s-section heading={`Order tags (${details.tags.length})`}>
        {details.tags.length ? (
          <s-stack direction="inline" gap="small-200">
            {details.tags.map((t) => (
              <s-badge key={t} tone="default">
                {t}
              </s-badge>
            ))}
          </s-stack>
        ) : (
          <s-paragraph tone="subdued">No tags on this order.</s-paragraph>
        )}
      </s-section>

      {/* ───── Line items + totals ───── */}
      <s-section heading={`Items (${details.lineItems.length})`}>
        {!details.lineItems.length ? (
          <s-paragraph tone="subdued">
            No line items recorded for this order.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            <s-table>
              <s-table-header-row>
                <s-table-header>Product</s-table-header>
                <s-table-header>SKU</s-table-header>
                <s-table-header>Qty</s-table-header>
                <s-table-header>Unit price</s-table-header>
                <s-table-header>Discount</s-table-header>
                <s-table-header>Line total</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {details.lineItems.map((li) => (
                  <s-table-row key={li.id || `${li.name}-${li.sku}`}>
                    <s-table-cell>
                      <s-stack direction="block" gap="none">
                        <s-text>{li.name}</s-text>
                        {li.variantTitle && (
                          <s-text tone="subdued">{li.variantTitle}</s-text>
                        )}
                        {li.vendor && (
                          <s-text tone="subdued">by {li.vendor}</s-text>
                        )}
                        {li.giftCard && <s-badge tone="info">Gift card</s-badge>}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{li.sku || "—"}</s-table-cell>
                    <s-table-cell>{li.quantity}</s-table-cell>
                    <s-table-cell>
                      {formatAmount(li.unitPrice, currency)}
                    </s-table-cell>
                    <s-table-cell>
                      {li.discount > 0
                        ? `− ${formatAmount(li.discount, currency)}`
                        : "—"}
                    </s-table-cell>
                    <s-table-cell>
                      {formatAmount(li.lineTotal, currency)}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>

            {totals && (
              <s-box
                padding="base"
                border="base"
                borderRadius="base"
                background="subdued"
              >
                <s-stack direction="block" gap="tight">
                  <TotalsRow
                    label="Order subtotal"
                    value={formatAmount(totals.lineItemsTotal, currency)}
                  />
                  <TotalsRow
                    label="Discount"
                    value={
                      totals.discounts > 0
                        ? `− ${formatAmount(totals.discounts, currency)}`
                        : formatAmount(0, currency)
                    }
                    tone={totals.discounts > 0 ? "success" : undefined}
                  />
                  <TotalsRow
                    label="Adjusted subtotal"
                    value={formatAmount(totals.subtotal, currency)}
                  />
                  <TotalsRow
                    label="Shipping"
                    value={formatAmount(totals.shipping, currency)}
                  />
                  <TotalsRow
                    label={
                      totals.taxesIncluded ? "Sales tax (included)" : "Sales tax"
                    }
                    value={formatAmount(totals.tax, currency)}
                  />
                  <s-divider />
                  <TotalsRow
                    label="Grand total"
                    value={formatAmount(totals.grandTotal, currency)}
                    strong
                  />
                </s-stack>
              </s-box>
            )}
          </s-stack>
        )}
      </s-section>

      {/* ───── Shipping ───── */}
      <s-section heading="Shipping">
        <s-grid gridTemplateColumns="1fr 1fr" gap="large-100">
          <s-grid-item>
            <s-stack direction="block" gap="none">
              <s-text tone="subdued">Shipping address</s-text>
              <AddressBlock address={details.shippingAddress} />
            </s-stack>
          </s-grid-item>
          <s-grid-item>
            <s-stack direction="block" gap="none">
              <s-text tone="subdued">Billing address</s-text>
              <AddressBlock address={details.billingAddress} />
            </s-stack>
          </s-grid-item>
        </s-grid>
        {details.shippingLines.length > 0 && (
          <s-box paddingBlockStart="base">
            <s-stack direction="block" gap="tight">
              <s-text>
                <strong>Shipping method</strong>
              </s-text>
              {details.shippingLines.map((s, i) => (
                <TotalsRow
                  key={i}
                  label={
                    s.carrier ? `${s.title} (${s.carrier})` : s.title
                  }
                  value={formatAmount(s.price, currency)}
                />
              ))}
            </s-stack>
          </s-box>
        )}
      </s-section>

      {/* ───── Fulfillment & tracking ───── */}
      <s-section
        heading={`Fulfillment & tracking${
          order.trackingUpdatedAt
            ? ` · updated ${new Date(order.trackingUpdatedAt).toLocaleString()}`
            : ""
        }`}
      >
        {!fulfillments.length ? (
          <s-paragraph tone="subdued">
            No fulfillments yet. Carrier and tracking number appear here once the
            order is fulfilled in Shopify.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="tight" alignItems="center">
              <s-text tone="subdued">Fulfillment status:</s-text>
              {(() => {
                const fs = order.fulfillmentStatus || "unfulfilled";
                const label = fs
                  .replace(/_/g, " ")
                  .replace(/\b\w/g, (ch) => ch.toUpperCase());
                const tone =
                  fs === "fulfilled"
                    ? "success"
                    : fs === "partially_fulfilled" || fs === "partial"
                      ? "warning"
                      : "default";
                return <s-badge tone={tone}>{label}</s-badge>;
              })()}
            </s-stack>
            {fulfillments.map((f, i) => {
              const carrier = carrierDisplayName(f.carrierKey, f.trackingCompany);
              const status = f.shipmentStatus || f.status;
              return (
                <s-box
                  key={f.fulfillmentId || i}
                  padding="base"
                  border="base"
                  borderRadius="base"
                  background="subdued"
                >
                  <s-stack direction="block" gap="base">
                    <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="large-100">
                      <s-grid-item>
                        <s-stack direction="block" gap="none">
                          <s-text tone="subdued">Carrier</s-text>
                          {f.trackingUrl ? (
                            <s-link href={f.trackingUrl} target="_blank">
                              {carrier} ↗
                            </s-link>
                          ) : (
                            <s-text>{carrier}</s-text>
                          )}
                        </s-stack>
                      </s-grid-item>
                      <s-grid-item>
                        <s-stack direction="block" gap="none">
                          <s-text tone="subdued">Tracking number</s-text>
                          {f.trackingNumber ? (
                            f.trackingUrl ? (
                              <s-link href={f.trackingUrl} target="_blank">
                                {f.trackingNumber} ↗
                              </s-link>
                            ) : (
                              <s-text>{f.trackingNumber}</s-text>
                            )
                          ) : (
                            <s-text tone="subdued">—</s-text>
                          )}
                        </s-stack>
                      </s-grid-item>
                      <s-grid-item>
                        <s-stack direction="block" gap="none">
                          <s-text tone="subdued">Status</s-text>
                          {status ? (
                            <ShipmentStatusBadge status={status} />
                          ) : (
                            <s-text tone="subdued">—</s-text>
                          )}
                        </s-stack>
                      </s-grid-item>
                      <s-grid-item>
                        <KV
                          label="Ship date"
                          value={
                            f.fulfilledAt
                              ? new Date(f.fulfilledAt).toLocaleDateString()
                              : null
                          }
                        />
                      </s-grid-item>
                      {f.estimatedDeliveryAt && (
                        <s-grid-item>
                          <KV
                            label="Est. delivery"
                            value={new Date(
                              f.estimatedDeliveryAt,
                            ).toLocaleDateString()}
                          />
                        </s-grid-item>
                      )}
                    </s-grid>
                    {f.trackingUrl && (
                      <s-link href={f.trackingUrl} target="_blank">
                        Track shipment ↗
                      </s-link>
                    )}
                  </s-stack>
                </s-box>
              );
            })}

            {order.trackingHistory?.length > 0 && (
              <s-stack direction="block" gap="tight">
                <s-text>
                  <strong>Tracking history</strong>
                </s-text>
                <s-table>
                  <s-table-header-row>
                    <s-table-header>When</s-table-header>
                    <s-table-header>Carrier</s-table-header>
                    <s-table-header>Number</s-table-header>
                    <s-table-header>Status</s-table-header>
                    <s-table-header>Event</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {[...order.trackingHistory]
                      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
                      .map((h, i) => (
                        <s-table-row key={i}>
                          <s-table-cell>
                            {h.at ? new Date(h.at).toLocaleString() : "—"}
                          </s-table-cell>
                          <s-table-cell>
                            {carrierDisplayName(h.carrierKey, h.trackingCompany)}
                          </s-table-cell>
                          <s-table-cell>{h.trackingNumber || "—"}</s-table-cell>
                          <s-table-cell>
                            {h.shipmentStatus ? (
                              <ShipmentStatusBadge status={h.shipmentStatus} />
                            ) : (
                              "—"
                            )}
                          </s-table-cell>
                          <s-table-cell>
                            <s-badge
                              tone={h.event === "created" ? "info" : "default"}
                            >
                              {h.event === "created" ? "Added" : "Updated"}
                            </s-badge>
                          </s-table-cell>
                        </s-table-row>
                      ))}
                  </s-table-body>
                </s-table>
              </s-stack>
            )}
          </s-stack>
        )}
      </s-section>

      {/* ───── Notes ───── */}
      <s-section heading="Notes">
        <s-stack direction="block" gap="base">
          <s-stack direction="block" gap="none">
            <s-text tone="subdued">Order note</s-text>
            {details.note ? (
              <s-paragraph>{details.note}</s-paragraph>
            ) : (
              <s-paragraph tone="subdued">No note on this order.</s-paragraph>
            )}
          </s-stack>
          {details.noteAttributes.length > 0 && (
            <s-stack direction="block" gap="tight">
              <s-text>
                <strong>Note attributes</strong>
              </s-text>
              {details.noteAttributes.map((a, i) => (
                <Fragment key={i}>
                  <KV label={a.name || "—"} value={a.value || "—"} />
                </Fragment>
              ))}
            </s-stack>
          )}
        </s-stack>
      </s-section>

      {/* ───── Additional Shopify metadata ───── */}
      <s-section heading="Additional metadata">
        <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="large-100">
          <s-grid-item>
            <KV label="Source" value={details.meta.sourceName} />
          </s-grid-item>
          <s-grid-item>
            <KV label="Processing method" value={details.meta.processingMethod} />
          </s-grid-item>
          <s-grid-item>
            <KV label="Payment gateway" value={details.meta.paymentGateways} />
          </s-grid-item>
          <s-grid-item>
            <KV
              label="Confirmation #"
              value={details.meta.confirmationNumber}
            />
          </s-grid-item>
          <s-grid-item>
            <KV
              label="Total weight (g)"
              value={details.meta.totalWeight != null ? details.meta.totalWeight : null}
            />
          </s-grid-item>
          <s-grid-item>
            <KV
              label="Test order"
              value={details.meta.test ? "Yes" : "No"}
            />
          </s-grid-item>
          <s-grid-item>
            <KV label="Updated at" value={fmtDateTime(details.meta.updatedAt)} />
          </s-grid-item>
          {details.meta.cancelledAt && (
            <s-grid-item>
              <KV
                label="Cancelled at"
                value={fmtDateTime(details.meta.cancelledAt)}
              />
            </s-grid-item>
          )}
          {details.meta.cancelReason && (
            <s-grid-item>
              <KV label="Cancel reason" value={details.meta.cancelReason} />
            </s-grid-item>
          )}
        </s-grid>
        {details.meta.orderStatusUrl && (
          <s-box paddingBlockStart="base">
            <s-link href={details.meta.orderStatusUrl} target="_blank">
              View order status page ↗
            </s-link>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}
