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
  buildCustomerRefWhere,
} from "../services/qbo/qbo.service";
import { escapeQboQuery } from "../services/qbo/qbo.utils";
import { formatAmount, fmtDueDate, initialsOf } from "../utils/format.utils";
import { AdvancedFilters } from "../components/admin-ui";

const PAGE_SIZE = 50;

// Payment-status filter chips, plus an Overdue filter that augments
// the predicate with a DueDate comparison. The Overdue filter only
// makes sense for unpaid invoices, so we narrow on Balance > '0' too.
function buildFilterWhere(filterId, now) {
  if (!filterId || filterId === "all") return null;
  const todayYmd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  switch (filterId) {
    case "paid":
      // Balance=0 + TotalAmt>0 excludes voided invoices (which also have
      // Balance=0 but TotalAmt=0).
      return "Balance = '0' AND TotalAmt > '0'";
    case "pending":
      return "Balance > '0'";
    case "overdue":
      return `Balance > '0' AND DueDate < '${todayYmd}'`;
    case "voided":
      return "TotalAmt = '0'";
    default:
      return null;
  }
}

const FILTER_CHIPS = [
  { id: "all", label: "All" },
  { id: "paid", label: "Paid" },
  { id: "pending", label: "Pending" },
  { id: "overdue", label: "Overdue" },
  { id: "voided", label: "Voided" },
];

// Config for the shared <AdvancedFilters> card. Status options mirror
// FILTER_CHIPS so the loader's where-clause mapping stays the source of truth.
const FILTER_FIELDS = [
  { key: "q", label: "Invoice number", type: "text", placeholder: "#1142" },
  {
    key: "customer",
    label: "Customer",
    type: "text",
    placeholder: "Name or company",
  },
  {
    key: "filter",
    label: "Payment status",
    type: "select",
    options: FILTER_CHIPS.map((f) => ({ value: f.id, label: f.label })),
  },
  { key: "dateFrom", label: "From date", type: "date" },
  { key: "dateTo", label: "To date", type: "date" },
];
const FILTER_DEFAULTS = { filter: "all" };

