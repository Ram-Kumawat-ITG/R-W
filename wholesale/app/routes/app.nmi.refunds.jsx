import {
  useLoaderData,
  useNavigation,
  useSearchParams,
  useRevalidator,
} from "react-router";
import { authenticate } from "../shopify.server";
import { listNmiTransactions } from "../services/nmi/nmi.service";
// fromNmiDate lives in nmi.utils.js — see that file for why.
import { fromNmiDate } from "../services/nmi/nmi.utils";
import { formatAmount, initialsOf } from "../utils/format.utils";
import { AdvancedFilters } from "../components/admin-ui";

const PAGE_SIZE = 50;

const PERIOD_OPTIONS = [
  { id: "7", label: "Last 7 days", days: 7 },
  { id: "30", label: "Last 30 days", days: 30 },
  { id: "90", label: "Last 90 days", days: 90 },
];

const STATUS_FILTERS = [
  { id: "all", label: "All" },
  { id: "success", label: "Approved" },
  { id: "failed", label: "Declined" },
];

// Config for the shared <AdvancedFilters> card. The status field's URL key is
// `status` (the loader reads it into `statusFilter`).
const FILTER_FIELDS = [
  { key: "q", label: "Search", type: "text", placeholder: "Txn / customer / email / response" },
  {
    key: "status",
    label: "Refund status",
    type: "select",
    options: STATUS_FILTERS.map((s) => ({ value: s.id, label: s.label })),
  },
  {
    key: "period",
    label: "Period",
    type: "select",
    options: PERIOD_OPTIONS.map((p) => ({ value: p.id, label: p.label })),
  },
  { key: "dateFrom", label: "From date", type: "date" },
  { key: "dateTo", label: "To date", type: "date" },
];
const FILTER_DEFAULTS = { status: "all", period: "30" };

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
// Resolve the NMI fetch window. Explicit From/To dates win; else fall back to
// the relative period (default 30 days). NMI has no pagination, so a bounded
// window is mandatory.
function resolveWindow({ dateFrom, dateTo, period }) {
  if (YMD_RE.test(dateFrom) || YMD_RE.test(dateTo)) {
    return {
      start: YMD_RE.test(dateFrom) ? new Date(`${dateFrom}T00:00:00`) : new Date(0),
      end: YMD_RE.test(dateTo) ? new Date(`${dateTo}T23:59:59`) : new Date(),
    };
  }
  const days = PERIOD_OPTIONS.find((p) => p.id === period)?.days || 30;
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  return { start, end };
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const period = url.searchParams.get("period") || "30";
  const statusFilter = url.searchParams.get("status") || "all";
  const dateFrom = (url.searchParams.get("dateFrom") || "").trim();
  const dateTo = (url.searchParams.get("dateTo") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));

  const { start, end } = resolveWindow({ dateFrom, dateTo, period });

  try {
    // NMI lets us narrow to refunds server-side via action_type=refund.
    // Returns every transaction that has at least one refund action in
    // its lifecycle — we then expand into one row per refund action
    // since multi-refund transactions (partial refunds) are real.
    const { records } = await listNmiTransactions({
      startDate: start,
      endDate: end,
      actionType: "refund",
    });

    // Expand each transaction into N rows — one per refund action it
    // carries. Skips non-refund actions on the same transaction (the
    // original sale action lives there too).
    let refundRows = [];
    for (const tx of records) {
      const actions = tx.actions || [];
      const refundActions = actions.filter(
        (a) => (a.action_type || "").toLowerCase() === "refund",
      );
      // Find the original sale action so the refund row can link back
      // to it. NMI keeps the original sale in the same <transaction>
      // record — refunds don't get a new transaction_id.
      const saleAction = actions.find(
        (a) => (a.action_type || "").toLowerCase() === "sale" ||
               (a.action_type || "").toLowerCase() === "capture",
      );
      for (const action of refundActions) {
        refundRows.push(projectRefund({ tx, action, saleAction }));
      }
    }

    // Outcome filter — refund actions can themselves be approved /
    // declined / errored (e.g. a refund attempted against an already-
    // refunded transaction will fail).
    if (statusFilter === "success") {
      refundRows = refundRows.filter((r) => r.success);
    } else if (statusFilter === "failed") {
      refundRows = refundRows.filter((r) => !r.success);
    }

    if (q) {
      const needle = q.toLowerCase();
      refundRows = refundRows.filter((r) => {
        const fields = [
          r.refundId,
          r.originalTransactionId,
          r.customerName,
          r.email,
          r.responseText,
        ];
        return fields.some((v) => (v || "").toLowerCase().includes(needle));
      });
    }

    // Newest first (refund action date).
    refundRows.sort((a, b) =>
      String(b.refundDateRaw || "").localeCompare(String(a.refundDateRaw || "")),
    );

    const total = refundRows.length;
    const startIdx = (page - 1) * PAGE_SIZE;
    const pageRows = refundRows.slice(startIdx, startIdx + PAGE_SIZE);

    // Compute window-level stats from the FULL filtered set, not just the
    // current page — otherwise the summary tile shows wrong totals on page 2+.
    const windowApproved = refundRows.filter((r) => r.success);
    const windowDeclined = total - windowApproved.length;
    const windowTotalAmount = windowApproved.reduce(
      (s, r) => s + r.refundAmount,
      0,
    );
    const windowCurrency = refundRows[0]?.currency || "USD";

    return {
      rows: pageRows,
      total,
      page,
      pageSize: PAGE_SIZE,
      q,
      period,
      statusFilter,
      dateFrom,
      dateTo,
      windowApprovedCount: windowApproved.length,
      windowDeclinedCount: windowDeclined,
      windowTotalAmount,
      windowCurrency,
      error: null,
    };
  } catch (e) {
    console.error("[nmi/refunds] loader failed:", e?.message || e);
    return {
      rows: [],
      total: 0,
      page,
      pageSize: PAGE_SIZE,
      q,
      period,
      statusFilter,
      dateFrom,
      dateTo,
      windowApprovedCount: 0,
      windowDeclinedCount: 0,
      windowTotalAmount: 0,
      windowCurrency: "USD",
      error: e?.message || "Failed to load NMI refunds",
    };
  }
};

