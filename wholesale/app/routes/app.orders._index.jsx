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
import Invoice from "../models/invoice.server";

const PAGE_SIZE = 25;

// processingStatus values that surface as filter chips. Order matters —
// it drives the chip strip left-to-right.
const STATUS_FILTERS = [
  { id: "all", label: "All" },
  { id: "scheduled", label: "Scheduled" },
  { id: "pending_approval", label: "Pending approval" },
  { id: "failed", label: "Failed" },
  { id: "completed", label: "Completed" },
  { id: "rejected", label: "Rejected" },
];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  await connectDB();

  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "all";
  const q = (url.searchParams.get("q") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));

  const filter = { shop: session.shop };
  if (status !== "all") filter.processingStatus = status;
  if (q) {
    // Match by order number, order name, or customer email. Case-insensitive.
    const re = new RegExp(escapeRegex(q), "i");
    filter.$or = [
      { shopifyOrderNumber: re },
      { shopifyOrderName: re },
      { customerEmail: re },
      { shopifyOrderId: q }, // exact match for numeric id paste
    ];
  }

  const total = await ShopifyOrder.countDocuments(filter);
  const rows = await ShopifyOrder.find(filter)
    .sort({ receivedAt: -1 })
    .skip((page - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .select(
      "shopifyOrderId shopifyOrderNumber shopifyOrderName customerEmail " +
        "currency totalAmount processingStatus paymentStatus paidAt " +
        "qboInvoiceId invoiceRef receivedAt completedAt processingError rejectionCode",
    )
    .lean();

  // Pull the linked invoices in one query so we can show attemptCount /
  // lastAttemptError inline without N+1 lookups.
  const invoiceIds = rows.map((r) => r.invoiceRef).filter(Boolean);
  const invoiceById = new Map();
  if (invoiceIds.length) {
    const invoices = await Invoice.find({ _id: { $in: invoiceIds } })
      .select("paymentStatus attemptCount maxAttempts lastAttemptError amountDue amountPaid")
      .lean();
    for (const inv of invoices) invoiceById.set(inv._id.toString(), inv);
  }

  // Aggregate counts per status for the chip badges. One query, group by
  // processingStatus. Constrained to the same shop + search filter so the
  // counts reflect what the user is actually looking at.
  const countFilter = { shop: session.shop };
  if (q) countFilter.$or = filter.$or;
  const counts = await ShopifyOrder.aggregate([
    { $match: countFilter },
    { $group: { _id: "$processingStatus", n: { $sum: 1 } } },
  ]);
  const countByStatus = { all: 0 };
  for (const c of counts) {
    countByStatus[c._id] = c.n;
    countByStatus.all += c.n;
  }

  return {
    rows: rows.map((r) => {
      const inv = r.invoiceRef ? invoiceById.get(r.invoiceRef.toString()) : null;
      return {
        id: r._id.toString(),
        shopifyOrderId: r.shopifyOrderId,
        shopifyOrderNumber: r.shopifyOrderNumber || null,
        shopifyOrderName: r.shopifyOrderName || null,
        customerEmail: r.customerEmail || "",
        currency: r.currency || "USD",
        totalAmount: r.totalAmount ?? null,
        processingStatus: r.processingStatus,
        paymentStatus: r.paymentStatus,
        paidAt: r.paidAt || null,
        qboInvoiceId: r.qboInvoiceId || null,
        receivedAt: r.receivedAt || null,
        completedAt: r.completedAt || null,
        processingError: r.processingError || null,
        rejectionCode: r.rejectionCode || null,
        invoice: inv
          ? {
              paymentStatus: inv.paymentStatus,
              attemptCount: inv.attemptCount,
              maxAttempts: inv.maxAttempts,
              lastAttemptError: inv.lastAttemptError || null,
              amountDue: inv.amountDue,
              amountPaid: inv.amountPaid,
            }
          : null,
      };
    }),
    total,
    page,
    pageSize: PAGE_SIZE,
    status,
    q,
    countByStatus,
  };
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default function OrdersList() {
  const { rows, total, page, pageSize, status, q, countByStatus } =
    useLoaderData();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchInput, setSearchInput] = useState(q || "");
  const loadedToastShown = useRef(false);

  // One-time toast on first mount.
  useEffect(() => {
    if (loadedToastShown.current) return;
    loadedToastShown.current = true;
    shopify?.toast?.show(`Loaded ${total} ${total === 1 ? "order" : "orders"}`);
  }, [total, shopify]);

  const tableLoading = navigation.state === "loading";
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Mutate URL search params — this re-runs the loader and re-renders.
  const updateParams = (next) => {
    const merged = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === "" || v === undefined) merged.delete(k);
      else merged.set(k, String(v));
    }
    // Whenever filters change, reset to page 1 (unless explicitly setting page).
    if (!("page" in next)) merged.delete("page");
    setSearchParams(merged);
  };

  const onStatusChip = (id) => updateParams({ status: id === "all" ? null : id });
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
    <s-page inlineSize="large" heading="Orders">
      <s-section padding="none">
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            <form onSubmit={onSearchSubmit}>
              <s-stack direction="inline" gap="small-200" alignItems="end">
                <s-search-field
                  label="Search"
                  labelAccessibilityVisibility="exclusive"
                  placeholder="Search by order #, name, customer email"
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
              {STATUS_FILTERS.map((f) => {
                const active = status === f.id;
                const n = countByStatus[f.id] ?? 0;
                return (
                  <s-clickable-chip
                    key={f.id}
                    color={active ? "strong" : "base"}
                    accessibilityLabel={`Filter by ${f.label}`}
                    onClick={() => onStatusChip(f.id)}
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
            <s-stack direction="block" gap="base" alignItems="center" justifyContent="center">
              <s-text>{q ? "🔍" : "📭"}</s-text>
              <s-heading>
                {q ? "No matches" : status === "all" ? "No orders yet" : "No orders in this status"}
              </s-heading>
              <s-paragraph tone="subdued">
                {q
                  ? `No orders match "${q}". Try a different keyword or clear the search.`
                  : status === "all"
                    ? "Orders received via the Shopify webhook will appear here."
                    : "Try changing the status filter."}
              </s-paragraph>
              {q && <s-button onClick={onSearchClear}>Clear search</s-button>}
            </s-stack>
          </s-box>
        ) : (
          <s-table loading={tableLoading}>
            <s-table-header-row>
              <s-table-header>Order</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Amount</s-table-header>
              <s-table-header>Processing</s-table-header>
              <s-table-header>Payment</s-table-header>
              <s-table-header>Received</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((r) => {
                const go = () => navigate(`/app/orders/${r.id}`);
                const orderLabel =
                  r.shopifyOrderName ||
                  (r.shopifyOrderNumber ? `#${r.shopifyOrderNumber}` : r.shopifyOrderId);
                return (
                  <s-table-row key={r.id} onClick={go}>
                    <s-table-cell>
                      <s-text>{orderLabel}</s-text>
                    </s-table-cell>
                    <s-table-cell>{r.customerEmail || "—"}</s-table-cell>
                    <s-table-cell>
                      {r.totalAmount != null
                        ? formatAmount(r.totalAmount, r.currency)
                        : "—"}
                    </s-table-cell>
                    <s-table-cell>
                      <ProcessingBadge status={r.processingStatus} />
                    </s-table-cell>
                    <s-table-cell>
                      <PaymentBadge
                        paymentStatus={r.paymentStatus}
                        invoice={r.invoice}
                      />
                    </s-table-cell>
                    <s-table-cell>
                      {r.receivedAt
                        ? new Date(r.receivedAt).toLocaleString()
                        : "—"}
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
              <s-stack direction="inline" gap="small-200" alignItems="center">
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

function ProcessingBadge({ status }) {
  const map = {
    received: { tone: "default", label: "Received" },
    processing: { tone: "info", label: "Processing" },
    pending_approval: { tone: "warning", label: "Pending approval" },
    rejected: { tone: "critical", label: "Rejected" },
    customer_ready: { tone: "info", label: "Customer ready" },
    invoiced: { tone: "info", label: "Invoiced" },
    scheduled: { tone: "info", label: "Scheduled" },
    completed: { tone: "success", label: "Completed" },
    failed: { tone: "critical", label: "Failed" },
  };
  const m = map[status] || { tone: "default", label: status || "—" };
  return <s-badge tone={m.tone}>{m.label}</s-badge>;
}

function PaymentBadge({ paymentStatus, invoice }) {
  if (!invoice) {
    return paymentStatus === "paid" ? (
      <s-badge tone="success">Paid</s-badge>
    ) : (
      <s-text tone="subdued">—</s-text>
    );
  }
  const ps = invoice.paymentStatus;
  if (ps === "paid") return <s-badge tone="success">Paid</s-badge>;
  if (ps === "cancelled") return <s-badge>Cancelled</s-badge>;
  if (ps === "in_progress") return <s-badge tone="info">In progress</s-badge>;
  if (ps === "failed") {
    return (
      <s-stack direction="block" gap="none">
        <s-badge tone="critical">Failed</s-badge>
        <s-text tone="subdued">{invoice.attemptCount}/{invoice.maxAttempts} attempts</s-text>
      </s-stack>
    );
  }
  // pending
  return (
    <s-stack direction="block" gap="none">
      <s-badge tone="warning">Pending</s-badge>
      <s-text tone="subdued">{invoice.attemptCount}/{invoice.maxAttempts} attempts</s-text>
    </s-stack>
  );
}

function formatAmount(amount, currency) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
    }).format(amount);
  } catch {
    return `${currency || ""} ${Number(amount).toFixed(2)}`;
  }
}
