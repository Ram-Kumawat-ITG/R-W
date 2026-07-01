import { useRef, useState } from "react";
import {
  useLoaderData,
  useNavigation,
  useSearchParams,
  useRevalidator,
} from "react-router";
import { authenticate } from "../shopify.server";
import {
  listPayments,
  countPayments,
  listCustomers,
} from "../services/retailQbo/retailQbo.service";
import { formatCurrency, formatDate } from "../utils/format";

const PAGE_SIZE = 50;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const PERIOD_CHIPS = [
  { id: "all", label: "All time" },
  { id: "7", label: "Last 7 days" },
  { id: "30", label: "Last 30 days" },
  { id: "ytd", label: "Year to date" },
];

function resolveDates(period, dateFrom, dateTo) {
  if (YMD_RE.test(dateFrom) || YMD_RE.test(dateTo)) {
    return {
      dateFrom: YMD_RE.test(dateFrom) ? dateFrom : "",
      dateTo: YMD_RE.test(dateTo) ? dateTo : "",
    };
  }
  if (period === "all") return { dateFrom: "", dateTo: "" };
  if (period === "ytd") {
    const now = new Date();
    return { dateFrom: `${now.getFullYear()}-01-01`, dateTo: "" };
  }
  const days = Number(period);
  if (days > 0) {
    const from = new Date();
    from.setDate(from.getDate() - days);
    return { dateFrom: from.toISOString().slice(0, 10), dateTo: "" };
  }
  return { dateFrom: "", dateTo: "" };
}

// QBO Payment.PaymentMethodRef.name is sometimes blank; fall back to PaymentType
function fmtMethod(p) {
  return p.PaymentMethodRef?.name || p.PaymentType || "—";
}

// DepositToAccountRef is not always returned by QBO QL — show account name or ID
function fmtDeposit(p) {
  const ref = p.DepositToAccountRef;
  if (!ref) return "—";
  return ref.name || ref.value || "—";
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const period = url.searchParams.get("period") || "all";
  const customerId = (url.searchParams.get("customerId") || "").trim();
  const rawDateFrom = (url.searchParams.get("dateFrom") || "").trim();
  const rawDateTo = (url.searchParams.get("dateTo") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));

  const { dateFrom, dateTo } = resolveDates(period, rawDateFrom, rawDateTo);

  try {
    const [rows, total, customers] = await Promise.all([
      listPayments({ search: q, customerId, dateFrom, dateTo, page, pageSize: PAGE_SIZE }),
      countPayments({ search: q, customerId, dateFrom, dateTo }),
      listCustomers({ pageSize: 1000 }),
    ]);
    return {
      rows, total, page, pageSize: PAGE_SIZE,
      q, period, customerId,
      dateFrom: rawDateFrom, dateTo: rawDateTo,
      customers, error: null,
    };
  } catch (e) {
    console.error("[qbo/transactions] loader failed:", e?.message || e);
    return {
      rows: [], total: 0, page, pageSize: PAGE_SIZE,
      q, period, customerId,
      dateFrom: rawDateFrom, dateTo: rawDateTo,
      customers: [], error: e?.message || "Failed to load transactions",
    };
  }
};

