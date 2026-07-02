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
  buildCustomerRefWhere,
  getInvoiceWebUrl,
} from "../services/qbo/qbo.service";
import {
  escapeQboQuery,
  derivePaymentMethod,
  linkedInvoiceIds,
} from "../services/qbo/qbo.utils";
import { formatAmount, fmtDueDate, initialsOf } from "../utils/format.utils";
import { AdvancedFilters } from "../components/admin-ui";

const PAGE_SIZE = 50;

// Date-range filter chips. QBO QL doesn't have relative-date helpers,
// so we compute the cutoff in JS off `new Date()` and inject it as a
// literal ISO date string.
const DATE_FILTERS = [
  { id: "all", label: "All" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "ytd", label: "Year to date" },
];

// Config for the shared <AdvancedFilters> card.
const FILTER_FIELDS = [
  { key: "q", label: "Reference number", type: "text", placeholder: "Cheque / ref #" },
  {
    key: "customer",
    label: "Customer",
    type: "text",
    placeholder: "Name or company",
  },
  {
    key: "range",
    label: "Date range",
    type: "select",
    options: DATE_FILTERS.map((d) => ({ value: d.id, label: d.label })),
  },
  { key: "dateFrom", label: "From date", type: "date" },
  { key: "dateTo", label: "To date", type: "date" },
];
const FILTER_DEFAULTS = { range: "all" };

function buildDateWhere(filterId, now) {
  if (!filterId || filterId === "all") return null;
  if (filterId === "ytd") {
    return `TxnDate >= '${now.getFullYear()}-01-01'`;
  }
  const days = filterId === "7d" ? 7 : 30;
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days);
  const ymd = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
  return `TxnDate >= '${ymd}'`;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
// Explicit From/To range on TxnDate. Each bound applied only when a
// well-formed YYYY-MM-DD (the s-date-field always emits that; the regex
// guards hand-edited URLs). Null when neither bound is set, so the caller
// falls back to the relative `range`.
function buildExplicitDateWhere(from, to) {
  const parts = [];
  if (YMD_RE.test(from)) parts.push(`TxnDate >= '${from}'`);
  if (YMD_RE.test(to)) parts.push(`TxnDate <= '${to}'`);
  return parts.length ? parts.join(" AND ") : null;
}

function buildSearchWhere(q) {
  const trimmed = q.trim();
  if (!trimmed) return null;
  const v = escapeQboQuery(trimmed);
  // PaymentRefNum is the QBO field most analogous to "reference / cheque
  // number / NMI txn id". DisplayName / CustomerRef are not directly
  // queryable via LIKE on the Payment entity, so the search scope is
  // intentionally narrow — admins who need to filter by customer should
  // use the Customers tab to find the QBO id first.
  return `PaymentRefNum LIKE '%${v}%'`;
}