function projectRefund({ tx, action, saleAction }) {
  const refundDate = fromNmiDate(action.date);
  const saleDate = fromNmiDate(saleAction?.date);
  const success = action.success === "1";
  return {
    // NMI doesn't issue a separate id per refund action — the original
    // transaction_id is shared by every action in the lifecycle. We
    // synthesize a unique key for React using the action date.
    key: `${tx.transaction_id}-${action.date || Math.random()}`,
    // The refund transaction id IS the original transaction id in
    // NMI's model; the response of a refund call returns the same id.
    // We surface that for clarity but also pair it with the sale's id
    // for cross-reference.
    refundId: tx.transaction_id,
    originalTransactionId: tx.transaction_id,
    customerName:
      [tx.first_name, tx.last_name].filter(Boolean).join(" ") || null,
    email: tx.email || null,
    transactionType: tx.transaction_type === "ck" ? "ACH" : "Card",
    cardLast4:
      tx.cc_number && tx.cc_number.length >= 4
        ? tx.cc_number.slice(-4)
        : null,
    refundAmount: Number(action.amount || 0),
    originalAmount: Number(saleAction?.amount || 0),
    currency: tx.currency || "USD",
    success,
    responseText: action.response_text || null,
    responseCode: action.response_code || null,
    processorResponseText: action.processor_response_text || null,
    refundDate: refundDate ? refundDate.toISOString() : null,
    refundDateRaw: action.date || null,
    originalSaleDate: saleDate ? saleDate.toISOString() : null,
    orderId: tx.order_id || null,
  };
}