function buildSearchWhere(q) {
  const trimmed = q.trim();
  if (!trimmed) return null;
  const v = escapeQboQuery(trimmed);
  // DocNumber LIKE for partial invoice-number matches.
  return `DocNumber LIKE '%${v}%'`;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
// Explicit From/To range on the invoice TxnDate. Each bound is applied only
// when it is a well-formed YYYY-MM-DD (the s-date-field always emits that
// shape; the regex guards against hand-edited URLs from being injected raw).
function buildDateRangeWhere(from, to) {
  const parts = [];
  if (YMD_RE.test(from)) parts.push(`TxnDate >= '${from}'`);
  if (YMD_RE.test(to)) parts.push(`TxnDate <= '${to}'`);
  return parts.length ? parts.join(" AND ") : null;
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
  const filter = url.searchParams.get("filter") || "all";
  const dateFrom = (url.searchParams.get("dateFrom") || "").trim();
  const dateTo = (url.searchParams.get("dateTo") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const startPosition = (page - 1) * PAGE_SIZE + 1;
  const now = new Date();

  const commonState = {
    page,
    pageSize: PAGE_SIZE,
    q,
    customer,
    filter,
    dateFrom,
    dateTo,
  };

  try {
    const customerWhere = await buildCustomerRefWhere(customer);
    const where = combineWhere(
      buildFilterWhere(filter, now),
      buildDateRangeWhere(dateFrom, dateTo),
      buildSearchWhere(q),
      customerWhere,
    );

    const [pageRes, total] = await Promise.all([
      listInvoices({ pageSize: PAGE_SIZE, startPosition, where }),
      countInvoices({ where }),
    ]);

    return {
      ...commonState,
      rows: pageRes.entities.map((inv) => projectInvoice(inv, now)),
      total,
      error: null,
    };
  } catch (e) {
    console.error("[qbo/invoices] loader failed:", e?.message || e);
    return {
      ...commonState,
      rows: [],
      total: 0,
      error: e?.message || "Failed to load QBO invoices",
    };
  }
};

function projectInvoice(inv, now) {
  const total = Number(inv.TotalAmt || 0);
  const balance = Number(inv.Balance || 0);
  const paid = Number((total - balance).toFixed(2));
  // Derive a single payment-status label from QBO's amount fields.
  // Voided = TotalAmt zeroed out; Paid = Balance fully cleared; Partial
  // = some money received; Pending = nothing collected yet.
  let paymentStatus;
  if (total === 0) paymentStatus = "Voided";
  else if (balance === 0) paymentStatus = "Paid";
  else if (paid > 0) paymentStatus = "Partial";
  else paymentStatus = "Pending";

  // Overdue overlay — purely an unpaid + past-due flag on top of the
  // base payment status. Used by the table to render the due-date cell
  // in critical tone.
  let overdue = false;
  if (paymentStatus !== "Paid" && paymentStatus !== "Voided" && inv.DueDate) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(inv.DueDate);
    if (m) {
      const due = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      const today = new Date(now);
      today.setHours(0, 0, 0, 0);
      overdue = due < today;
    }
  }

  return {
    id: inv.Id,
    docNumber: inv.DocNumber || null,
    customerName: inv.CustomerRef?.name || null,
    customerId: inv.CustomerRef?.value || null,
    totalAmount: total,
    balance,
    paid,
    currency: inv.CurrencyRef?.value || "USD",
    txnDate: inv.TxnDate || null,
    dueDate: inv.DueDate || null,
    paymentStatus,
    invoiceStatus: total === 0 ? "Voided" : balance === 0 ? "Closed" : "Open",
    emailStatus: inv.EmailStatus || null,
    billEmail: inv.BillEmail?.Address || null,
    privateNote: inv.PrivateNote || null,
    overdue,
  };
}

const PAYMENT_TONE = {
  Paid: "success",
  Partial: "info",
  Pending: "warning",
  Voided: "default",
};

const EMAIL_TONE = {
  EmailSent: "success",
  NeedToSend: "warning",
  NotSet: "default",
};

export default function QboInvoices() {
  const {
    rows,
    total,
    page,
    pageSize,
    q,
    customer,
    filter,
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
        values={{ q, customer, filter, dateFrom, dateTo }}
        defaults={FILTER_DEFAULTS}
        onRefresh={() => revalidator.revalidate()}
        refreshing={refreshing}
        applying={tableLoading}
      />
      <s-section heading={`Invoices (${total})`}>
        <s-stack direction="block" gap="base">
        {error && (
          <s-banner tone="critical" heading="Could not load invoices">
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
              <s-heading>{q || customer ? "No matches" : "No invoices"}</s-heading>
              <s-paragraph tone="subdued">
                {q
                  ? `No QBO invoices match "${q}".`
                  : customer
                    ? `No QBO invoices found for a customer matching "${customer}".`
                    : "QuickBooks returned no invoices for this filter."}
              </s-paragraph>
            </s-stack>
          </s-box>
        ) : (
          <s-table loading={tableLoading}>
            <s-table-header-row>
              <s-table-header>Invoice #</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Total</s-table-header>
              <s-table-header>Paid</s-table-header>
              <s-table-header>Balance</s-table-header>
              <s-table-header>Due date</s-table-header>
              <s-table-header>Payment status</s-table-header>
              <s-table-header>Invoice status</s-table-header>
              <s-table-header>Sent</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((inv) => (
                <s-table-row key={inv.id}>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <s-text>
                        {inv.docNumber ? `#${inv.docNumber}` : `#${inv.id}`}
                      </s-text>
                      <s-text tone="subdued">
                        {inv.txnDate ? fmtDueDate(inv.txnDate) : ""}
                      </s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <s-avatar
                        size="small-200"
                        initials={initialsOf(inv.customerName)}
                        alt={inv.customerName || "Customer"}
                      />
                      <s-stack direction="block" gap="none">
                        <s-text>{inv.customerName || "—"}</s-text>
                        {inv.billEmail && (
                          <s-text tone="subdued">{inv.billEmail}</s-text>
                        )}
                      </s-stack>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    {formatAmount(inv.totalAmount, inv.currency)}
                  </s-table-cell>
                  <s-table-cell>
                    {formatAmount(inv.paid, inv.currency)}
                  </s-table-cell>
                  <s-table-cell>
                    {formatAmount(inv.balance, inv.currency)}
                  </s-table-cell>
                  <s-table-cell>
                    {inv.dueDate ? (
                      <s-text tone={inv.overdue ? "critical" : undefined}>
                        {fmtDueDate(inv.dueDate)}
                        {inv.overdue ? " · OVERDUE" : ""}
                      </s-text>
                    ) : (
                      "—"
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={PAYMENT_TONE[inv.paymentStatus] || "default"}>
                      {inv.paymentStatus}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge
                      tone={
                        inv.invoiceStatus === "Voided" ? "default"
                        : inv.invoiceStatus === "Closed" ? "success"
                        : "info"
                      }
                    >
                      {inv.invoiceStatus}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {inv.emailStatus ? (
                      <s-badge tone={EMAIL_TONE[inv.emailStatus] || "default"}>
                        {inv.emailStatus === "EmailSent"
                          ? "Sent"
                          : inv.emailStatus === "NeedToSend"
                            ? "Pending"
                            : "Not set"}
                      </s-badge>
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