export default function QboTransactions() {
  const { rows, total, page, pageSize, q, period, customerId, dateFrom, dateTo, customers, error } =
    useLoaderData();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const [localQ, setLocalQ] = useState(q);
  const localQRef = useRef(q);

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

  const getDateValue = (e) => e?.target?.value ?? e?.currentTarget?.value ?? "";

  const applySearch = () => updateParams({ q: localQRef.current, page: 1 });

  const resetFilters = () => {
    localQRef.current = "";
    setLocalQ("");
    updateParams({ q: "", period: "all", customerId: "", dateFrom: "", dateTo: "", page: 1 });
  };

  const activeFilters = [
    q && { key: "q", label: `Ref #: ${q}`, clear: { q: "", page: 1 } },
    customerId && {
      key: "customerId",
      label: `Customer: ${customers.find((c) => String(c.Id) === customerId)?.DisplayName ?? customerId}`,
      clear: { customerId: "", page: 1 },
    },
    dateFrom && { key: "dateFrom", label: `From: ${dateFrom}`, clear: { dateFrom: "", page: 1 } },
    dateTo && { key: "dateTo", label: `To: ${dateTo}`, clear: { dateTo: "", page: 1 } },
    period !== "all" && {
      key: "period",
      label: PERIOD_CHIPS.find((c) => c.id === period)?.label ?? period,
      clear: { period: "all", dateFrom: "", dateTo: "", page: 1 },
    },
  ].filter(Boolean);

  return (
    <>
      <s-section heading="Filters">
        <s-stack direction="block" gap="base">
          {/* Period chips */}
          <s-stack direction="inline" gap="small-200" wrap>
            {PERIOD_CHIPS.map((c) => (
              <s-clickable-chip
                key={c.id}
                selected={period === c.id && !dateFrom && !dateTo}
                onClick={() => updateParams({ period: c.id, dateFrom: "", dateTo: "", page: 1 })}
              >
                {c.label}
              </s-clickable-chip>
            ))}
          </s-stack>

          {/* Filter grid */}
          <s-grid gap="base" gridTemplateColumns="repeat(auto-fill, minmax(200px, 1fr))">
            <s-text-field
              label="Search ref #"
              placeholder="Payment reference number"
              value={localQ}
              onInput={(e) => { localQRef.current = e.target.value; setLocalQ(e.target.value); }}
              onKeyDown={(e) => e.key === "Enter" && applySearch()}
            />
            <s-select
              label="Customer"
              value={customerId}
              onChange={(e) =>
                updateParams({ customerId: e?.target?.value ?? e?.currentTarget?.value ?? "", page: 1 })
              }
            >
              <s-option value="">All customers</s-option>
              {customers.map((c) => (
                <s-option key={c.Id} value={String(c.Id)}>
                  {c.DisplayName}
                </s-option>
              ))}
            </s-select>
            <s-date-field
              label="From date"
              value={dateFrom}
              onInput={(e) => updateParams({ dateFrom: getDateValue(e), period: "all", page: 1 })}
              onChange={(e) => updateParams({ dateFrom: getDateValue(e), period: "all", page: 1 })}
            />
            <s-date-field
              label="To date"
              value={dateTo}
              onInput={(e) => updateParams({ dateTo: getDateValue(e), period: "all", page: 1 })}
              onChange={(e) => updateParams({ dateTo: getDateValue(e), period: "all", page: 1 })}
            />
          </s-grid>

          {/* Action row */}
          <s-stack direction="inline" gap="base" alignItems="center" wrap>
            <s-button
              variant="primary"
              onClick={applySearch}
              loading={tableLoading && !refreshing}
            >
              Apply filters
            </s-button>
            <s-button variant="tertiary" onClick={resetFilters}>
              Reset
            </s-button>
            <s-button
              variant="tertiary"
              icon="refresh"
              loading={refreshing}
              onClick={() => revalidator.revalidate()}
            >
              Refresh
            </s-button>
            {activeFilters.length > 0 && (
              <s-text tone="subdued">
                {activeFilters.length} filter{activeFilters.length === 1 ? "" : "s"} active
              </s-text>
            )}
          </s-stack>

          {/* Active filter chips */}
          {activeFilters.length > 0 && (
            <s-stack direction="inline" gap="small-200" wrap>
              {activeFilters.map((f) => (
                <s-tag key={f.key} onRemove={() => updateParams(f.clear)}>
                  {f.label}
                </s-tag>
              ))}
            </s-stack>
          )}
        </s-stack>
      </s-section>

      <s-section heading={`Payments (${total.toLocaleString()})`}>
        <s-stack direction="block" gap="base">
          {error && (
            <s-banner tone="critical" heading="Could not load payments">
              <s-paragraph>{error}</s-paragraph>
            </s-banner>
          )}

          {rows.length === 0 && !error ? (
            <s-box padding="large-500">
              <s-stack direction="block" gap="base" alignItems="center" justifyContent="center">
                <s-heading>{q || customerId ? "No matches" : "No payments"}</s-heading>
                <s-paragraph tone="subdued">
                  {q
                    ? `No QBO payments match "${q}".`
                    : "No payments found for this filter window."}
                </s-paragraph>
              </s-stack>
            </s-box>
          ) : (
            <s-table loading={tableLoading}>
              <s-table-header-row>
                <s-table-header>Date</s-table-header>
                <s-table-header>Customer</s-table-header>
                <s-table-header>Amount</s-table-header>
                <s-table-header>Ref #</s-table-header>
                <s-table-header>Method</s-table-header>
                <s-table-header>Deposit to</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {rows.map((p) => (
                  <s-table-row key={p.Id}>
                    <s-table-cell>{formatDate(p.TxnDate) || p.TxnDate || "—"}</s-table-cell>
                    <s-table-cell>{p.CustomerRef?.name || "—"}</s-table-cell>
                    <s-table-cell>
                      {formatCurrency(Number(p.TotalAmt || 0), p.CurrencyRef?.value)}
                    </s-table-cell>
                    <s-table-cell>{p.PaymentRefNum || "—"}</s-table-cell>
                    <s-table-cell>{fmtMethod(p)}</s-table-cell>
                    <s-table-cell>{fmtDeposit(p)}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}

          {total > 0 && (
            <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
              <s-text tone="subdued">
                Showing {firstShown}–{lastShown} of {total.toLocaleString()}
              </s-text>
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-button
                  variant="tertiary"
                  icon="arrow-left"
                  disabled={page <= 1}
                  onClick={() => updateParams({ page: page - 1 })}
                >
                  Previous
                </s-button>
                <s-text tone="subdued">Page {page} of {totalPages}</s-text>
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
