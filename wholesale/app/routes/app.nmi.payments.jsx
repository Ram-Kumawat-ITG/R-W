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

// Period chips. Same idiom as the Dashboard tab — bounded windows so a
// single page render doesn't pull years of NMI history.
const PERIOD_OPTIONS = [
  { id: "7", label: "Last 7 days", days: 7 },
  { id: "30", label: "Last 30 days", days: 30 },
  { id: "90", label: "Last 90 days", days: 90 },
];

const METHOD_FILTERS = [
  { id: "all", label: "All", transactionType: null },
  { id: "cc", label: "Credit card", transactionType: "cc" },
  { id: "ck", label: "ACH", transactionType: "ck" },
];

// What counts as a "payment" on the Payments tab: sale + capture +
// credit (NMI's "credit" is a customer-initiated credit, similar to a
// payment from the merchant's perspective). Refunds, voids, and auths
// without capture are excluded — those have their own tabs.
const PAYMENT_ACTIONS = new Set(["sale", "capture", "credit"]);

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const period = url.searchParams.get("period") || "30";
  const method = url.searchParams.get("method") || "all";
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));

  const periodDays =
    PERIOD_OPTIONS.find((p) => p.id === period)?.days || 30;
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - periodDays);

  const transactionType =
    METHOD_FILTERS.find((m) => m.id === method)?.transactionType || null;

  try {
    const { records } = await listNmiTransactions({
      startDate: start,
      endDate: end,
      transactionType,
    });

    // Keep only transactions whose latest action is a payment-side
    // action. Refunds + voids get their own tabs; auths without a
    // matching capture are noise here.
    let filtered = records.filter((tx) => {
      const last = latestAction(tx);
      return last && PAYMENT_ACTIONS.has((last.action_type || "").toLowerCase());
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
          tx.customerid,
          last.response_text,
        ];
        return fields.some((v) => (v || "").toLowerCase().includes(needle));
      });
    }

    const total = filtered.length;
    const startIdx = (page - 1) * PAGE_SIZE;
    const pageRows = filtered.slice(startIdx, startIdx + PAGE_SIZE).map(projectPayment);

    return {
      rows: pageRows,
      total,
      page,
      pageSize: PAGE_SIZE,
      q,
      period,
      method,
      error: null,
    };
  } catch (e) {
    console.error("[nmi/payments] loader failed:", e?.message || e);
    return {
      rows: [],
      total: 0,
      page,
      pageSize: PAGE_SIZE,
      q,
      period,
      method,
      error: e?.message || "Failed to load NMI payments",
    };
  }
};

function projectPayment(tx) {
  const last = latestAction(tx) || {};
  const date = fromNmiDate(last.date);
  return {
    id: tx.transaction_id,
    customerName:
      [tx.first_name, tx.last_name].filter(Boolean).join(" ") || null,
    email: tx.email || null,
    transactionType: tx.transaction_type === "ck" ? "ACH" : "Card",
    actionType: last.action_type || "—",
    amount: Number(last.amount || 0),
    currency: tx.currency || "USD",
    success: last.success === "1",
    responseText: last.response_text || null,
    responseCode: last.response_code || null,
    invoiceReference:
      tx.order_id || tx.order_description || tx.merchant_defined_field_1 || null,
    paymentDate: date ? date.toISOString() : null,
    customerVaultId: tx.customer_vault_id || null,
    cardLast4:
      tx.cc_number && tx.cc_number.length >= 4
        ? tx.cc_number.slice(-4)
        : null,
  };
}

export default function NmiPayments() {
  const { rows, total, page, pageSize, q, period, method, error } =
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
    <s-section heading={`Payments (${total})`}>
      <s-stack direction="block" gap="base">
        <form onSubmit={onSearchSubmit}>
          <s-stack direction="inline" gap="small-200" alignItems="end">
            <s-search-field
              label="Search"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search by name, email, txn id, order id, or response text"
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
          {METHOD_FILTERS.map((m) => (
            <s-clickable-chip
              key={m.id}
              color={method === m.id ? "strong" : "base"}
              accessibilityLabel={`Method: ${m.label}`}
              onClick={() =>
                updateParams({ method: m.id === "all" ? null : m.id })
              }
            >
              {m.label}
            </s-clickable-chip>
          ))}
        </s-stack>

        {error && (
          <s-banner tone="critical" heading="Could not load payments">
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
              <s-heading>{q ? "No matches" : "No payments"}</s-heading>
              <s-paragraph tone="subdued">
                {q
                  ? `No NMI payments match "${q}".`
                  : "NMI returned no payments for this filter window."}
              </s-paragraph>
            </s-stack>
          </s-box>
        ) : (
          <s-table loading={tableLoading}>
            <s-table-header-row>
              <s-table-header>Transaction ID</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Payment method</s-table-header>
              <s-table-header>Amount</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Invoice / order</s-table-header>
              <s-table-header>Payment date</s-table-header>
              <s-table-header>Response</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((p) => (
                <s-table-row key={p.id}>
                  <s-table-cell>#{p.id}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <s-text>{p.customerName || "—"}</s-text>
                      {p.email && <s-text tone="subdued">{p.email}</s-text>}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <s-badge tone={p.transactionType === "ACH" ? "warning" : "info"}>
                        {p.transactionType}
                      </s-badge>
                      {p.cardLast4 && (
                        <s-text tone="subdued">•••• {p.cardLast4}</s-text>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    {formatAmount(p.amount, p.currency)}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={p.success ? "success" : "critical"}>
                      {p.success ? "Approved" : "Failed"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{p.invoiceReference || "—"}</s-table-cell>
                  <s-table-cell>
                    {p.paymentDate
                      ? new Date(p.paymentDate).toLocaleString()
                      : "—"}
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <s-text>{p.responseText || "—"}</s-text>
                      {p.responseCode && (
                        <s-text tone="subdued">
                          Code {p.responseCode}
                        </s-text>
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
