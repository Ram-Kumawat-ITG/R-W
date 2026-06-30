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
import { AdvancedFilters } from "../components/admin-ui";

const PAGE_SIZE = 50;

const PERIOD_OPTIONS = [
  { id: "7", label: "Last 7 days", days: 7 },
  { id: "30", label: "Last 30 days", days: 30 },
  { id: "90", label: "Last 90 days", days: 90 },
];

// Outcome chips. NMI's `result` filter only matches the latest action,
// so we pull the full window and filter client-side — that catches
// transactions where an earlier action failed even if a later retry
// succeeded (still useful for the operator looking at failure patterns).
const OUTCOME_FILTERS = [
  { id: "latest", label: "Latest action failed" },
  { id: "any", label: "Any action failed" },
];

const METHOD_FILTERS = [
  { id: "all", label: "All", transactionType: null },
  { id: "cc", label: "Credit card", transactionType: "cc" },
  { id: "ck", label: "ACH", transactionType: "ck" },
];

// Config for the shared <AdvancedFilters> card.
const FILTER_FIELDS = [
  { key: "q", label: "Search", type: "text", placeholder: "Name / email / txn / response" },
  {
    key: "outcome",
    label: "Failure scope",
    type: "select",
    options: OUTCOME_FILTERS.map((o) => ({ value: o.id, label: o.label })),
  },
  {
    key: "method",
    label: "Payment method",
    type: "select",
    options: METHOD_FILTERS.map((m) => ({ value: m.id, label: m.label })),
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
const FILTER_DEFAULTS = { outcome: "latest", method: "all", period: "30" };

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
  const outcome = url.searchParams.get("outcome") || "latest";
  const method = url.searchParams.get("method") || "all";
  const dateFrom = (url.searchParams.get("dateFrom") || "").trim();
  const dateTo = (url.searchParams.get("dateTo") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));

  const { start, end } = resolveWindow({ dateFrom, dateTo, period });

  const transactionType =
    METHOD_FILTERS.find((m) => m.id === method)?.transactionType || null;

  try {
    const { records } = await listNmiTransactions({
      startDate: start,
      endDate: end,
      transactionType,
    });

    // Failure filter — latest only, or any action in the lifecycle.
    let filtered = records.filter((tx) => {
      if (outcome === "any") {
        return (tx.actions || []).some((a) => a.success !== "1");
      }
      const last = latestAction(tx);
      return last && last.success !== "1";
    });

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
          last.response_text,
          last.processor_response_text,
        ];
        return fields.some((v) => (v || "").toLowerCase().includes(needle));
      });
    }

    const total = filtered.length;
    const startIdx = (page - 1) * PAGE_SIZE;
    const pageRows = filtered.slice(startIdx, startIdx + PAGE_SIZE).map(projectFailure);

    return {
      rows: pageRows,
      total,
      page,
      pageSize: PAGE_SIZE,
      q,
      period,
      outcome,
      method,
      dateFrom,
      dateTo,
      error: null,
    };
  } catch (e) {
    console.error("[nmi/failed] loader failed:", e?.message || e);
    return {
      rows: [],
      total: 0,
      page,
      pageSize: PAGE_SIZE,
      q,
      period,
      outcome,
      method,
      dateFrom,
      dateTo,
      error: e?.message || "Failed to load NMI failed payments",
    };
  }
};

function projectFailure(tx) {
  const actions = tx.actions || [];
  const last = latestAction(tx) || {};
  const date = fromNmiDate(last.date);
  // Retry counter — multiple actions of the same type indicate the
  // merchant kept trying. Useful for spotting customers whose card is
  // chronically declining.
  const sameTypeCount = actions.filter(
    (a) => (a.action_type || "") === (last.action_type || ""),
  ).length;
  const failedActionCount = actions.filter((a) => a.success !== "1").length;
  return {
    id: tx.transaction_id,
    customerName:
      [tx.first_name, tx.last_name].filter(Boolean).join(" ") || null,
    email: tx.email || null,
    phone: tx.phone || null,
    transactionType: tx.transaction_type === "ck" ? "ACH" : "Card",
    actionType: last.action_type || "—",
    amount: Number(last.amount || 0),
    currency: tx.currency || "USD",
    // Most actionable label — `response_text` is NMI's plain-English
    // reason; `processor_response_text` is the bank's. Show both so
    // admins can distinguish gateway-side rejections from issuer
    // declines.
    failureReason: last.response_text || "Unknown",
    processorReason: last.processor_response_text || null,
    responseCode: last.response_code || null,
    retryAttempts: sameTypeCount,
    failedActionCount,
    actionCount: actions.length,
    condition: tx.condition || null,
    when: date ? date.toISOString() : null,
    cardLast4:
      tx.cc_number && tx.cc_number.length >= 4
        ? tx.cc_number.slice(-4)
        : null,
  };
}

