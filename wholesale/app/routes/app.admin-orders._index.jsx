import { useEffect, useRef } from "react";
import {
  useLoaderData,
  useNavigate,
  useNavigation,
  useRevalidator,
  useSearchParams,
  useFetcher,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import connectDB from "../services/APIService/mongo.service";
import ShopifyOrder from "../models/order.server";
import Invoice from "../models/invoice.server";
import DropshipMapping from "../models/dropshipMapping.server";
import RetailCdoOrder from "../models/retailCdoOrder.server";
import { RETAIL_CUSTOMER_EMAIL } from "../services/dropship/dropship.config";
import { getInvoiceWebUrl } from "../services/qbo/qbo.service";
import {
  carrierDisplayName,
  deriveDeliveryStatus,
  deriveFulfillmentStatus,
} from "../utils/shipping.constants";
import {
  ShipmentStatusBadge,
  PaymentStatusBadge,
  AdvancedFilters,
} from "../components/admin-ui";
import { formatAmount, parseDateOnly, startOfDay } from "../utils/format.utils";

// Admin Orders — orders placed by the retail drop-ship customer
// (DROPSHIP_RETAIL_CUSTOMER_EMAIL). These run on a separate flow from the
// wholesale order pipeline: each new order gets an UNPAID QBO invoice on
// creation, collected via the Admin Order Batch Payment UI
// (/app/admin-orders/batch) rather than an auto-charge CRON. The admin reviews
// all unpaid invoices, enters a single payment reference, and marks the batch
// paid in one step. (Orders ingested before drop-ship invoicing existed remain
// as legacy "Admin order" rows with no invoice.)
//
// This page is read-only — it surfaces what Shopify sent us so an admin can
// audit drop-ship fulfillment.

const PAGE_SIZE = 15;

// Columns exposed as clickable, sortable table headers (retail Order List
// parity). Whitelisted so a hand-edited `?sort=` can't inject an arbitrary
// Mongo path into the query.
const SORT_FIELDS = new Set(["receivedAt", "totalAmount"]);
const DEFAULT_SORT = "receivedAt";

// Fulfillment filter chips. Each maps to the set of fulfillmentStatus values
// we may have stored — both REST webhook values (`fulfilled` / `partial` /
// null) and live-synced GraphQL values (`fulfilled` / `partially_fulfilled` /
// `unfulfilled`) — so the chip works regardless of which path populated it.
const FULFILLMENT_FILTERS = [
  { id: "all", label: "All", match: null },
  { id: "unfulfilled", label: "Unfulfilled", match: ["unfulfilled", null] },
  {
    id: "partial",
    label: "Partially fulfilled",
    match: ["partial", "partially_fulfilled"],
  },
  { id: "fulfilled", label: "Fulfilled", match: ["fulfilled"] },
  { id: "cancelled", label: "Cancelled", match: ["cancelled"] },
];
const FULFILLMENT_FILTER_BY_ID = new Map(
  FULFILLMENT_FILTERS.map((f) => [f.id, f]),
);

// Payment-status options (Shopify financialStatus, matched exactly).
const PAYMENT_OPTIONS = [
  { value: "all", label: "All" },
  { value: "paid", label: "Paid" },
  { value: "pending", label: "Pending" },
  { value: "partially_paid", label: "Partially paid" },
  { value: "refunded", label: "Refunded" },
  { value: "partially_refunded", label: "Partially refunded" },
  { value: "voided", label: "Voided" },
];

// Config for the shared <AdvancedFilters> card. Fulfillment options mirror
// FULFILLMENT_FILTERS so the loader's $in mapping stays the source of truth.
const FILTER_FIELDS = [
  { key: "q", label: "Order number", type: "text", placeholder: "#1091" },
  {
    key: "fulfillment",
    label: "Fulfillment",
    type: "select",
    options: FULFILLMENT_FILTERS.map((f) => ({ value: f.id, label: f.label })),
  },
  {
    key: "payment",
    label: "Payment status",
    type: "select",
    options: PAYMENT_OPTIONS,
  },
  { key: "dateFrom", label: "From date", type: "date" },
  { key: "dateTo", label: "To date", type: "date" },
];
const FILTER_DEFAULTS = { fulfillment: "all", payment: "all" };

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  await connectDB();

  const url = new URL(request.url);
  const fulfillment = url.searchParams.get("fulfillment") || "all";
  const payment = url.searchParams.get("payment") || "all";
  const q = (url.searchParams.get("q") || "").trim();
  const dateFrom = (url.searchParams.get("dateFrom") || "").trim();
  const dateTo = (url.searchParams.get("dateTo") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const sort = SORT_FIELDS.has(url.searchParams.get("sort") || "")
    ? url.searchParams.get("sort")
    : DEFAULT_SORT;
  const dir = url.searchParams.get("dir") === "asc" ? "asc" : "desc";

  // Anchor the whole page on the retail drop-ship customer's email — the
  // single source of truth for "is this an Admin Order". Captures every such
  // order regardless of processingStatus, so orders ingested before the
  // orchestrator's admin_order diversion still show up here.
  const filter = {
    shop: session.shop,
    customerEmail: RETAIL_CUSTOMER_EMAIL,
  };

  const fulfillmentFilter = FULFILLMENT_FILTER_BY_ID.get(fulfillment);
  if (fulfillmentFilter?.match) {
    filter.fulfillmentStatus = { $in: fulfillmentFilter.match };
  }

  // Exact Shopify financial-status match.
  if (payment && payment !== "all") {
    filter.financialStatus = payment;
  }

  // Order-date range (receivedAt), inclusive on both ends.
  const from = parseDateOnly(dateFrom);
  const to = parseDateOnly(dateTo);
  if (from || to) {
    const range = {};
    if (from) range.$gte = startOfDay(from);
    if (to) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      range.$lte = end;
    }
    filter.receivedAt = range;
  }

  if (q) {
    const re = new RegExp(escapeRegex(q), "i");
    filter.$or = [
      { shopifyOrderNumber: re },
      { shopifyOrderName: re },
      { shopifyOrderId: q }, // exact match for a pasted numeric id
    ];
  }

  const total = await ShopifyOrder.countDocuments(filter);
  const rows = await ShopifyOrder.find(filter)
    .sort({ [sort]: dir === "asc" ? 1 : -1 })
    .skip((page - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .select(
      "shopifyOrderId shopifyOrderNumber shopifyOrderName customerEmail " +
        "currency totalAmount financialStatus fulfillmentStatus processingStatus " +
        "fulfillments trackingHistory shippedAt deliveredAt receivedAt invoiceRef",
    )
    .lean();

  // Join the linked drop-ship invoices in one query (no N+1) so the list can
  // show a QBO Invoice column — payment status, a live "Open in QBO" deep
  // link, and an in-app PDF preview — mirroring the retail Order List. Legacy
  // `admin_order` rows have no invoiceRef and degrade to "—".
  const invoiceIds = rows.map((r) => r.invoiceRef).filter(Boolean);
  const invoiceById = new Map();
  if (invoiceIds.length) {
    const invoices = await Invoice.find({ _id: { $in: invoiceIds } })
      .select(
        "qboInvoiceId qboDocNumber paymentStatus paymentMethod amountDue " +
          "amountPaid attemptCount maxAttempts remarks",
      )
      .lean();
    for (const inv of invoices) invoiceById.set(inv._id.toString(), inv);
  }

  // Vendor Bill (A/P) join — cross-repo, READ-ONLY. Each drop-ship Admin Order
  // has a linked ns-retail order that carries the retail QBO **Vendor Bill**
  // (what the retail company owes Natural Solution Wholesale for the dropship).
  // Resolve it in two hops on the shared DB (no N+1, no live API call):
  //   wholesale shopifyOrderId → dropship_mappings.wholesaleOrderId
  //   → mapping.retailOrderGid → cdo_orders.shopifyOrderId → retailQbo bill fields.
  // The bill is owned + written by ns-retail; the wholesale list only reads it.
  const wsOrderIds = rows.map((r) => String(r.shopifyOrderId)).filter(Boolean);
  const vendorBillByOrderId = new Map();
  if (wsOrderIds.length) {
    const maps = await DropshipMapping.find({
      wholesaleOrderId: { $in: wsOrderIds },
    })
      .select("wholesaleOrderId retailOrderGid")
      .lean();
    const retailGidByWsId = new Map();
    const retailGids = [];
    for (const m of maps) {
      if (m.wholesaleOrderId && m.retailOrderGid) {
        retailGidByWsId.set(String(m.wholesaleOrderId), m.retailOrderGid);
        retailGids.push(m.retailOrderGid);
      }
    }
    if (retailGids.length) {
      const cdoRows = await RetailCdoOrder.find({
        shopifyOrderId: { $in: retailGids },
      })
        .select("shopifyOrderId retailQbo")
        .lean();
      const rqByGid = new Map();
      for (const c of cdoRows) rqByGid.set(c.shopifyOrderId, c.retailQbo || null);
      for (const [wsId, gid] of retailGidByWsId) {
        const rq = rqByGid.get(gid);
        if (rq?.qboBillId) {
          vendorBillByOrderId.set(wsId, {
            billId: rq.qboBillId,
            docNumber: rq.qboBillDocNumber || null,
            amount: rq.qboBillTotal ?? null,
            billUrl: rq.billUrl || null,
            syncStatus: rq.billSyncStatus || null,
            paymentStatus: rq.billPaymentStatus || null,
            reconcileStatus: rq.billReconcileStatus || null,
          });
        }
      }
    }
  }

  return {
    rows: rows.map((r) => {
      const fulfillments = Array.isArray(r.fulfillments) ? r.fulfillments : [];
      const deliveryStatus = deriveDeliveryStatus(fulfillments);

      // Delivery date — prefer the order-level official stamp, then fall back
      // to the latest per-shipment `deliveredAt`, then to the tracking-history
      // row where the carrier first reported `delivered`. The order-level
      // value is only set once EVERY active shipment is delivered, so a fully
      // delivered order can still lack it; these fallbacks surface a real
      // delivery date without a per-row live Shopify call. Gated to fully
      // delivered orders so a partial delivery never shows a misleading date.
      let deliveredAtMs = r.deliveredAt ? new Date(r.deliveredAt).getTime() : null;
      if (deliveredAtMs == null && deliveryStatus === "delivered") {
        const candidates = [
          ...fulfillments.map((f) =>
            f.deliveredAt ? new Date(f.deliveredAt).getTime() : NaN,
          ),
          ...(Array.isArray(r.trackingHistory) ? r.trackingHistory : [])
            .filter(
              (h) =>
                String(h.shipmentStatus || "").toLowerCase() === "delivered" &&
                h.at,
            )
            .map((h) => new Date(h.at).getTime()),
        ].filter((t) => Number.isFinite(t));
        if (candidates.length) deliveredAtMs = Math.max(...candidates);
      }

      return {
        id: r._id.toString(),
        shopifyOrderId: r.shopifyOrderId,
        shopifyOrderNumber: r.shopifyOrderNumber || null,
        shopifyOrderName: r.shopifyOrderName || null,
        currency: r.currency || "USD",
        totalAmount: r.totalAmount ?? null,
        financialStatus: r.financialStatus || null,
        // Self-healed from fulfillments[] so a shipped order never shows
        // "Unfulfilled" while its Delivery status reads "Shipped".
        fulfillmentStatus: deriveFulfillmentStatus(r.fulfillmentStatus, fulfillments),
        processingStatus: r.processingStatus || null,
        // Fulfillment (ship) date — earliest fulfillment date across
        // fulfillments[], denormalized onto the order. Shown under the
        // Fulfillment badge.
        shippedAt: r.shippedAt ? new Date(r.shippedAt).toISOString() : null,
        // Order-level carrier delivery status, rolled up from fulfillments[].
        deliveryStatus,
        deliveredAt: deliveredAtMs ? new Date(deliveredAtMs).toISOString() : null,
        receivedAt: r.receivedAt ? new Date(r.receivedAt).toISOString() : null,
        // Tracking — one entry per fulfillment that carries tracking, each a
        // carrier name + its resolved deep-link (carrier page, tracking number
        // pre-filled). The tracking number itself is intentionally not shown
        // in the list; the carrier name is the clickable link.
        tracking: fulfillments
          .filter((f) => f.trackingNumber || f.trackingUrl)
          .map((f) => ({
            company: carrierDisplayName(f.carrierKey, f.trackingCompany),
            url: f.trackingUrl || null,
          })),
        // Linked drop-ship invoice summary for the QBO Invoice column. The
        // QBO web URL is built here in the loader (server-only) and passed as
        // a plain string so the client never imports the QBO service.
        invoice: (() => {
          const inv = r.invoiceRef
            ? invoiceById.get(r.invoiceRef.toString())
            : null;
          if (!inv?.qboInvoiceId) return null;
          return {
            qboInvoiceId: inv.qboInvoiceId,
            qboDocNumber: inv.qboDocNumber || null,
            paymentStatus: inv.paymentStatus || null,
            qboInvoiceUrl: getInvoiceWebUrl(inv.qboInvoiceId),
          };
        })(),
        // Linked ns-retail Vendor Bill (A/P) — amount + status for the Vendor
        // Bill column. Null when the order has no linked retail bill yet.
        vendorBill: vendorBillByOrderId.get(String(r.shopifyOrderId)) || null,
        // Invoice remarks for the Remarks column — the latest drop-ship
        // collection / admin note + total count (full timeline on the detail
        // page). Mirrors the wholesale Orders list's Remarks column.
        remarks: (() => {
          const inv = r.invoiceRef
            ? invoiceById.get(r.invoiceRef.toString())
            : null;
          if (!inv) return null;
          const list = Array.isArray(inv.remarks) ? inv.remarks : [];
          const last = list.length ? list[list.length - 1] : null;
          return {
            paymentStatus: inv.paymentStatus || null,
            amountDue: inv.amountDue ?? null,
            amountPaid: inv.amountPaid ?? null,
            attemptCount: inv.attemptCount ?? null,
            maxAttempts: inv.maxAttempts ?? null,
            latest: last
              ? { message: last.message || null, createdAt: last.createdAt || null }
              : null,
            count: list.length,
          };
        })(),
      };
    }),
    total,
    page,
    pageSize: PAGE_SIZE,
    sort,
    dir,
    fulfillment,
    payment,
    q,
    dateFrom,
    dateTo,
    customerEmail: RETAIL_CUSTOMER_EMAIL,
  };
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Friendly label + tone for the fulfillment-status cell. Tolerant of both
// REST and GraphQL-derived values.
const FULFILLMENT_STATUS_META = {
  fulfilled: { tone: "success", label: "Fulfilled" },
  partial: { tone: "info", label: "Partially fulfilled" },
  partially_fulfilled: { tone: "info", label: "Partially fulfilled" },
  unfulfilled: { tone: "warning", label: "Unfulfilled" },
  restocked: { tone: "default", label: "Restocked" },
  cancelled: { tone: "default", label: "Cancelled" },
};

function FulfillmentBadge({ status }) {
  if (!status) return <s-badge tone="warning">Unfulfilled</s-badge>;
  const m = FULFILLMENT_STATUS_META[status] || {
    tone: "default",
    label: status,
  };
  return <s-badge tone={m.tone}>{m.label}</s-badge>;
}

function FinancialBadge({ status }) {
  if (!status) return <s-text tone="subdued">—</s-text>;
  const paid = status === "paid";
  return (
    <s-badge tone={paid ? "success" : "default"}>
      {status.replace(/_/g, " ")}
    </s-badge>
  );
}

// Carrier tracking link(s), rendered inside the Fulfillment cell (under the
// badge) — one clickable carrier link per shipment, deep-linking to the
// carrier's tracking page (the tracking number is pre-filled in the URL but
// intentionally not shown; clicking the carrier name opens its tracking
// page). Renders nothing until the order ships, so an unfulfilled row shows
// just its badge. Falls back to plain carrier text when no URL resolved.
function TrackingLinks({ tracking }) {
  if (!Array.isArray(tracking) || tracking.length === 0) return null;
  return (
    <s-stack direction="block" gap="none">
      {tracking.map((t, i) =>
        t.url ? (
          <s-link key={i} href={t.url} target="_blank">
            {t.company || "Track"} ↗
          </s-link>
        ) : (
          <s-text key={i}>{t.company || "Tracking"}</s-text>
        ),
      )}
    </s-stack>
  );
}

// QBO Invoice cell — drop-ship invoice summary, mirroring the retail Order
// List's QBO column: the invoice payment status (the wholesale→retail
// collection state, distinct from Shopify's customer-facing "Payment"),
// an in-app PDF preview, and a deep link into QuickBooks. Renders "—" for
// legacy admin orders that never had an invoice created.
function QboInvoiceCell({ invoice, previewing, onPreview }) {
  if (!invoice?.qboInvoiceId) return <s-text tone="subdued">—</s-text>;
  return (
    <s-stack direction="block" gap="small-200">
      <PaymentStatusBadge status={invoice.paymentStatus} />
      <s-stack direction="inline" gap="small-200" alignItems="center" wrap>
        <s-button variant="tertiary" disabled={previewing} onClick={onPreview}>
          {previewing ? "Opening…" : "Preview"}
        </s-button>
        {invoice.qboInvoiceUrl && (
          <s-link href={invoice.qboInvoiceUrl} target="_blank">
            Open in QBO{invoice.qboDocNumber ? ` ${invoice.qboDocNumber}` : ""} ↗
          </s-link>
        )}
      </s-stack>
    </s-stack>
  );
}

// Vendor Bill cell — the linked ns-retail Vendor Bill (A/P): what the retail
// company owes Natural Solution Wholesale for this drop-ship order. Shows the
// bill amount + a settlement-status badge (Paid once reconciled against the
// paid wholesale invoice, else Unpaid / Error), plus a deep link into QBO.
// Renders "—" for orders with no linked retail bill (e.g. legacy admin orders).
function VendorBillCell({ bill, currency }) {
  if (!bill?.billId) return <s-text tone="subdued">—</s-text>;
  let badge;
  if (bill.paymentStatus === "paid") {
    badge = <s-badge tone="success">Paid</s-badge>;
  } else if (bill.reconcileStatus === "error") {
    badge = <s-badge tone="critical">Reconcile error</s-badge>;
  } else if (bill.syncStatus === "error") {
    badge = <s-badge tone="critical">Error</s-badge>;
  } else if (bill.syncStatus === "created") {
    badge = <s-badge tone="warning">Unpaid</s-badge>;
  } else {
    badge = <s-badge tone="default">{bill.syncStatus || "Pending"}</s-badge>;
  }
  return (
    <s-stack direction="block" gap="small-200">
      <s-text>
        {bill.amount != null ? formatAmount(bill.amount, currency) : "—"}
      </s-text>
      {badge}
      {bill.billUrl && (
        <s-link href={bill.billUrl} target="_blank">
          Open in QBO{bill.docNumber ? ` ${bill.docNumber}` : ""} ↗
        </s-link>
      )}
    </s-stack>
  );
}

// Remarks cell — the latest drop-ship collection / admin note from the
// invoice's remarks[] timeline + a "+N more" pointer to the detail page.
// Surfaces a "Collection failed" header (with the outstanding balance +
// attempt count) when the drop-ship charge has exhausted its retries — so the
// duplicate-transaction / decline errors are visible at a glance. Renders "—"
// when there's nothing to show. Mirrors the wholesale Orders list's Remarks
// column (drop-ship invoices have no cheque/ACH "Payment Due" state).
function RemarksCell({ remarks, currency }) {
  if (!remarks) return <s-text tone="subdued">—</s-text>;
  const latest = remarks.latest;
  const moreCount = Math.max(0, (remarks.count || 0) - 1);
  const failed = remarks.paymentStatus === "failed";
  const outstanding = Number(
    ((remarks.amountDue ?? 0) - (remarks.amountPaid ?? 0)).toFixed(2),
  );
  if (!failed && !latest) return <s-text tone="subdued">—</s-text>;
  return (
    <s-stack direction="block" gap="none">
      {failed && (
        <>
          <s-text tone="critical">
            <strong>Collection failed — {formatAmount(outstanding, currency)}</strong>
          </s-text>
          {remarks.attemptCount != null && remarks.maxAttempts != null && (
            <s-text tone="critical">
              {remarks.attemptCount}/{remarks.maxAttempts} attempts
            </s-text>
          )}
        </>
      )}
      {latest && (
        <s-text tone="subdued">
          {latest.message}
          {latest.createdAt
            ? ` · ${new Date(latest.createdAt).toLocaleDateString()}`
            : ""}
        </s-text>
      )}
      {moreCount > 0 && (
        <s-text tone="subdued">+{moreCount} more (see Order)</s-text>
      )}
    </s-stack>
  );
}

export default function AdminOrdersList() {
  const {
    rows,
    total,
    page,
    pageSize,
    sort,
    dir,
    fulfillment,
    payment,
    q,
    dateFrom,
    dateTo,
    customerEmail,
  } = useLoaderData();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const [searchParams, setSearchParams] = useSearchParams();
  const loadedToastShown = useRef(false);

  useEffect(() => {
    if (loadedToastShown.current) return;
    loadedToastShown.current = true;
    shopify?.toast?.show(
      `Loaded ${total} admin ${total === 1 ? "order" : "orders"}`,
    );
  }, [total, shopify]);

  // ── In-app QBO invoice PDF preview ───────────────────────────────────
  // One fetcher serves the whole list (only one preview opens at a time).
  // The window is opened synchronously in the click (user gesture) to
  // survive popup blockers; we swap in the blob URL once the base64 PDF
  // returns. Reuses the shared /api/admin/orders/:id/qbo-invoice-pdf
  // endpoint that the Admin Order Details page already uses.
  const pdfFetcher = useFetcher();
  const pdfWindowRef = useRef(null);
  const handledPdfRef = useRef(null);
  const previewingId =
    pdfFetcher.state !== "idle" ? pdfFetcher.formData?.get("orderId") : null;

  const onPreviewInvoice = (orderId) => {
    pdfWindowRef.current = window.open("about:blank", "_blank");
    pdfFetcher.submit(
      { orderId: orderId || "" },
      { method: "POST", action: `/api/admin/orders/${orderId}/qbo-invoice-pdf` },
    );
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
      shopify?.toast?.show(data.message || "Failed to load invoice PDF", {
        isError: true,
      });
    }
  }, [pdfFetcher.data, pdfFetcher.state, shopify]);

  // Clickable-header sort. Toggles desc → asc on the active column,
  // defaulting new columns to desc. Preserves the active filters (they
  // live in searchParams) and resets to page 1.
  const setSort = (field) => {
    const nextDir = sort === field && dir === "desc" ? "asc" : "desc";
    const merged = new URLSearchParams(searchParams);
    merged.set("sort", field);
    merged.set("dir", nextDir);
    merged.delete("page");
    setSearchParams(merged);
  };
  const sortArrow = (field) =>
    sort === field ? (dir === "asc" ? " ▲" : " ▼") : "";
  // Only carry sort/dir through the filter form when they're non-default,
  // so an unsorted, unfiltered view keeps a clean URL.
  const sortParams =
    sort !== DEFAULT_SORT || dir !== "desc" ? { sort, dir } : {};

  const tableLoading = navigation.state === "loading" || revalidator.state !== "idle";
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const firstShown = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastShown = Math.min(page * pageSize, total);

  // Pagination only — filter navigation is owned by <AdvancedFilters>.
  const updateParams = (next) => {
    const merged = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === "" || v === undefined) merged.delete(k);
      else merged.set(k, String(v));
    }
    if (!("page" in next)) merged.delete("page");
    setSearchParams(merged);
  };

  const hasActiveFilter =
    Boolean(q) ||
    (fulfillment && fulfillment !== "all") ||
    (payment && payment !== "all") ||
    Boolean(dateFrom) ||
    Boolean(dateTo);

  return (
    <s-page inlineSize="large" heading="Retail Orders">
      <s-box paddingBlockEnd="base">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-button variant="primary" onClick={() => navigate("/app/admin-orders/batch")}>
            Batch Payment
          </s-button>
          <s-text tone="subdued">
            Mark multiple unpaid invoices paid in a single operation
          </s-text>
        </s-stack>
      </s-box>
      <AdvancedFilters
        fields={FILTER_FIELDS}
        values={{ q, fulfillment, payment, dateFrom, dateTo }}
        defaults={FILTER_DEFAULTS}
        extraParams={sortParams}
        applying={tableLoading}
        onRefresh={() => revalidator.revalidate()}
        refreshing={revalidator.state !== "idle"}
        description={`Orders placed by the retail drop-ship customer${
          customerEmail ? ` (${customerEmail})` : ""
        }. Each new order gets an unpaid QBO invoice on creation. Use the Batch Payment button above to mark multiple invoices paid at once with a single payment reference.`}
      />
      <s-section padding="none">
        <s-box padding="base">
          <s-text tone="subdued">
            {total === 0
              ? "No orders"
              : `Showing ${firstShown}–${lastShown} of ${total} order${
                  total === 1 ? "" : "s"
                }`}
          </s-text>
        </s-box>

        {rows.length === 0 ? (
          <s-box padding="large-500">
            <s-stack
              direction="block"
              gap="base"
              alignItems="center"
              justifyContent="center"
            >
              <s-text>{hasActiveFilter ? "🔍" : "📭"}</s-text>
              <s-heading>
                {hasActiveFilter ? "No matching orders" : "No admin orders yet"}
              </s-heading>
              <s-paragraph tone="subdued">
                {hasActiveFilter
                  ? "No admin orders match the current filters. Try broadening or clearing them."
                  : "Orders placed by the retail drop-ship customer will appear here."}
              </s-paragraph>
            </s-stack>
          </s-box>
        ) : (
          <s-table loading={tableLoading}>
            <s-table-header-row>
              <s-table-header>
                <s-clickable onClick={() => setSort("receivedAt")}>
                  Order{sortArrow("receivedAt")}
                </s-clickable>
              </s-table-header>
              <s-table-header>
                <s-clickable onClick={() => setSort("totalAmount")}>
                  Total{sortArrow("totalAmount")}
                </s-clickable>
              </s-table-header>
              <s-table-header>Payment</s-table-header>
              <s-table-header>Fulfillment</s-table-header>
              <s-table-header>Delivery status</s-table-header>
              <s-table-header>QBO Invoice</s-table-header>
              <s-table-header>Vendor Bill</s-table-header>
              <s-table-header>Remarks</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((r) => {
                const orderLabel =
                  r.shopifyOrderName ||
                  (r.shopifyOrderNumber
                    ? `#${r.shopifyOrderNumber}`
                    : r.shopifyOrderId);
                return (
                  <s-table-row key={r.id}>
                    <s-table-cell>
                      <s-stack direction="block" gap="none">
                        <s-text>{orderLabel}</s-text>
                        <s-text tone="subdued">
                          {r.receivedAt
                            ? new Date(r.receivedAt).toLocaleString()
                            : "—"}
                        </s-text>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text>
                        {r.totalAmount != null
                          ? formatAmount(r.totalAmount, r.currency)
                          : "—"}
                      </s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <FinancialBadge status={r.financialStatus} />
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="block" gap="small-200">
                        {r.shippedAt ? (
                          <s-text tone="subdued">
                            {new Date(r.shippedAt).toLocaleDateString()}
                          </s-text>
                        ) : null}
                        <FulfillmentBadge status={r.fulfillmentStatus} />
                        <TrackingLinks tracking={r.tracking} />
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="block" gap="small-200">
                        {r.deliveredAt ? (
                          <s-text tone="subdued">
                            {new Date(r.deliveredAt).toLocaleDateString()}
                          </s-text>
                        ) : null}
                        <ShipmentStatusBadge status={r.deliveryStatus} />
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <QboInvoiceCell
                        invoice={r.invoice}
                        previewing={previewingId === r.id}
                        onPreview={() => onPreviewInvoice(r.id)}
                      />
                    </s-table-cell>
                    <s-table-cell>
                      <VendorBillCell bill={r.vendorBill} currency={r.currency} />
                    </s-table-cell>
                    <s-table-cell>
                      <RemarksCell remarks={r.remarks} currency={r.currency} />
                    </s-table-cell>
                    <s-table-cell>
                      <s-button
                        variant="tertiary"
                        accessibilityLabel={`View admin order ${orderLabel}`}
                        onClick={() => navigate(`/app/admin-orders/${r.id}`)}
                      >
                        View
                      </s-button>
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        )}

        {total > 0 && (
          <s-box padding="base">
            <s-stack
              direction="inline"
              gap="base"
              alignItems="center"
              justifyContent="space-between"
            >
              <s-text tone="subdued">
                Showing {firstShown}–{lastShown} of {total}
              </s-text>
              <s-stack
                direction="inline"
                gap="small-200"
                alignItems="center"
              >
                <s-button
                  variant="tertiary"
                  disabled={page <= 1}
                  onClick={() => updateParams({ page: page - 1 })}
                  icon="arrow-left"
                >
                  Previous
                </s-button>
                <s-text tone="subdued">
                  Page {page} of {totalPages}
                </s-text>
                <s-button
                  variant="tertiary"
                  disabled={page >= totalPages}
                  onClick={() => updateParams({ page: page + 1 })}
                >
                  Next
                </s-button>
              </s-stack>
            </s-stack>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}
