import { Fragment, useEffect, useRef, useState } from "react";
import mongoose from "mongoose";
import { useLoaderData, useNavigate, useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import connectDB from "../services/APIService/mongo.service";
import ShopifyOrder from "../models/order.server";
import Invoice from "../models/invoice.server";
import PaymentAttempt from "../models/paymentAttempt.server";
import QboItemMap from "../models/qboItemMap.server";
import DropshipMapping from "../models/dropshipMapping.server";
import RetailCdoOrder from "../models/retailCdoOrder.server";
import {
  RETAIL_CUSTOMER_EMAIL,
  isRetailCustomerEmail,
} from "../services/dropship/dropship.config";
import { dropshipPaymentConfig } from "../services/dropship/dropshipPayment.config";
import { getInvoice as getQboInvoice, getInvoiceWebUrl } from "../services/qbo/qbo.service";
import { syncFulfillmentsFromShopify } from "../services/order/order.service";
import { projectQboInvoice } from "../utils/qboInvoice.utils";
import {
  KV,
  TotalsRow,
  ProcessingBadge,
  ShipmentStatusBadge,
  PaymentStatusBadge,
  PaymentMethodBadge,
  OutcomeBadge,
  LineItemsTable,
  CollapsibleSection,
} from "../components/admin-ui";
import { carrierDisplayName } from "../utils/shipping.constants";
import { formatAmount, fmtDateTime } from "../utils/format.utils";

// Remark-kind → badge label/tone for the Remarks timeline (mirrors the
// wholesale Order Details map; includes the drop-ship collection kind).
const REMARK_KIND_META = {
  cron_card_attempt: { label: "CRON charge", tone: "info" },
  cron_ach_attempt: { label: "ACH charge", tone: "info" },
  cron_dropship_attempt: { label: "Drop-ship collection", tone: "info" },
  cron_ach_settlement_check: { label: "ACH settlement", tone: "info" },
  cron_cheque_reminder: { label: "Cheque reminder", tone: "warning" },
  cron_ach_reminder: { label: "ACH reminder", tone: "warning" },
  cron_payment_reminder: { label: "Payment reminder", tone: "warning" },
  cron_failed_followup: { label: "Failed follow-up", tone: "critical" },
  admin_action: { label: "Admin action", tone: "default" },
  system_note: { label: "Note", tone: "default" },
};

// emailEvents[].source → friendly label for the Email history table.
const EMAIL_SOURCE_LABEL = {
  invoice_created: "Invoice created",
  payment_recorded: "Payment recorded",
  status_changed: "Status changed",
  manual_resend: "Manual resend",
  payment_reminder: "Payment reminder",
};

// Admin Order Details — read-only view of a single order placed by the retail
// drop-ship customer (DROPSHIP_RETAIL_CUSTOMER_EMAIL). These orders run on a
// separate flow from the wholesale Order Details page: each gets an UNPAID QBO
// invoice on creation, collected automatically by the dedicated
// process-dropship-payments CRON (charges the configured DROPSHIP_NMI_VAULT_ID
// and records the QBO payment). There are no manual payment actions here —
// this page surfaces what Shopify told us, for auditing drop-ship fulfillment.

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

  // ── Invoice + payment ─────────────────────────────────────────────
  // Drop-ship orders carry a full Invoice + QBO invoice (created UNPAID on
  // order creation, collected by the process-dropship-payments CRON). Surface
  // the same invoice view + actions the wholesale Order Details page offers —
  // live QBO pull, PDF, send email, collect now — so admins manage drop-ship
  // billing from this page. Legacy `admin_order` rows have no invoiceRef, so
  // this all degrades gracefully to "no invoice yet".
  const invoice = order.invoiceRef
    ? await Invoice.findById(order.invoiceRef).lean()
    : null;
  const attempts = invoice
    ? await PaymentAttempt.find({ invoiceRef: invoice._id })
        .sort({ attemptedAt: -1 })
        .limit(20)
        .lean()
    : [];

  // Live-fetch the QBO invoice (graceful: a QBO outage must NOT 500 the page).
  let qboInvoice = null;
  let qboInvoiceError = null;
  let qboInvoiceUrl = null;
  if (invoice?.qboInvoiceId) {
    qboInvoiceUrl = getInvoiceWebUrl(invoice.qboInvoiceId);
    try {
      const raw = await getQboInvoice(invoice.qboInvoiceId);
      qboInvoice = raw ? projectQboInvoice(raw) : null;
      if (!qboInvoice) qboInvoiceError = "QBO returned no invoice for this id";
      // Attach each product line's SKU (reverse-lookup from qbo_item_maps),
      // same as the wholesale page's QBO panel.
      if (qboInvoice?.productLines?.length) {
        const itemIds = [
          ...new Set(qboInvoice.productLines.map((l) => l.itemId).filter(Boolean)),
        ];
        if (itemIds.length) {
          const maps = await QboItemMap.find({ qboItemId: { $in: itemIds } })
            .select("qboItemId sku")
            .lean();
          const skuByItemId = new Map(maps.map((m) => [m.qboItemId, m.sku]));
          qboInvoice.productLines = qboInvoice.productLines.map((l) => ({
            ...l,
            sku: skuByItemId.get(l.itemId) || null,
          }));
        }
      }
    } catch (e) {
      console.error("[admin-order-detail] QBO invoice fetch failed:", e?.message || e);
      qboInvoiceError = e?.message || "Failed to fetch QBO invoice";
    }
  }

  // ── Vendor bill (A/P) — 2-hop join: wholesaleOrderId → retailOrderGid → cdo_orders ──
  // Reads the retail QBO bill (A/P) created on the ns-retail side for this
  // drop-ship order. Graceful: a missing mapping (legacy or pre-dropship orders)
  // or a QBO outage must not 500 the page.
  let vendorBill = null;
  if (order.shopifyOrderId) {
    try {
      const mapping = await DropshipMapping.findOne({
        wholesaleOrderId: order.shopifyOrderId,
      }).select("retailOrderGid").lean();
      if (mapping?.retailOrderGid) {
        const cdoOrder = await RetailCdoOrder.findOne({
          shopifyOrderId: mapping.retailOrderGid,
        }).select("retailQbo").lean();
        if (cdoOrder?.retailQbo) {
          const rq = cdoOrder.retailQbo;
          vendorBill = {
            qboBillId: rq.qboBillId || null,
            qboBillDocNumber: rq.qboBillDocNumber || null,
            qboBillTotal: rq.qboBillTotal ?? null,
            billUrl: rq.billUrl || null,
            billSyncStatus: rq.billSyncStatus || null,
            billPaymentStatus: rq.billPaymentStatus || null,
            billReconcileStatus: rq.billReconcileStatus || null,
          };
        }
      }
    } catch (e) {
      console.error("[admin-order-detail] vendor bill lookup failed:", e?.message || e);
    }
  }

  // Project everything we render out of the raw Shopify webhook payload so we
  // don't ship the whole blob (gateway data, etc.) to the client.
  const details = extractDetails(order.rawPayload, order.currency);
  const orderForClient = serialize(order);
  delete orderForClient.rawPayload;

  return {
    order: orderForClient,
    details,
    retailCustomerEmail: RETAIL_CUSTOMER_EMAIL,
    invoice: invoice ? serialize(invoice) : null,
    attempts: attempts.map(serialize),
    qbo: { invoice: qboInvoice, error: qboInvoiceError, url: qboInvoiceUrl },
    vendorBill,
    // Gates the "Collect payment now" button — collection needs a configured
    // drop-ship vault. (The endpoint re-checks server-side regardless.)
    dropshipVaultConfigured: Boolean(dropshipPaymentConfig.vaultId),
  };
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
  const { order, details, retailCustomerEmail, invoice, attempts, qbo, vendorBill, dropshipVaultConfigured } =
    useLoaderData();
  const navigate = useNavigate();
  const shopify = useAppBridge();

  const [bannerError, setBannerError] = useState(null);
  const [bannerSuccess, setBannerSuccess] = useState(null);

  // ── Invoice actions (reuse the shared /api/admin/orders/:id/* endpoints) ──
  const pdfFetcher = useFetcher();
  const billPdfFetcher = useFetcher();
  const sendInvoiceFetcher = useFetcher();
  const collectFetcher = useFetcher();
  const pdfWindowRef = useRef(null);
  const billPdfWindowRef = useRef(null);
  const handledPdfRef = useRef(null);
  const handledBillPdfRef = useRef(null);
  const handledSendRef = useRef(null);
  const handledCollectRef = useRef(null);

  // View invoice PDF — open the tab synchronously (popup-blocker safe), then
  // redirect it to the blob URL once the base64 PDF returns.
  const onViewPdf = () => {
    setBannerError(null);
    pdfWindowRef.current = window.open("about:blank", "_blank");
    pdfFetcher.submit(null, {
      method: "POST",
      action: `/api/admin/orders/${order._id}/qbo-invoice-pdf`,
    });
  };
  useEffect(() => {
    if (!pdfFetcher.data || pdfFetcher.state !== "idle") return;
    if (handledPdfRef.current === pdfFetcher.data) return;
    handledPdfRef.current = pdfFetcher.data;
    const data = pdfFetcher.data;
    if (data.status === "success" && data.result?.base64) {
      const { base64, contentType, filename } = data.result;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: contentType || "application/pdf" });
      const blobUrl = URL.createObjectURL(blob);
      const win = pdfWindowRef.current;
      if (win && !win.closed) {
        win.location.href = blobUrl;
        try {
          win.document.title = filename;
        } catch {
          // cross-origin / not-yet-loaded — ignore
        }
      } else {
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = filename || "invoice.pdf";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      pdfWindowRef.current = null;
    } else if (data.status === "error") {
      const win = pdfWindowRef.current;
      if (win && !win.closed) win.close();
      pdfWindowRef.current = null;
      setBannerError(data.message || "Failed to load QBO invoice PDF");
      shopify?.toast?.show(data.message || "Failed to load PDF", { isError: true });
    }
  }, [pdfFetcher.data, pdfFetcher.state, shopify]);
  const pdfLoading =
    pdfFetcher.state === "submitting" || pdfFetcher.state === "loading";

  // View vendor bill PDF — same popup-safe pattern as onViewPdf above.
  const onViewBillPdf = () => {
    setBannerError(null);
    billPdfWindowRef.current = window.open("about:blank", "_blank");
    billPdfFetcher.submit(null, {
      method: "POST",
      action: `/api/admin/orders/${order._id}/qbo-bill-pdf`,
    });
  };
  useEffect(() => {
    if (!billPdfFetcher.data || billPdfFetcher.state !== "idle") return;
    if (handledBillPdfRef.current === billPdfFetcher.data) return;
    handledBillPdfRef.current = billPdfFetcher.data;
    const data = billPdfFetcher.data;
    if (data.status === "success" && data.result?.base64) {
      const { base64, contentType, filename } = data.result;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: contentType || "application/pdf" });
      const blobUrl = URL.createObjectURL(blob);
      const win = billPdfWindowRef.current;
      if (win && !win.closed) {
        win.location.href = blobUrl;
        try { win.document.title = filename; } catch {}
      } else {
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = filename || "vendor-bill.pdf";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      billPdfWindowRef.current = null;
    } else if (data.status === "error") {
      const win = billPdfWindowRef.current;
      if (win && !win.closed) win.close();
      billPdfWindowRef.current = null;
      setBannerError(data.message || "Failed to load vendor bill PDF");
      shopify?.toast?.show(data.message || "Failed to load PDF", { isError: true });
    }
  }, [billPdfFetcher.data, billPdfFetcher.state, shopify]);
  const billPdfLoading =
    billPdfFetcher.state === "submitting" || billPdfFetcher.state === "loading";

  // Send invoice email — QBO mails the CURRENT invoice document.
  const onSendInvoice = () => {
    setBannerError(null);
    setBannerSuccess(null);
    sendInvoiceFetcher.submit(null, {
      method: "POST",
      action: `/api/admin/orders/${order._id}/send-invoice`,
    });
  };
  useEffect(() => {
    if (!sendInvoiceFetcher.data || sendInvoiceFetcher.state !== "idle") return;
    if (handledSendRef.current === sendInvoiceFetcher.data) return;
    handledSendRef.current = sendInvoiceFetcher.data;
    const data = sendInvoiceFetcher.data;
    if (data.status === "success") {
      setBannerSuccess(data.message || "Invoice email sent");
      shopify?.toast?.show(data.message || "Invoice email sent");
    } else {
      setBannerError(data.message || "Could not send invoice email");
      shopify?.toast?.show(data.message || "Send failed", { isError: true });
    }
  }, [sendInvoiceFetcher.data, sendInvoiceFetcher.state, shopify]);
  const sendInvoiceLoading =
    sendInvoiceFetcher.state === "submitting" ||
    sendInvoiceFetcher.state === "loading";

  // Collect payment now — charge the configured drop-ship NMI vault
  // immediately instead of waiting for the monthly CRON. Reuses the
  // retry-payment endpoint (drop-ship branch injects the configured vault).
  const onCollectNow = () => {
    setBannerError(null);
    setBannerSuccess(null);
    collectFetcher.submit(null, {
      method: "POST",
      action: `/api/admin/orders/${order._id}/retry-payment`,
    });
  };
  useEffect(() => {
    if (!collectFetcher.data || collectFetcher.state !== "idle") return;
    if (handledCollectRef.current === collectFetcher.data) return;
    handledCollectRef.current = collectFetcher.data;
    const data = collectFetcher.data;
    if (data.status === "success") {
      const r = data.result || {};
      if (r.skipped) {
        setBannerError(`Collection skipped: ${r.reason || "see remarks"}`);
        shopify?.toast?.show(`Skipped: ${r.reason || "see remarks"}`, { isError: true });
      } else if (r.outcome === "approved") {
        setBannerSuccess(`Payment collected (NMI txn ${r.transactionId || "?"})`);
        shopify?.toast?.show("Payment collected");
      } else if (r.outcome === "declined") {
        setBannerError(`Declined: ${r.responseText || "no reason given"}`);
        shopify?.toast?.show("Declined", { isError: true });
      } else {
        setBannerError(`Error: ${r.error || r.responseText || "unknown"}`);
        shopify?.toast?.show("Charge error", { isError: true });
      }
    } else {
      setBannerError(data.message || "Could not collect payment");
      shopify?.toast?.show(data.message || "Collection failed", { isError: true });
    }
  }, [collectFetcher.data, collectFetcher.state, shopify]);
  const collectLoading =
    collectFetcher.state === "submitting" || collectFetcher.state === "loading";

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

  // Whether the invoice still has a balance to collect.
  const invoiceOutstanding = invoice
    ? Number((invoice.amountDue || 0) - (invoice.amountPaid || 0))
    : 0;
  const canCollect =
    !!invoice &&
    invoice.qboInvoiceId &&
    !["paid", "cancelled", "in_progress"].includes(invoice.paymentStatus) &&
    invoiceOutstanding > 0.005;

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
        <s-banner tone="info" heading="Drop-ship order">
          <s-paragraph>
            This order was placed by the retail drop-ship customer
            {retailCustomerEmail ? ` (${retailCustomerEmail})` : ""}. It is
            handled separately from the wholesale flow: an unpaid QBO invoice is
            created on order creation, and the drop-ship payment job collects it
            automatically against the card on file. You can also view, email, or
            collect the invoice manually below.
          </s-paragraph>
        </s-banner>
      </s-box>

      {(bannerError || bannerSuccess) && (
        <s-box paddingInline="base" paddingBlockEnd="base">
          {bannerError && (
            <s-banner tone="critical" heading="Action failed">
              <s-paragraph>{bannerError}</s-paragraph>
            </s-banner>
          )}
          {bannerSuccess && (
            <s-banner tone="success" heading="Done">
              <s-paragraph>{bannerSuccess}</s-paragraph>
            </s-banner>
          )}
        </s-box>
      )}



      {/* ───── QuickBooks quick overview ───── */}
      <CollapsibleSection heading="QuickBooks" storageKey="wa-ord-qbo-overview" defaultOpen>
        <s-stack direction="block" gap="base">
          {invoice && (
            <s-stack direction="inline" gap="base" alignItems="center" wrap>
              <s-text><strong>Invoice</strong></s-text>
              {invoice.qboInvoiceId ? (
                <>
                  <s-badge tone="info">#{invoice.qboDocNumber || invoice.qboInvoiceId}</s-badge>
                  <PaymentStatusBadge status={invoice.paymentStatus} />
                  {qbo.url && (
                    <s-button variant="secondary" onClick={() => window.open(qbo.url, "_blank")}>
                      Open in QBO ↗
                    </s-button>
                  )}
                  <s-button variant="secondary" onClick={onViewPdf} {...(pdfLoading ? { loading: true } : {})}>
                    View Invoice PDF
                  </s-button>
                </>
              ) : (
                <s-text tone="subdued">Not yet created</s-text>
              )}
            </s-stack>
          )}
          {vendorBill?.qboBillId ? (
            <s-stack direction="inline" gap="base" alignItems="center" wrap>
              <s-text><strong>Vendor Bill</strong></s-text>
              <s-badge tone="info">#{vendorBill.qboBillDocNumber || vendorBill.qboBillId}</s-badge>
              {vendorBill.billUrl && (
                <s-button variant="secondary" onClick={() => window.open(vendorBill.billUrl, "_blank")}>
                  Open in QBO ↗
                </s-button>
              )}
              <s-button variant="secondary" onClick={onViewBillPdf} {...(billPdfLoading ? { loading: true } : {})}>
                View Bill PDF
              </s-button>
            </s-stack>
          ) : (
            <s-text tone="subdued">No vendor bill linked yet.</s-text>
          )}
        </s-stack>
      </CollapsibleSection>

      {/* ───── Order information ───── */}
      <CollapsibleSection heading="Order information" storageKey="wa-ord-info">
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
      </CollapsibleSection>

      {/* ───── Fulfillment & tracking ───── */}
      <CollapsibleSection
        heading={`Fulfillment & tracking${
          order.trackingUpdatedAt
            ? ` · updated ${new Date(order.trackingUpdatedAt).toLocaleString()}`
            : ""
        }`}
        storageKey="wa-ord-fulfillment"
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
      </CollapsibleSection>

      {/* ───── Line items + totals ───── */}
      <CollapsibleSection heading={`Items (${details.lineItems.length})`} storageKey="wa-ord-items">
        {!details.lineItems.length ? (
          <s-paragraph tone="subdued">
            No line items recorded for this order.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            <LineItemsTable
              lineItems={details.lineItems}
              currency={currency}
              orderLabel={orderLabel}
            />

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
      </CollapsibleSection>

      {/* ───── Customer ───── */}
      <CollapsibleSection heading="Customer" storageKey="wa-ord-customer">
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
      </CollapsibleSection>

      {/* ───── Tags ───── */}
      <CollapsibleSection heading={`Order tags (${details.tags.length})`} storageKey="wa-ord-tags">
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
      </CollapsibleSection>

      {/* ───── Shipping ───── */}
      <CollapsibleSection heading="Shipping" storageKey="wa-ord-shipping">
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
      </CollapsibleSection>

      {/* ───── Notes ───── */}
      <CollapsibleSection heading="Notes" storageKey="wa-ord-notes">
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
      </CollapsibleSection>

      {/* ───── Additional Shopify metadata ───── */}
      <CollapsibleSection heading="Additional metadata" storageKey="wa-ord-meta">
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
      </CollapsibleSection>

      {/* ───── Invoice & payment ───── */}
      <CollapsibleSection heading="Invoice & payment" storageKey="wa-ord-invoice">
        {!invoice ? (
          <s-paragraph tone="subdued">
            No invoice has been created for this order yet.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" alignItems="center">
              <PaymentStatusBadge status={invoice.paymentStatus} />
              <PaymentMethodBadge method={invoice.paymentMethod} />
              <s-text tone="subdued">
                {invoice.attemptCount}/{invoice.maxAttempts} attempts
              </s-text>
            </s-stack>

            <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="large-100">
              <s-grid-item>
                <KV
                  label="Amount due"
                  value={formatAmount(invoice.amountDue, invoice.currency)}
                />
              </s-grid-item>
              <s-grid-item>
                <KV
                  label="Amount paid"
                  value={formatAmount(invoice.amountPaid || 0, invoice.currency)}
                />
              </s-grid-item>
              <s-grid-item>
                <KV
                  label="Balance"
                  value={formatAmount(invoiceOutstanding, invoice.currency)}
                />
              </s-grid-item>
              <s-grid-item>
                <KV label="Due date" value={invoice.qboDueDate} />
              </s-grid-item>
              <s-grid-item>
                <KV
                  label="Paid at"
                  value={invoice.paidAt ? fmtDateTime(invoice.paidAt) : null}
                />
              </s-grid-item>
              <s-grid-item>
                <KV
                  label="Last attempt"
                  value={
                    invoice.lastAttemptAt ? fmtDateTime(invoice.lastAttemptAt) : null
                  }
                />
              </s-grid-item>
            </s-grid>

            {invoice.lastAttemptError && (
              <s-banner tone="warning" heading="Last attempt error">
                <s-paragraph>{invoice.lastAttemptError}</s-paragraph>
              </s-banner>
            )}

            <s-stack direction="inline" gap="base">
              {canCollect && (
                <s-button
                  variant="primary"
                  onClick={onCollectNow}
                  disabled={!dropshipVaultConfigured}
                  {...(collectLoading ? { loading: true } : {})}
                >
                  Collect payment now
                </s-button>
              )}
            </s-stack>
            {canCollect && !dropshipVaultConfigured && (
              <s-paragraph tone="subdued">
                Set <s-text>DROPSHIP_NMI_VAULT_ID</s-text> to enable manual
                collection (the monthly drop-ship CRON needs it too).
              </s-paragraph>
            )}
          </s-stack>
        )}
      </CollapsibleSection>

      {/* ───── QuickBooks invoice (live) ───── */}
      {(invoice?.qboInvoiceId || vendorBill) && (
        <CollapsibleSection heading="QuickBooks invoice" storageKey="wa-ord-qbo">
          <s-stack direction="block" gap="base">

            {/* ─ Invoice ─ */}
            <s-stack direction="block" gap="tight">
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-text><strong>Invoice</strong></s-text>
                {invoice?.qboInvoiceId ? (
                  <>
                    {qbo?.invoice?.docNumber && (
                      <s-badge tone="info">#{qbo.invoice.docNumber}</s-badge>
                    )}
                    <s-badge tone="success">Synced to QBO</s-badge>
                  </>
                ) : (
                  <s-badge tone="neutral">Not yet synced to QBO</s-badge>
                )}
              </s-stack>

              {invoice?.qboInvoiceId ? (
                <s-stack direction="block" gap="base">
                  <s-stack
                    direction="inline"
                    gap="base"
                    alignItems="center"
                    justifyContent="space-between"
                  >
                    <s-text tone="subdued">QBO id: {invoice.qboInvoiceId}</s-text>
                    <s-stack direction="inline" gap="base">
                      {qbo?.url && (
                        <s-button
                          variant="secondary"
                          onClick={() => window.open(qbo.url, "_blank")}
                        >
                          View Invoice ↗
                        </s-button>
                      )}
                      <s-button
                        variant="secondary"
                        onClick={onSendInvoice}
                        {...(sendInvoiceLoading ? { loading: true } : {})}
                      >
                        Send invoice
                      </s-button>
                      <s-button
                        variant="secondary"
                        onClick={onViewPdf}
                        {...(pdfLoading ? { loading: true } : {})}
                      >
                        View invoice PDF
                      </s-button>
                    </s-stack>
                  </s-stack>

                  {qbo?.error && (
                    <s-banner tone="warning" heading="Could not load live QBO invoice">
                      <s-paragraph>{qbo.error}</s-paragraph>
                      <s-paragraph tone="subdued">
                        Use the QuickBooks link to view the current state.
                      </s-paragraph>
                    </s-banner>
                  )}

                  {qbo?.invoice && (
                    <>
                      <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="large-100">
                        <s-grid-item>
                          <KV label="Customer" value={qbo.invoice.customerName} />
                        </s-grid-item>
                        <s-grid-item>
                          <KV label="Bill email" value={qbo.invoice.billEmail} />
                        </s-grid-item>
                        <s-grid-item>
                          <KV label="Currency" value={qbo.invoice.currency} />
                        </s-grid-item>
                        <s-grid-item>
                          <KV label="Txn date" value={qbo.invoice.txnDate} />
                        </s-grid-item>
                        <s-grid-item>
                          <KV label="Due date" value={qbo.invoice.dueDate} />
                        </s-grid-item>
                        <s-grid-item>
                          <KV label="Email status" value={qbo.invoice.emailStatus} />
                        </s-grid-item>
                      </s-grid>

                      {qbo.invoice.productLines.length === 0 ? (
                        <s-paragraph tone="subdued">
                          QBO invoice has no product lines.
                        </s-paragraph>
                      ) : (
                        <s-table>
                          <s-table-header-row>
                            <s-table-header>Qty</s-table-header>
                            <s-table-header>Product(s)</s-table-header>
                            <s-table-header>SKU</s-table-header>
                            <s-table-header>Rate</s-table-header>
                            <s-table-header>Amount</s-table-header>
                          </s-table-header-row>
                          <s-table-body>
                            {qbo.invoice.productLines.map((l, i) => (
                              <s-table-row key={l.id || i}>
                                <s-table-cell>{l.qty ?? "—"}</s-table-cell>
                                <s-table-cell>
                                  {l.description || l.itemName || "—"}
                                </s-table-cell>
                                <s-table-cell>{l.sku || "—"}</s-table-cell>
                                <s-table-cell>
                                  {l.unitPrice != null
                                    ? formatAmount(l.unitPrice, qbo.invoice.currency)
                                    : "—"}
                                </s-table-cell>
                                <s-table-cell>
                                  {l.amount != null
                                    ? formatAmount(l.amount, qbo.invoice.currency)
                                    : "—"}
                                </s-table-cell>
                              </s-table-row>
                            ))}
                          </s-table-body>
                        </s-table>
                      )}

                      <s-box
                        padding="base"
                        border="base"
                        borderRadius="base"
                        background="subdued"
                      >
                        <s-stack direction="block" gap="tight">
                          <TotalsRow
                            label="Subtotal"
                            value={formatAmount(
                              qbo.invoice.productSubtotal,
                              qbo.invoice.currency,
                            )}
                          />
                          <TotalsRow
                            label="Discount"
                            value={
                              qbo.invoice.discount > 0
                                ? `− ${formatAmount(qbo.invoice.discount, qbo.invoice.currency)}`
                                : formatAmount(0, qbo.invoice.currency)
                            }
                            tone={qbo.invoice.discount > 0 ? "success" : undefined}
                          />
                          <TotalsRow
                            label="Shipping charges"
                            value={formatAmount(qbo.invoice.shipping, qbo.invoice.currency)}
                          />
                          <TotalsRow
                            label="Sales tax"
                            value={formatAmount(qbo.invoice.totalTax, qbo.invoice.currency)}
                          />
                          {qbo.invoice.processingFee > 0 && (
                            <TotalsRow
                              label={qbo.invoice.processingFeeLabel || "Processing fee"}
                              value={formatAmount(
                                qbo.invoice.processingFee,
                                qbo.invoice.currency,
                              )}
                            />
                          )}
                          {Math.abs(qbo.invoice.otherCharges) > 0.005 && (
                            <TotalsRow
                              label="Other charges"
                              value={formatAmount(
                                qbo.invoice.otherCharges,
                                qbo.invoice.currency,
                              )}
                            />
                          )}
                          <s-divider />
                          <TotalsRow
                            label="Grand total"
                            value={formatAmount(qbo.invoice.totalAmt, qbo.invoice.currency)}
                            strong
                          />
                          <TotalsRow
                            label="Balance due"
                            value={formatAmount(qbo.invoice.balance, qbo.invoice.currency)}
                            strong
                            tone={qbo.invoice.balance === 0 ? "success" : undefined}
                          />
                        </s-stack>
                      </s-box>

                      {qbo.invoice.linkedPayments.length > 0 && (
                        <s-paragraph tone="subdued">
                          Linked QBO payments:{" "}
                          {qbo.invoice.linkedPayments.map((p) => p.id).join(", ")}
                        </s-paragraph>
                      )}
                    </>
                  )}
                </s-stack>
              ) : (
                <s-paragraph tone="subdued">
                  Invoice not yet synced to QuickBooks. Syncs automatically — check back shortly.
                </s-paragraph>
              )}
            </s-stack>

            {/* ─ Vendor bill (A/P) ─ */}
            {vendorBill && (
              <>
                <s-divider />
                <s-stack direction="block" gap="tight">
                  <s-stack direction="inline" gap="base" alignItems="center">
                    <s-text><strong>Vendor bill (A/P)</strong></s-text>
                    {vendorBill.qboBillId ? (
                      <>
                        <s-badge tone="success">Created</s-badge>
                        {vendorBill.billPaymentStatus === "paid" ? (
                          <s-badge tone="success">Paid</s-badge>
                        ) : (
                          <s-badge tone="neutral">Unpaid</s-badge>
                        )}
                      </>
                    ) : vendorBill.billSyncStatus === "creating" ? (
                      <s-badge tone="info">Creating…</s-badge>
                    ) : vendorBill.billSyncStatus === "error" ? (
                      <s-badge tone="critical">Sync error</s-badge>
                    ) : (
                      <s-badge tone="neutral">Not created</s-badge>
                    )}
                  </s-stack>

                  {vendorBill.qboBillId ? (
                    <s-stack direction="block" gap="base">
                      <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="large-100">
                        <s-grid-item>
                          <KV label="Bill ID" value={vendorBill.qboBillId} />
                        </s-grid-item>
                        <s-grid-item>
                          <KV label="Doc number" value={vendorBill.qboBillDocNumber} />
                        </s-grid-item>
                        <s-grid-item>
                          <KV
                            label="Amount"
                            value={
                              vendorBill.qboBillTotal != null
                                ? formatAmount(vendorBill.qboBillTotal, "USD")
                                : null
                            }
                          />
                        </s-grid-item>
                      </s-grid>
                      {vendorBill.billUrl && (
                        <s-button
                          variant="secondary"
                          onClick={() => window.open(vendorBill.billUrl, "_blank")}
                        >
                          View Vendor Bill ↗
                        </s-button>
                      )}
                    </s-stack>
                  ) : (
                    <s-paragraph tone="subdued">
                      No vendor bill yet. The retail side creates a QBO bill (A/P)
                      automatically once this drop-ship order is fulfilled.
                    </s-paragraph>
                  )}
                </s-stack>
              </>
            )}

          </s-stack>
        </CollapsibleSection>
      )}

      {/* ───── Email history ───── */}
      {invoice && (
        <CollapsibleSection heading={`Email history (${invoice.emailEvents?.length || 0})`} storageKey="wa-ord-emails">
          {!invoice.emailEvents || invoice.emailEvents.length === 0 ? (
            <s-paragraph tone="subdued">
              No invoice emails have been sent yet for this order.
            </s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>When</s-table-header>
                <s-table-header>Type</s-table-header>
                <s-table-header>Trigger</s-table-header>
                <s-table-header>Recipient</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header>Triggered by</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {[...invoice.emailEvents]
                  .sort((a, b) =>
                    String(b.createdAt).localeCompare(String(a.createdAt)),
                  )
                  .map((e, i) => (
                    <s-table-row key={i}>
                      <s-table-cell>
                        {e.createdAt ? new Date(e.createdAt).toLocaleString() : "—"}
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge tone={e.triggerType === "manual" ? "info" : "default"}>
                          {e.triggerType === "manual" ? "Manual" : "Auto"}
                        </s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        {EMAIL_SOURCE_LABEL[e.source] || e.source}
                      </s-table-cell>
                      <s-table-cell>{e.recipient || "—"}</s-table-cell>
                      <s-table-cell>
                        <s-badge tone={e.status === "sent" ? "success" : "critical"}>
                          {e.status === "sent" ? "Sent" : "Failed"}
                        </s-badge>
                      </s-table-cell>
                      <s-table-cell>{e.triggeredBy || "—"}</s-table-cell>
                    </s-table-row>
                  ))}
              </s-table-body>
            </s-table>
          )}
        </CollapsibleSection>
      )}

      {/* ───── Attempt history ───── */}
      {invoice && (
        <CollapsibleSection heading={`Attempt history (${attempts.length})`} storageKey="wa-ord-attempts">
          {attempts.length === 0 ? (
            <s-paragraph tone="subdued">No charge attempts yet.</s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>#</s-table-header>
                <s-table-header>When</s-table-header>
                <s-table-header>Outcome</s-table-header>
                <s-table-header>Amount</s-table-header>
                <s-table-header>NMI txn</s-table-header>
                <s-table-header>Code</s-table-header>
                <s-table-header>Response</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {attempts.map((a) => (
                  <s-table-row key={a._id}>
                    <s-table-cell>{a.attemptNumber}</s-table-cell>
                    <s-table-cell>
                      {a.attemptedAt ? new Date(a.attemptedAt).toLocaleString() : "—"}
                    </s-table-cell>
                    <s-table-cell>
                      <OutcomeBadge outcome={a.outcome} />
                    </s-table-cell>
                    <s-table-cell>{formatAmount(a.amount, a.currency)}</s-table-cell>
                    <s-table-cell>{a.nmiTransactionId || "—"}</s-table-cell>
                    <s-table-cell>{a.nmiResponseCode || "—"}</s-table-cell>
                    <s-table-cell>
                      {a.nmiResponseText || a.errorMessage || "—"}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </CollapsibleSection>
      )}

      {/* ───── Remarks (CRON + admin follow-up timeline) ───── */}
      {invoice && (
        <CollapsibleSection heading={`Remarks (${invoice.remarks?.length || 0})`} storageKey="wa-ord-remarks">
          {!invoice.remarks?.length ? (
            <s-paragraph tone="subdued">
              No remarks yet. Drop-ship collection ticks and admin actions
              (send invoice, collect now) append entries here automatically.
            </s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>When</s-table-header>
                <s-table-header>Kind</s-table-header>
                <s-table-header>Source</s-table-header>
                <s-table-header>Message</s-table-header>
                <s-table-header>Amount</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {[...invoice.remarks].reverse().map((r, i) => {
                  const meta = REMARK_KIND_META[r.kind] || {
                    label: r.kind || "—",
                    tone: "default",
                  };
                  return (
                    <s-table-row key={`${r.createdAt || i}-${i}`}>
                      <s-table-cell>
                        {r.createdAt ? new Date(r.createdAt).toLocaleString() : "—"}
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge tone={meta.tone}>{meta.label}</s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        <s-text tone="subdued">
                          {r.source === "admin"
                            ? "Admin"
                            : r.source === "cron"
                              ? "CRON"
                              : "System"}
                        </s-text>
                      </s-table-cell>
                      <s-table-cell>{r.message || "—"}</s-table-cell>
                      <s-table-cell>
                        {r.amount != null
                          ? formatAmount(r.amount, r.currency || invoice.currency)
                          : "—"}
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          )}
        </CollapsibleSection>
      )}
    </s-page>
  );
}