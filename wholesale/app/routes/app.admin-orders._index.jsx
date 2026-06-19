import { useEffect, useRef } from "react";
import {
  useLoaderData,
  useNavigate,
  useNavigation,
  useSearchParams,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import connectDB from "../services/APIService/mongo.service";
import ShopifyOrder from "../models/order.server";
import { RETAIL_CUSTOMER_EMAIL } from "../services/dropship/dropship.config";
import {
  carrierDisplayName,
  deriveDeliveryStatus,
} from "../utils/shipping.constants";
import { ShipmentStatusBadge, AdvancedFilters } from "../components/admin-ui";
import { formatAmount, parseDateOnly, startOfDay } from "../utils/format.utils";

// Admin Orders — orders placed by the retail drop-ship customer
// (DROPSHIP_RETAIL_CUSTOMER_EMAIL). These run on a separate flow from the
// wholesale order pipeline: each new order gets an UNPAID QBO invoice on
// creation, and the dedicated process-dropship-payments CRON collects it
// against the configured drop-ship NMI vault (DROPSHIP_NMI_VAULT_ID) — they
// are NOT touched by the wholesale payment CRON. (Orders ingested before
// drop-ship invoicing existed remain as legacy "Admin order" rows with no
// invoice.)
//
// This page is read-only — it surfaces what Shopify sent us so an admin can
// audit drop-ship fulfillment.

const PAGE_SIZE = 15;

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
    .sort({ receivedAt: -1 })
    .skip((page - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .select(
      "shopifyOrderId shopifyOrderNumber shopifyOrderName customerEmail " +
        "currency totalAmount financialStatus fulfillmentStatus processingStatus " +
        "fulfillments deliveredAt receivedAt",
    )
    .lean();

  return {
    rows: rows.map((r) => {
      const fulfillments = Array.isArray(r.fulfillments) ? r.fulfillments : [];
      const trackingCount = fulfillments.filter((f) => f.trackingNumber).length;
      const firstTracked = fulfillments.find((f) => f.trackingNumber) || null;
      return {
        id: r._id.toString(),
        shopifyOrderId: r.shopifyOrderId,
        shopifyOrderNumber: r.shopifyOrderNumber || null,
        shopifyOrderName: r.shopifyOrderName || null,
        currency: r.currency || "USD",
        totalAmount: r.totalAmount ?? null,
        financialStatus: r.financialStatus || null,
        fulfillmentStatus: r.fulfillmentStatus || null,
        processingStatus: r.processingStatus || null,
        // Order-level carrier delivery status, rolled up from fulfillments[].
        deliveryStatus: deriveDeliveryStatus(fulfillments),
        deliveredAt: r.deliveredAt ? new Date(r.deliveredAt).toISOString() : null,
        receivedAt: r.receivedAt ? new Date(r.receivedAt).toISOString() : null,
        trackingCount,
        firstTracking: firstTracked
          ? {
              carrier: carrierDisplayName(
                firstTracked.carrierKey,
                firstTracked.trackingCompany,
              ),
              number: firstTracked.trackingNumber || null,
            }
          : null,
      };
    }),
    total,
    page,
    pageSize: PAGE_SIZE,
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

export default function AdminOrdersList() {
  const {
    rows,
    total,
    page,
    pageSize,
    fulfillment,
    payment,
    q,
    dateFrom,
    dateTo,
    customerEmail,
  } = useLoaderData();
  const navigate = useNavigate();
  const navigation = useNavigation();
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

  const tableLoading = navigation.state === "loading";
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
    <s-page inlineSize="large" heading="Admin Orders">
      <AdvancedFilters
        fields={FILTER_FIELDS}
        values={{ q, fulfillment, payment, dateFrom, dateTo }}
        defaults={FILTER_DEFAULTS}
        applying={tableLoading}
        description={`Orders placed by the retail drop-ship customer${
          customerEmail ? ` (${customerEmail})` : ""
        }. Each new order gets an unpaid QBO invoice on creation; the drop-ship payment job collects it automatically against the card on file and marks it paid in QBO. They are handled separately from the wholesale payment flow.`}
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
              <s-table-header>Order</s-table-header>
              <s-table-header>Total</s-table-header>
              <s-table-header>Payment</s-table-header>
              <s-table-header>Fulfillment</s-table-header>
              <s-table-header>Delivery status</s-table-header>
              <s-table-header>Tracking</s-table-header>
              <s-table-header>Order date</s-table-header>
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
                      <s-text>{orderLabel}</s-text>
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
                      <FulfillmentBadge status={r.fulfillmentStatus} />
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="block" gap="none">
                        <ShipmentStatusBadge status={r.deliveryStatus} />
                        {r.deliveryStatus === "delivered" && r.deliveredAt ? (
                          <s-text tone="subdued">
                            {new Date(r.deliveredAt).toLocaleDateString()}
                          </s-text>
                        ) : null}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      {r.trackingCount > 0 ? (
                        <s-stack direction="block" gap="none">
                          <s-text>
                            {r.firstTracking?.carrier || "Tracking"}
                            {r.firstTracking?.number
                              ? ` · ${r.firstTracking.number}`
                              : ""}
                          </s-text>
                          {r.trackingCount > 1 && (
                            <s-text tone="subdued">
                              +{r.trackingCount - 1} more
                            </s-text>
                          )}
                        </s-stack>
                      ) : (
                        <s-text tone="subdued">—</s-text>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      {r.receivedAt
                        ? new Date(r.receivedAt).toLocaleString()
                        : "—"}
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