function combineWhere(...parts) {
  const filtered = parts.filter(Boolean);
  if (filtered.length === 0) return null;
  if (filtered.length === 1) return filtered[0];
  return filtered.map((p) => `(${p})`).join(" AND ");
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const customer = (url.searchParams.get("customer") || "").trim();
  const range = url.searchParams.get("range") || "all";
  const dateFrom = (url.searchParams.get("dateFrom") || "").trim();
  const dateTo = (url.searchParams.get("dateTo") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const startPosition = (page - 1) * PAGE_SIZE + 1;

  const commonState = {
    page,
    pageSize: PAGE_SIZE,
    q,
    customer,
    range,
    dateFrom,
    dateTo,
  };

  try {
    const explicitDate = buildExplicitDateWhere(dateFrom, dateTo);
    const customerWhere = await buildCustomerRefWhere(customer);
    const where = combineWhere(
      explicitDate || buildDateWhere(range, new Date()),
      buildSearchWhere(q),
      customerWhere,
    );

    const [pageRes, total] = await Promise.all([
      listPayments({ pageSize: PAGE_SIZE, startPosition, where }),
      countPayments({ where }),
    ]);

    return {
      ...commonState,
      rows: pageRes.entities.map(projectPayment),
      total,
      error: null,
    };
  } catch (e) {
    console.error("[qbo/transactions] loader failed:", e?.message || e);
    return {
      ...commonState,
      rows: [],
      total: 0,
      error: e?.message || "Failed to load QBO transactions",
    };
  }
};

function projectPayment(p) {
  // Voided + zero-amount payments retain TotalAmt=0; surface that as a
  // distinct status so the row doesn't read as "successful $0 payment".
  const amount = Number(p.TotalAmt || 0);
  const status = amount === 0 ? "Voided" : "Recorded";
  const paymentRef = p.PaymentRefNum || null;
  return {
    id: p.Id,
    customerName: p.CustomerRef?.name || null,
    customerId: p.CustomerRef?.value || null,
    totalAmount: amount,
    currency: p.CurrencyRef?.value || "USD",
    paymentMethod: derivePaymentMethod(p.PaymentMethodRef?.name, paymentRef),
    txnDate: p.TxnDate || null,
    paymentRef,
    privateNote: p.PrivateNote || null,
    // We list linked invoice ids so admins can correlate to
    // /app/qbo/invoices and deep-link straight into QuickBooks.
    linkedInvoices: linkedInvoiceIds(p).map((id) => ({
      id,
      url: getInvoiceWebUrl(id),
    })),
    status,
    createdAt: p.MetaData?.CreateTime || null,
  };
}

export default function QboTransactions() {
  const {
    rows,
    total,
    page,
    pageSize,
    q,
    customer,
    range,
    dateFrom,
    dateTo,
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
        values={{ q, customer, range, dateFrom, dateTo }}
        defaults={FILTER_DEFAULTS}
        onRefresh={() => revalidator.revalidate()}
        refreshing={refreshing}
        applying={tableLoading}
      />
      <s-section heading={`Transactions (${total})`}>
        <s-stack direction="block" gap="base">
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
              <s-text>{q || customer ? "🔍" : "📭"}</s-text>
              <s-heading>{q || customer ? "No matches" : "No transactions"}</s-heading>
              <s-paragraph tone="subdued">
                {q
                  ? `No QBO payments match "${q}".`
                  : customer
                    ? `No QBO payments found for a customer matching "${customer}".`
                    : "QuickBooks returned no payment records for this range."}
              </s-paragraph>
            </s-stack>
          </s-box>
        ) : (
          <s-table loading={tableLoading}>
            <s-table-header-row>
              <s-table-header>Transaction ID</s-table-header>
              <s-table-header>Type</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Amount</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Payment method</s-table-header>
              <s-table-header>Date</s-table-header>
              <s-table-header>Reference</s-table-header>
              <s-table-header>Applied to invoice</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((p) => (
                <s-table-row key={p.id}>
                  <s-table-cell>#{p.id}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone="info">Payment</s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <s-avatar
                        size="small-200"
                        initials={initialsOf(p.customerName)}
                        alt={p.customerName || "Customer"}
                      />
                      <s-text>{p.customerName || "—"}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    {formatAmount(p.totalAmount, p.currency)}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={p.status === "Voided" ? "default" : "success"}>
                      {p.status}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {p.paymentMethod ? (
                      <s-badge tone="neutral">{p.paymentMethod}</s-badge>
                    ) : (
                      <s-text tone="subdued">—</s-text>
                    )}
                  </s-table-cell>
                  <s-table-cell>{fmtDueDate(p.txnDate) || "—"}</s-table-cell>
                  <s-table-cell>
                    {p.paymentRef ? (
                      <s-text>{p.paymentRef}</s-text>
                    ) : (
                      <s-text tone="subdued">—</s-text>
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    {p.linkedInvoices.length > 0 ? (
                      <s-stack direction="block" gap="none">
                        {p.linkedInvoices.map((inv) =>
                          inv.url ? (
                            <s-link key={inv.id} href={inv.url} target="_blank">
                              #{inv.id}
                            </s-link>
                          ) : (
                            <s-text key={inv.id}>#{inv.id}</s-text>
                          ),
                        )}
                      </s-stack>
                    ) : (
                      <s-text tone="subdued">—</s-text>
                    )}
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
