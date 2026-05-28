import { useState } from "react";
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
import { formatAmount } from "../utils/format.utils";

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

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const period = url.searchParams.get("period") || "30";
  const statusFilter = url.searchParams.get("status") || "all";
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));

  const periodDays =
    PERIOD_OPTIONS.find((p) => p.id === period)?.days || 30;
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - periodDays);

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

    return {
      rows: pageRows,
      total,
      page,
      pageSize: PAGE_SIZE,
      q,
      period,
      statusFilter,
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
  const { rows, total, page, pageSize, q, period, statusFilter, error } =
    useLoaderData();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchInput, setSearchInput] = useState(q);

  const tableLoading = navigation.state === "loading";
  const refreshing = revalidator.state !== "idle";
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const firstShown = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastShown = Math.min(page * pageSize, total);

  // Window-level refund summary card.
  const successfulRefunds = rows.filter((r) => r.success);
  const totalRefunded = successfulRefunds.reduce(
    (s, r) => s + r.refundAmount,
    0,
  );
  const currency = rows[0]?.currency || "USD";

  const updateParams = (next) => {
    const merged = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === "" || v === undefined) merged.delete(k);
      else merged.set(k, String(v));
    }
    if (!("page" in next)) merged.delete("page");
    setSearchParams(merged);
  };

  const onSearchSubmit = (e) => {
    e?.preventDefault?.();
    updateParams({ q: searchInput.trim() || null });
  };
  const onSearchClear = () => {
    setSearchInput("");
    updateParams({ q: null });
  };

  return (
    <s-section heading={`Refunds (${total})`}>
      <s-stack direction="block" gap="base">
        <form onSubmit={onSearchSubmit}>
          <s-stack direction="inline" gap="small-200" alignItems="end">
            <s-search-field
              label="Search"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search by txn id, customer, email, or response text"
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
            <s-button
              variant="secondary"
              onClick={() => revalidator.revalidate()}
              {...(refreshing ? { loading: true } : {})}
            >
              Refresh
            </s-button>
          </s-stack>
        </form>

        <s-stack direction="inline" gap="small-200" wrap>
          {PERIOD_OPTIONS.map((p) => (
            <s-clickable-chip
              key={p.id}
              color={period === p.id ? "strong" : "base"}
              accessibilityLabel={`Period: ${p.label}`}
              onClick={() =>
                updateParams({ period: p.id === "30" ? null : p.id })
              }
            >
              {p.label}
            </s-clickable-chip>
          ))}
          <s-text tone="subdued">·</s-text>
          {STATUS_FILTERS.map((s) => (
            <s-clickable-chip
              key={s.id}
              color={statusFilter === s.id ? "strong" : "base"}
              accessibilityLabel={`Refund status: ${s.label}`}
              onClick={() =>
                updateParams({ status: s.id === "all" ? null : s.id })
              }
            >
              {s.label}
            </s-clickable-chip>
          ))}
        </s-stack>

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
                {formatAmount(totalRefunded, currency)} ·{" "}
                {successfulRefunds.length} approved
              </s-heading>
            </s-stack>
            <s-text tone="subdued">
              {total - successfulRefunds.length} declined / errored
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
                    <s-stack direction="block" gap="none">
                      <s-text>{r.customerName || "—"}</s-text>
                      {r.email && (
                        <s-text tone="subdued">{r.email}</s-text>
                      )}
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
  );
}
