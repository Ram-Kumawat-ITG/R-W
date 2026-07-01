import { useRef, useState } from "react";
import {
  useLoaderData,
  useNavigation,
  useSearchParams,
  useRevalidator,
} from "react-router";
import { authenticate } from "../shopify.server";
import {
  listInvoices,
  countInvoices,
  listCustomers,
} from "../services/retailQbo/retailQbo.service";
import { formatCurrency, formatDate } from "../utils/format";

const PAGE_SIZE = 50;

const STATUS_OPTIONS = [
  { id: "all", label: "All" },
  { id: "paid", label: "Paid" },
  { id: "pending", label: "Pending" },
  { id: "overdue", label: "Overdue" },
  { id: "voided", label: "Voided" },
];

const STATUS_TONE = {
  Paid: "success",
  Partial: "info",
  Voided: "default",
  Pending: "warning",
};

function invoiceStatus(inv) {
  const total = Number(inv.TotalAmt || 0);
  const balance = Number(inv.Balance || 0);
  const paid = Number((total - balance).toFixed(2));
  if (total === 0) return "Voided";
  if (balance === 0) return "Paid";
  if (paid > 0) return "Partial";
  return "Pending";
}

function fmtDueDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return { label: dateStr, overdue: false };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return { label: d.toLocaleDateString(), overdue: d < today };
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const status = url.searchParams.get("status") || "all";
  const customerId = (url.searchParams.get("customerId") || "").trim();
  const dateFrom = (url.searchParams.get("dateFrom") || "").trim();
  const dateTo = (url.searchParams.get("dateTo") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));

  try {
    const [rows, total, customers] = await Promise.all([
      listInvoices({ search: q, status, customerId, dateFrom, dateTo, page, pageSize: PAGE_SIZE }),
      countInvoices({ search: q, status, customerId, dateFrom, dateTo }),
      listCustomers({ pageSize: 1000 }),
    ]);
    return { rows, total, page, pageSize: PAGE_SIZE, q, status, customerId, dateFrom, dateTo, customers, error: null };
  } catch (e) {
    console.error("[qbo/invoices] loader failed:", e?.message || e);
    return {
      rows: [], total: 0, page, pageSize: PAGE_SIZE,
      q, status, customerId, dateFrom, dateTo, customers: [],
      error: e?.message || "Failed to load invoices",
    };
  }
};

export default function QboInvoices() {
  const { rows, total, page, pageSize, q, status, customerId, dateFrom, dateTo, customers, error } =
    useLoaderData();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();

  // Local draft for text search — buffered until Apply/Enter
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
    updateParams({ q: "", status: "all", customerId: "", dateFrom: "", dateTo: "", page: 1 });
  };

  // Active filter chips
  const activeFilters = [
    q && { key: "q", label: `Invoice #: ${q}`, clear: { q: "", page: 1 } },
    customerId && {
      key: "customerId",
      label: `Customer: ${customers.find((c) => String(c.Id) === customerId)?.DisplayName ?? customerId}`,
      clear: { customerId: "", page: 1 },
    },
    dateFrom && { key: "dateFrom", label: `From: ${dateFrom}`, clear: { dateFrom: "", page: 1 } },
    dateTo && { key: "dateTo", label: `To: ${dateTo}`, clear: { dateTo: "", page: 1 } },
    status !== "all" && { key: "status", label: `Status: ${status}`, clear: { status: "all", page: 1 } },
  ].filter(Boolean);

  return (
    <>
      <s-section heading="Filters">
        <s-stack direction="block" gap="base">
          {/* Status chips */}
          <s-stack direction="inline" gap="small-200" wrap>
            {STATUS_OPTIONS.map((opt) => (
              <s-clickable-chip
                key={opt.id}
                selected={status === opt.id}
                onClick={() => updateParams({ status: opt.id, page: 1 })}
              >
                {opt.label}
              </s-clickable-chip>
            ))}
          </s-stack>

          {/* Filter grid */}
          <s-grid gap="base" gridTemplateColumns="repeat(auto-fill, minmax(200px, 1fr))">
            <s-text-field
              label="Search invoice #"
              placeholder="Document number"
              value={localQ}
              onInput={(e) => {
                localQRef.current = e.target.value;
                setLocalQ(e.target.value);
              }}
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
              onInput={(e) => updateParams({ dateFrom: getDateValue(e), page: 1 })}
              onChange={(e) => updateParams({ dateFrom: getDateValue(e), page: 1 })}
            />
            <s-date-field
              label="To date"
              value={dateTo}
              onInput={(e) => updateParams({ dateTo: getDateValue(e), page: 1 })}
              onChange={(e) => updateParams({ dateTo: getDateValue(e), page: 1 })}
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
                <s-tag
                  key={f.key}
                  onRemove={() => updateParams(f.clear)}
                >
                  {f.label}
                </s-tag>
              ))}
            </s-stack>
          )}
        </s-stack>
      </s-section>

      <s-section heading={`Invoices (${total.toLocaleString()})`}>
        <s-stack direction="block" gap="base">
          {error && (
            <s-banner tone="critical" heading="Could not load invoices">
              <s-paragraph>{error}</s-paragraph>
            </s-banner>
          )}

          {rows.length === 0 && !error ? (
            <s-box padding="large-500">
              <s-stack direction="block" gap="base" alignItems="center" justifyContent="center">
                <s-heading>{q || customerId ? "No matches" : "No invoices"}</s-heading>
                <s-paragraph tone="subdued">
                  {q
                    ? `No QBO invoices match "${q}".`
                    : "No invoices found for this filter."}
                </s-paragraph>
              </s-stack>
            </s-box>
          ) : (
            <s-table loading={tableLoading}>
              <s-table-header-row>
                <s-table-header>Invoice #</s-table-header>
                <s-table-header>Customer</s-table-header>
                <s-table-header>Date</s-table-header>
                <s-table-header>Due date</s-table-header>
                <s-table-header>Total</s-table-header>
                <s-table-header>Balance</s-table-header>
                <s-table-header>Status</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {rows.map((inv) => {
                  const st = invoiceStatus(inv);
                  const due = fmtDueDate(inv.DueDate);
                  return (
                    <s-table-row key={inv.Id}>
                      <s-table-cell>{inv.DocNumber || inv.Id}</s-table-cell>
                      <s-table-cell>{inv.CustomerRef?.name || "—"}</s-table-cell>
                      <s-table-cell>{formatDate(inv.TxnDate) || inv.TxnDate || "—"}</s-table-cell>
                      <s-table-cell>
                        {due ? (
                          <s-stack direction="block" gap="none">
                            <s-text>{due.label}</s-text>
                            {due.overdue && st !== "Paid" && st !== "Voided" && (
                              <s-badge tone="critical">Overdue</s-badge>
                            )}
                          </s-stack>
                        ) : (
                          "—"
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        {formatCurrency(Number(inv.TotalAmt || 0), inv.CurrencyRef?.value)}
                      </s-table-cell>
                      <s-table-cell>
                        {formatCurrency(Number(inv.Balance || 0), inv.CurrencyRef?.value)}
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge tone={STATUS_TONE[st] ?? "default"}>{st}</s-badge>
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
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
