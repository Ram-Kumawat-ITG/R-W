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
import { ProcessingBadge, PaymentMethodShortText } from "../components/admin-ui";
import {
  formatAmount,
  parseDateOnly,
  startOfDay,
} from "../utils/format.utils";
import { PAYMENT_METHOD_SHORT } from "../utils/payment.constants";

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

  // Pull the linked invoices in one query — every payment-related field
  // we render lives on Invoice now, so a single fetch covers attemptCount,
  // QBO due date, the order-time preference snapshot, and the settled-via
  // record. No N+1 and no separate CustomerMap fetch (which would have
  // returned the *current* preference, not the order-time one).
  const invoiceIds = rows.map((r) => r.invoiceRef).filter(Boolean);
  const invoiceById = new Map();
  if (invoiceIds.length) {
    const invoices = await Invoice.find({ _id: { $in: invoiceIds } })
      .select(
        "paymentStatus paymentMethod customerPaymentPreference paymentSettledVia paymentSettledAt attemptCount maxAttempts lastAttemptError amountDue amountPaid qboDueDate qboTxnDate",
      )
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
              paymentMethod: inv.paymentMethod || null,
              paymentSettledVia: inv.paymentSettledVia || null,
              paymentSettledAt: inv.paymentSettledAt || null,
              attemptCount: inv.attemptCount,
              maxAttempts: inv.maxAttempts,
              lastAttemptError: inv.lastAttemptError || null,
              amountDue: inv.amountDue,
              amountPaid: inv.amountPaid,
              qboDueDate: inv.qboDueDate || null,
              qboTxnDate: inv.qboTxnDate || null,
            }
          : null,
        // Immutable preference snapshot from the time this order was
        // placed. Reads ONLY from Invoice.customerPaymentPreference —
        // never `paymentMethod` (which is mutable via cheque → card
        // override) and never CustomerMap (which is the *current*
        // preference, not the historical one). Legacy invoices missing
        // the snapshot are backfilled at boot via
        // backfillCustomerPaymentPreferences in invoice.migrations.js.
        customerPreference: inv?.customerPaymentPreference || null,
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
              <s-table-header>Preferred method</s-table-header>
              <s-table-header>Settled via</s-table-header>
              <s-table-header>Settled at</s-table-header>
              <s-table-header>Due</s-table-header>
              <s-table-header>Order date</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((r) => {
                const go = () => navigate(`/app/orders/${r.id}`);
                const orderLabel =
                  r.shopifyOrderName ||
                  (r.shopifyOrderNumber ? `#${r.shopifyOrderNumber}` : r.shopifyOrderId);
                const orderTooltip = `Order ${orderLabel}`;
                return (
                  <s-table-row key={r.id} onClick={go} title={orderTooltip}>
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
                      <PaymentMethodShortText method={r.customerPreference} />
                    </s-table-cell>
                    <s-table-cell>
                      <SettledViaCell
                        invoice={r.invoice}
                        preference={r.customerPreference}
                      />
                    </s-table-cell>
                    <s-table-cell>
                      <SettledAtCell invoice={r.invoice} />
                    </s-table-cell>
                    <s-table-cell>
                      <DueDateCell invoice={r.invoice} />
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

// Order-list-specific payment badge — multi-line layout (badge above,
// "attempts" subtitle below). Lives here rather than in admin-ui.jsx
// because the layout is list-specific; the simple PaymentStatusBadge
// shared primitive is used on detail pages.
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

// "Settled via" — the actual method that settled the invoice. Reads
// Invoice.paymentSettledVia (set explicitly on each successful payment
// event — NMI approval OR manual cheque). Blank when the invoice
// hasn't been settled yet; "Settled" only means something once payment
// has actually landed. Legacy paid invoices without paymentSettledVia
// fall back to paymentMethod (no override existed before this field,
// so they're equivalent).
function SettledViaCell({ invoice, preference }) {
  if (!invoice || invoice.paymentStatus !== "paid") {
    return <s-text tone="subdued">—</s-text>;
  }
  const method = invoice.paymentSettledVia || invoice.paymentMethod;
  if (!method) return <s-text tone="subdued">—</s-text>;
  const label = PAYMENT_METHOD_SHORT[method] || method;
  const overridden = preference && preference !== method;
  if (overridden) {
    return (
      <s-stack direction="block" gap="none">
        <s-text>{label}</s-text>
        <s-text tone="subdued">override</s-text>
      </s-stack>
    );
  }
  return <s-text>{label}</s-text>;
}

// Timestamp the invoice was settled (paymentSettledAt). Only renders
// for paid invoices — pending/failed/cancelled show "—" to match the
// Settled-via column.
function SettledAtCell({ invoice }) {
  if (
    !invoice ||
    invoice.paymentStatus !== "paid" ||
    !invoice.paymentSettledAt
  ) {
    return <s-text tone="subdued">—</s-text>;
  }
  return <s-text>{new Date(invoice.paymentSettledAt).toLocaleString()}</s-text>;
}

// Render the QBO due date for an invoice. Highlights overdue + unpaid in
// critical tone so admins can scan the list and spot collections work.
// `qboDueDate` is a "YYYY-MM-DD" string (QBO's date-only format) — see
// the qboDueDate field on the Invoice model.
function DueDateCell({ invoice }) {
  if (!invoice?.qboDueDate) return <s-text tone="subdued">—</s-text>;
  const due = parseDateOnly(invoice.qboDueDate);
  if (!due) return <s-text tone="subdued">{invoice.qboDueDate}</s-text>;
  const isPaid = invoice.paymentStatus === "paid";
  const isCancelled = invoice.paymentStatus === "cancelled";
  const today = startOfDay(new Date());
  const overdue = !isPaid && !isCancelled && due < today;
  const settled = isPaid || isCancelled;
  const label = due.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  // Strike through the due date once the invoice is settled (or cancelled)
  // — the date is no longer an active obligation. Uses the semantic
  // <s> element (rendered with browser-default line-through) so we don't
  // need inline styles, which are barred in admin routes.
  return (
    <s-stack direction="block" gap="none">
      <s-text
        tone={overdue ? "critical" : settled ? "subdued" : undefined}
      >
        {settled ? (
          <s>{label}</s>
        ) : overdue ? (
          <strong>{label}</strong>
        ) : (
          label
        )}
      </s-text>
      {overdue && <s-text tone="critical">Overdue</s-text>}
    </s-stack>
  );
}