export default function NmiFailed() {
  const {
    rows,
    total,
    page,
    pageSize,
    q,
    period,
    outcome,
    method,
    dateFrom,
    dateTo,
    error,
  } = useLoaderData();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();

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

  return (
    <>
      <AdvancedFilters
        fields={FILTER_FIELDS}
        values={{ q, outcome, method, period, dateFrom, dateTo }}
        defaults={FILTER_DEFAULTS}
        onRefresh={() => revalidator.revalidate()}
        refreshing={refreshing}
        applying={tableLoading}
      />
      <s-section heading={`Failed payments (${total})`}>
        <s-stack direction="block" gap="base">
        {error && (
          <s-banner tone="critical" heading="Could not load failed payments">
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
              <s-text>{q ? "🔍" : "🎉"}</s-text>
              <s-heading>
                {q ? "No matches" : "No failed payments"}
              </s-heading>
              <s-paragraph tone="subdued">
                {q
                  ? `No failed NMI payments match "${q}".`
                  : "No failed transactions in this filter window."}
              </s-paragraph>
            </s-stack>
          </s-box>
        ) : (
          <s-table loading={tableLoading}>
            <s-table-header-row>
              <s-table-header>Transaction</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Method</s-table-header>
              <s-table-header>Amount</s-table-header>
              <s-table-header>Failure reason</s-table-header>
              <s-table-header>Retry attempts</s-table-header>
              <s-table-header>Retry status</s-table-header>
              <s-table-header>When</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((f) => (
                <s-table-row key={f.id}>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <s-text>#{f.id}</s-text>
                      <s-text tone="subdued">{f.actionType}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <s-text>{f.customerName || "—"}</s-text>
                      {f.email && (
                        <s-text tone="subdued">{f.email}</s-text>
                      )}
                      {f.phone && !f.email && (
                        <s-text tone="subdued">{f.phone}</s-text>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <s-badge
                        tone={f.transactionType === "ACH" ? "warning" : "info"}
                      >
                        {f.transactionType}
                      </s-badge>
                      {f.cardLast4 && (
                        <s-text tone="subdued">•••• {f.cardLast4}</s-text>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    {formatAmount(f.amount, f.currency)}
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <s-text tone="critical">{f.failureReason}</s-text>
                      {f.processorReason &&
                        f.processorReason !== f.failureReason && (
                          <s-text tone="subdued">
                            Processor: {f.processorReason}
                          </s-text>
                        )}
                      {f.responseCode && (
                        <s-text tone="subdued">Code {f.responseCode}</s-text>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    {f.retryAttempts > 1 ? (
                      <s-stack direction="block" gap="none">
                        <s-badge tone="warning">
                          {f.retryAttempts} attempt{f.retryAttempts === 1 ? "" : "s"}
                        </s-badge>
                        <s-text tone="subdued">
                          {f.failedActionCount} failed of {f.actionCount}
                        </s-text>
                      </s-stack>
                    ) : (
                      <s-text tone="subdued">1 attempt</s-text>
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge
                      tone={
                        f.condition === "complete"
                          ? "success"
                          : f.condition === "failed"
                            ? "critical"
                            : "default"
                      }
                    >
                      {f.condition === "complete"
                        ? "Later succeeded"
                        : f.condition === "failed"
                          ? "Failed"
                          : f.condition || "—"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {f.when ? new Date(f.when).toLocaleString() : "—"}
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
