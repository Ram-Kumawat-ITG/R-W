import { useState } from "react";
import {
  useLoaderData,
  useNavigation,
  useSearchParams,
  useRevalidator,
} from "react-router";
import { authenticate } from "../shopify.server";
import { listNmiTransactions } from "../services/nmi/nmi.service";
// Pure helpers come from nmi.utils.js — see that file for why.
import { latestAction, fromNmiDate } from "../services/nmi/nmi.utils";
import { formatAmount } from "../utils/format.utils";

const PAGE_SIZE = 50;

const PERIOD_OPTIONS = [
  { id: "7", label: "Last 7 days", days: 7 },
  { id: "30", label: "Last 30 days", days: 30 },
  { id: "90", label: "Last 90 days", days: 90 },
];

// Condition chips map to NMI's `condition` query param. Every NMI
// transaction lands in one of these buckets — `pending` is mid-
// authorization, `pendingsettlement` is approved but not yet batched
// to the processor, `complete` is settled, `failed` is the catch-all
// for declines/errors, `canceled` is admin-voided.
const CONDITION_FILTERS = [
  { id: "all", label: "All", value: null },
  { id: "complete", label: "Settled", value: "complete" },
  { id: "pendingsettlement", label: "Awaiting settlement", value: "pendingsettlement" },
  { id: "failed", label: "Failed", value: "failed" },
  { id: "canceled", label: "Canceled", value: "canceled" },
];

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const period = url.searchParams.get("period") || "30";
  const condition = url.searchParams.get("condition") || "all";
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));

  const periodDays =
    PERIOD_OPTIONS.find((p) => p.id === period)?.days || 30;
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - periodDays);

  const conditionValue =
    CONDITION_FILTERS.find((c) => c.id === condition)?.value || null;

  try {
    const { records } = await listNmiTransactions({
      startDate: start,
      endDate: end,
      condition: conditionValue,
    });

    let filtered = records;
    if (q) {
      const needle = q.toLowerCase();
      filtered = filtered.filter((tx) => {
        const last = latestAction(tx) || {};
        const fields = [
          tx.transaction_id,
          tx.order_id,
          tx.email,
          tx.first_name,
          tx.last_name,
          `${tx.first_name || ""} ${tx.last_name || ""}`.trim(),
          tx.customerid,
          tx.authorization_code,
          last.batch_id,
          last.processor_batch_id,
          last.processor_response_text,
        ];
        return fields.some((v) => (v || "").toString().toLowerCase().includes(needle));
      });
    }

    const total = filtered.length;
    const startIdx = (page - 1) * PAGE_SIZE;
    const pageRows = filtered.slice(startIdx, startIdx + PAGE_SIZE).map(projectTransaction);

    return {
      rows: pageRows,
      total,
      page,
      pageSize: PAGE_SIZE,
      q,
      period,
      condition,
      error: null,
    };
  } catch (e) {
    console.error("[nmi/transactions] loader failed:", e?.message || e);
    return {
      rows: [],
      total: 0,
      page,
      pageSize: PAGE_SIZE,
      q,
      period,
      condition,
      error: e?.message || "Failed to load NMI transactions",
    };
  }
};

// Per-transaction projection — surfaces the lifecycle (action count +
// latest action) so admins can spot multi-step transactions (e.g. an
// auth followed by a capture) without expanding the row.
function projectTransaction(tx) {
  const last = latestAction(tx) || {};
  const actions = tx.actions || [];
  const date = fromNmiDate(last.date);
  const success = last.success === "1";
  // "Retry" tracking — NMI's `action_type` lifecycle doesn't have an
  // explicit retry flag, but more than one action of the same type
  // (e.g. two sales) usually means the merchant retried after a
  // decline. Surface the count so admins can see retry behavior at a
  // glance.
  const sameTypeCount = actions.filter(
    (a) => (a.action_type || "") === (last.action_type || ""),
  ).length;

  return {
    id: tx.transaction_id,
    transactionType: tx.transaction_type === "ck" ? "ACH" : "Card",
    condition: tx.condition || null,
    customerName:
      [tx.first_name, tx.last_name].filter(Boolean).join(" ") || null,
    email: tx.email || null,
    actionType: last.action_type || "—",
    amount: Number(last.amount || 0),
    currency: tx.currency || "USD",
    success,
    processorResponseText: last.processor_response_text || null,
    processorResponseCode: last.processor_response_code || null,
    responseText: last.response_text || null,
    batchId: last.batch_id || null,
    processorBatchId: last.processor_batch_id || null,
    authCode: tx.authorization_code || null,
    actionCount: actions.length,
    retryCount: sameTypeCount,
    orderId: tx.order_id || null,
    when: date ? date.toISOString() : null,
  };
}

