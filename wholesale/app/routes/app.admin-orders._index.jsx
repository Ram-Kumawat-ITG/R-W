import { useEffect, useRef, useState } from "react";
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
import { carrierDisplayName } from "../utils/shipping.constants";
import { formatAmount } from "../utils/format.utils";

// Admin Orders — orders placed by the retail drop-ship customer
// (DROPSHIP_RETAIL_CUSTOMER_EMAIL). These are already paid and run on a
// completely separate flow from the wholesale order pipeline: no QBO invoice,
// no NMI charge, and the payment/commission CRON never touches them (it only
// iterates the Invoice collection, and Admin Orders never produce invoices).
//
// This page is read-only — it surfaces what Shopify sent us so an admin can
// audit drop-ship fulfillment without the wholesale payment machinery.

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

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  await connectDB();

  const url = new URL(request.url);
  const fulfillment = url.searchParams.get("fulfillment") || "all";
  const q = (url.searchParams.get("q") || "").trim();
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
        "fulfillments receivedAt",
    )
    .lean();

  // Chip badge counts — one grouped aggregation on fulfillmentStatus, scoped
  // to Admin Orders (and the active search) so the numbers track what's shown.
  const countFilter = {
    shop: session.shop,
    customerEmail: RETAIL_CUSTOMER_EMAIL,
  };
  if (q) countFilter.$or = filter.$or;
  const grouped = await ShopifyOrder.aggregate([
    { $match: countFilter },
    { $group: { _id: "$fulfillmentStatus", n: { $sum: 1 } } },
  ]);
  const countByFulfillment = { all: 0 };
  for (const f of FULFILLMENT_FILTERS) {
    if (f.id !== "all") countByFulfillment[f.id] = 0;
  }
  for (const g of grouped) {
    countByFulfillment.all += g.n;
    for (const f of FULFILLMENT_FILTERS) {
      if (f.match && f.match.includes(g._id)) {
        countByFulfillment[f.id] += g.n;
      }
    }
  }

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
    q,
    countByFulfillment,
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
    q,
    countByFulfillment,
    customerEmail,
  } = useLoaderData();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchInput, setSearchInput] = useState(q || "");
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

  const updateParams = (next) => {
    const merged = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === "" || v === undefined) merged.delete(k);
      else merged.set(k, String(v));
    }
    if (!("page" in next)) merged.delete("page");
    setSearchParams(merged);
  };

  const onFulfillmentChip = (id) =>
    updateParams({ fulfillment: id === "all" ? null : id });
  const onSearchSubmit = (e) => {
    e?.preventDefault?.();
    updateParams({ q: searchInput.trim() || null });
  };
  const onSearchClear = () => {
    setSearchInput("");
    updateParams({ q: null });
  };

  const firstShown = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastShown = Math.min(page * pageSize, total);

  return (
    <s-page inlineSize="large" heading="Admin Orders">
      <s-section padding="none">
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            <s-paragraph tone="subdued">
              Orders placed by the retail drop-ship customer
              {customerEmail ? ` (${customerEmail})` : ""}. These are already
              paid and are handled separately from the wholesale flow — no
              invoice is created and the payment / commission jobs never process
              them.
            </s-paragraph>
            <form onSubmit={onSearchSubmit}>
              <s-stack direction="inline" gap="small-200" alignItems="end">
                <s-search-field
                  label="Search"
                  labelAccessibilityVisibility="exclusive"
                  placeholder="Search by order # or name"
                  value={searchInput}
                  onInput={(e) => setSearchInput(e?.currentTarget?.value ?? "")}
                />
                <s-button variant="primary" type="submit">
                  Search
                </s-button>
                {q && (
                  <s-button variant="tertiary" onClick={onSearchClear}>
                    Clear
                  </s-button>
                )}
              </s-stack>
            </form>
            <s-stack direction="inline" gap="small-200">
              {FULFILLMENT_FILTERS.map((f) => {
                const active = fulfillment === f.id;
                const n = countByFulfillment[f.id] ?? 0;
                return (
                  <s-clickable-chip
                    key={f.id}
                    color={active ? "strong" : "base"}
                    accessibilityLabel={`Filter by ${f.label}`}
                    onClick={() => onFulfillmentChip(f.id)}
                  >
                    {f.label} ({n})
                  </s-clickable-chip>
                );
              })}
            </s-stack>
          </s-stack>
        </s-box>

        {rows.length === 0 ? (
          <s-box padding="large-500">
            <s-stack
              direction="block"
              gap="base"
              alignItems="center"
              justifyContent="center"
            >
              <s-text>{q ? "🔍" : "📭"}</s-text>
              <s-heading>
                {q
                  ? "No matches"
                  : fulfillment === "all"
                    ? "No admin orders yet"
                    : "No admin orders in this status"}
              </s-heading>
              <s-paragraph tone="subdued">
                {q
                  ? `No admin orders match "${q}". Try a different keyword or clear the search.`
                  : fulfillment === "all"
                    ? "Orders placed by the retail drop-ship customer will appear here."
                    : "Try changing the fulfillment filter."}
              </s-paragraph>
              {q && <s-button onClick={onSearchClear}>Clear search</s-button>}
            </s-stack>
          </s-box>
        ) : (
          <s-table loading={tableLoading}>
            <s-table-header-row>
              <s-table-header>Order</s-table-header>
              <s-table-header>Total</s-table-header>
              <s-table-header>Payment</s-table-header>
              <s-table-header>Fulfillment</s-table-header>
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