export default function NmiRefunds() {
  const {
    rows,
    total,
    page,
    pageSize,
    q,
    period,
    statusFilter,
    dateFrom,
    dateTo,
    windowApprovedCount,
    windowDeclinedCount,
    windowTotalAmount,
    windowCurrency,
    error,
  } = useLoaderData();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();

  const refreshing = revalidator.state !== "idle";
  const tableLoading = navigation.state === "loading" || refreshing;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const firstShown = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastShown = Math.min(page * pageSize, total);

  const updateParams = (next) => {
    const merged = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === "" || v === undefined) merged.delete(k);
      else merged.set(k, String(v));
    }
    if (!("page" in next)) merged.delete("page");
    setSearchParams(merged);
  };

  return (
    <>
      <AdvancedFilters
        fields={FILTER_FIELDS}
        values={{ q, status: statusFilter, period, dateFrom, dateTo }}
        defaults={FILTER_DEFAULTS}
        onRefresh={() => revalidator.revalidate()}
        refreshing={refreshing}
        applying={tableLoading}
      />
      <s-section heading={`Refunds (${total})`}>
        <s-stack direction="block" gap="base">
        {/* Window-level summary tile — shows the total successful
            refund amount across the visible rows. Re-renders with the
            page since the loader's row count IS the filter count. */}
        <s-box
          padding="base"
          border="base"
          borderRadius="base"
          background="subdued"
        >
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-stack direction="block" gap="none">
              <s-text tone="subdued">Refunds in this window</s-text>
              <s-heading>
                {formatAmount(windowTotalAmount, windowCurrency)} ·{" "}
                {windowApprovedCount} approved
              </s-heading>
            </s-stack>
            <s-text tone="subdued">
              {windowDeclinedCount} declined / errored
            </s-text>
          </s-stack>
        </s-box>

        {error && (
          <s-banner tone="critical" heading="Could not load refunds">
            <s-paragraph>{error}</s-paragraph>
          </s-banner>
        )}

        {rows.length === 0 && !error ? (
          <s-box padding="large-500">
            <s-stack
              direction="block"
              gap="base"
              alignItems="center"
              justifyContent="center"
            >
              <s-text>{q ? "🔍" : "📭"}</s-text>
              <s-heading>{q ? "No matches" : "No refunds"}</s-heading>
              <s-paragraph tone="subdued">
                {q
                  ? `No NMI refunds match "${q}".`
                  : "No refund activity in this filter window."}
              </s-paragraph>
            </s-stack>
          </s-box>
        ) : (
          <s-table loading={tableLoading}>
            <s-table-header-row>
              <s-table-header>Refund txn</s-table-header>
              <s-table-header>Original txn</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Method</s-table-header>
              <s-table-header>Refund amount</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Refund date</s-table-header>
              <s-table-header>Notes</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((r) => (
                <s-table-row key={r.key}>
                  <s-table-cell>#{r.refundId}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <s-text>#{r.originalTransactionId}</s-text>
                      {r.originalAmount > 0 && (
                        <s-text tone="subdued">
                          Original: {formatAmount(r.originalAmount, r.currency)}
                        </s-text>
                      )}
                      {r.originalSaleDate && (
                        <s-text tone="subdued">
                          {new Date(r.originalSaleDate).toLocaleDateString()}
                        </s-text>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <s-avatar
                        size="small-200"
                        initials={initialsOf(r.customerName)}
                        alt={r.customerName || "Customer"}
                      />
                      <s-stack direction="block" gap="none">
                        <s-text>{r.customerName || "—"}</s-text>
                        {r.email && (
                          <s-text tone="subdued">{r.email}</s-text>
                        )}
                      </s-stack>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <s-badge
                        tone={r.transactionType === "ACH" ? "warning" : "info"}
                      >
                        {r.transactionType}
                      </s-badge>
                      {r.cardLast4 && (
                        <s-text tone="subdued">•••• {r.cardLast4}</s-text>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    {formatAmount(r.refundAmount, r.currency)}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={r.success ? "success" : "critical"}>
                      {r.success ? "Approved" : "Declined"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {r.refundDate
                      ? new Date(r.refundDate).toLocaleString()
                      : "—"}
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <s-text>{r.responseText || "—"}</s-text>
                      {r.processorResponseText &&
                        r.processorResponseText !== r.responseText && (
                          <s-text tone="subdued">
                            Processor: {r.processorResponseText}
                          </s-text>
                        )}
                      {r.orderId && (
                        <s-text tone="subdued">Order {r.orderId}</s-text>
                      )}
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}

        {total > 0 && (
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
        )}
      </s-stack>
      </s-section>
    </>
  );
}