const CONDITION_TONE = {
  complete: "success",
  pendingsettlement: "info",
  pending: "info",
  in_progress: "info",
  failed: "critical",
  canceled: "default",
  abandoned: "default",
  unknown: "default",
};

export default function NmiTransactions() {
  const { rows, total, page, pageSize, q, period, condition, error } =
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
    <s-section heading={`All transactions (${total})`}>
      <s-stack direction="block" gap="base">
        <form onSubmit={onSearchSubmit}>
          <s-stack direction="inline" gap="small-200" alignItems="end">
            <s-search-field
              label="Search"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search by txn id, order id, batch id, customer, or response text"
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
          {CONDITION_FILTERS.map((c) => (
            <s-clickable-chip
              key={c.id}
              color={condition === c.id ? "strong" : "base"}
              accessibilityLabel={`Condition: ${c.label}`}
              onClick={() =>
                updateParams({ condition: c.id === "all" ? null : c.id })
              }
            >
              {c.label}
            </s-clickable-chip>
          ))}
        </s-stack>

        {error && (
          <s-banner tone="critical" heading="Could not load transactions">
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
              <s-heading>{q ? "No matches" : "No transactions"}</s-heading>
              <s-paragraph tone="subdued">
                {q
                  ? `No NMI transactions match "${q}".`
                  : "NMI returned no transactions for this filter window."}
              </s-paragraph>
            </s-stack>
          </s-box>
        ) : (
          <s-table loading={tableLoading}>
            <s-table-header-row>
              <s-table-header>Transaction</s-table-header>
              <s-table-header>Type</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Amount</s-table-header>
              <s-table-header>Outcome</s-table-header>
              <s-table-header>Processor response</s-table-header>
              <s-table-header>Batch</s-table-header>
              <s-table-header>Settlement</s-table-header>
              <s-table-header>Retries</s-table-header>
              <s-table-header>References</s-table-header>
              <s-table-header>When</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((tx) => (
                <s-table-row key={tx.id}>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <s-text>#{tx.id}</s-text>
                      <s-badge tone={tx.transactionType === "ACH" ? "warning" : "info"}>
                        {tx.transactionType}
                      </s-badge>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{tx.actionType}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <s-text>{tx.customerName || "—"}</s-text>
                      {tx.email && (
                        <s-text tone="subdued">{tx.email}</s-text>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    {formatAmount(tx.amount, tx.currency)}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={tx.success ? "success" : "critical"}>
                      {tx.success ? "Success" : "Failure"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <s-text>{tx.processorResponseText || "—"}</s-text>
                      {tx.processorResponseCode && (
                        <s-text tone="subdued">
                          Code {tx.processorResponseCode}
                        </s-text>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    {tx.batchId ? (
                      <s-stack direction="block" gap="none">
                        <s-text>Batch {tx.batchId}</s-text>
                        {tx.processorBatchId && tx.processorBatchId !== tx.batchId && (
                          <s-text tone="subdued">
                            Processor {tx.processorBatchId}
                          </s-text>
                        )}
                      </s-stack>
                    ) : (
                      "—"
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={CONDITION_TONE[tx.condition] || "default"}>
                      {tx.condition || "—"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {tx.retryCount > 1 ? (
                      <s-badge tone="warning">{tx.retryCount}x</s-badge>
                    ) : (
                      <s-text tone="subdued">—</s-text>
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      {tx.orderId && (
                        <s-text tone="subdued">Order {tx.orderId}</s-text>
                      )}
                      {tx.authCode && (
                        <s-text tone="subdued">Auth {tx.authCode}</s-text>
                      )}
                      {!tx.orderId && !tx.authCode && (
                        <s-text tone="subdued">—</s-text>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    {tx.when
                      ? new Date(tx.when).toLocaleString()
                      : "—"}
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
