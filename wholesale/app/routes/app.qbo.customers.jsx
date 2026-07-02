import {
  useLoaderData,
  useNavigation,
  useSearchParams,
  useRevalidator,
} from "react-router";
import { authenticate } from "../shopify.server";
import {
  listCustomers,
  countCustomers,
} from "../services/qbo/qbo.service";
import { escapeQboQuery } from "../services/qbo/qbo.utils";
import { formatAmount, fmtDueDate, initialsOf } from "../utils/format.utils";
import { AdvancedFilters } from "../components/admin-ui";

const PAGE_SIZE = 50;

// Status filter chips — Active / Inactive map to QBO's `Active` boolean.
// "All" sends no `where` clause.
const STATUS_FILTERS = [
  { id: "all", label: "All", where: null },
  { id: "active", label: "Active", where: "Active = true" },
  { id: "inactive", label: "Inactive", where: "Active = false" },
];

// Balance filter chips — whether the customer currently owes QBO money.
const BALANCE_FILTERS = [
  { id: "all", label: "All", where: null },
  { id: "with_balance", label: "With balance", where: "Balance > '0'" },
  { id: "no_balance", label: "No balance", where: "Balance = '0'" },
];

// Config for the shared <AdvancedFilters> card. Options mirror STATUS_FILTERS
// / BALANCE_FILTERS so the loader's where-clause mapping stays the single
// source of truth.
const FILTER_FIELDS = [
  {
    key: "q",
    label: "Search",
    type: "text",
    placeholder: "Name, company, or email",
  },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: STATUS_FILTERS.map((s) => ({ value: s.id, label: s.label })),
  },
  {
    key: "balance",
    label: "Balance",
    type: "select",
    options: BALANCE_FILTERS.map((b) => ({ value: b.id, label: b.label })),
  },
  { key: "dateFrom", label: "Customer since (from)", type: "date" },
  { key: "dateTo", label: "Customer since (to)", type: "date" },
];
const FILTER_DEFAULTS = { status: "all", balance: "all" };

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
// MetaData.CreateTime is a documented QBO QL filter/orderby field (unlike
// most metadata paths); each bound is applied only when well-formed so a
// hand-edited URL can't inject a raw expression.
function buildCreatedDateWhere(from, to) {
  const parts = [];
  if (YMD_RE.test(from)) parts.push(`MetaData.CreateTime >= '${from}'`);
  if (YMD_RE.test(to)) parts.push(`MetaData.CreateTime <= '${to}T23:59:59'`);
  return parts.length ? parts.join(" AND ") : null;
}

// Build a QBO QL WHERE predicate that matches the admin's free-text
// search against name, email, and company name. Returns null when the
// search is empty. The QL LIKE wildcards (% and _) are used naively —
// callers' raw input is escaped via escapeQboQuery so the only metas
// are the ones we add.
function buildSearchWhere(q) {
  const trimmed = q.trim();
  if (!trimmed) return null;
  const v = escapeQboQuery(trimmed);
  return (
    `(DisplayName LIKE '%${v}%' OR ` +
    `CompanyName LIKE '%${v}%' OR ` +
    `PrimaryEmailAddr LIKE '%${v}%')`
  );
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
  const status = url.searchParams.get("status") || "all";
  const balance = url.searchParams.get("balance") || "all";
  const dateFrom = (url.searchParams.get("dateFrom") || "").trim();
  const dateTo = (url.searchParams.get("dateTo") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const startPosition = (page - 1) * PAGE_SIZE + 1;

  const commonState = {
    page,
    pageSize: PAGE_SIZE,
    q,
    status,
    balance,
    dateFrom,
    dateTo,
  };

  const statusWhere =
    STATUS_FILTERS.find((s) => s.id === status)?.where || null;
  const balanceWhere =
    BALANCE_FILTERS.find((b) => b.id === balance)?.where || null;
  const searchWhere = buildSearchWhere(q);
  const where = combineWhere(
    statusWhere,
    balanceWhere,
    buildCreatedDateWhere(dateFrom, dateTo),
    searchWhere,
  );

  // Page + total in parallel — QBO's list response only carries the
  // returned-on-this-page count, not the grand total.
  try {
    const [page1, total] = await Promise.all([
      listCustomers({ pageSize: PAGE_SIZE, startPosition, where }),
      countCustomers({ where }),
    ]);

    return {
      ...commonState,
      rows: page1.entities.map(projectCustomer),
      total,
      error: null,
    };
  } catch (e) {
    console.error("[qbo/customers] loader failed:", e?.message || e);
    return {
      ...commonState,
      rows: [],
      total: 0,
      error: e?.message || "Failed to load QBO customers",
    };
  }
};

// Pick only what the table renders so the loader response stays small
// and we don't accidentally ship every QBO field over the wire.
function projectCustomer(c) {
  return {
    id: c.Id,
    displayName: c.DisplayName || null,
    givenName: c.GivenName || null,
    familyName: c.FamilyName || null,
    companyName: c.CompanyName || null,
    email: c.PrimaryEmailAddr?.Address || null,
    phone: c.PrimaryPhone?.FreeFormNumber || null,
    balance: c.Balance != null ? Number(c.Balance) : null,
    currency: c.CurrencyRef?.value || "USD",
    paymentTerms: c.SalesTermRef?.name || null,
    active: c.Active !== false,
    createdAt: c.MetaData?.CreateTime || null,
  };
}

export default function QboCustomers() {
  const {
    rows,
    total,
    page,
    pageSize,
    q,
    status,
    balance,
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

  // Pagination only — filter navigation is owned by <AdvancedFilters>.
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
        values={{ q, status, balance, dateFrom, dateTo }}
        defaults={FILTER_DEFAULTS}
        onRefresh={() => revalidator.revalidate()}
        refreshing={refreshing}
        applying={tableLoading}
      />
      <s-section heading={`Customers (${total})`}>
        <s-stack direction="block" gap="base">
        {error && (
          <s-banner tone="critical" heading="Could not load customers">
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
              <s-heading>{q ? "No matches" : "No customers"}</s-heading>
              <s-paragraph tone="subdued">
                {q
                  ? `No QBO customers match "${q}".`
                  : "QuickBooks returned no customers for this query."}
              </s-paragraph>
            </s-stack>
          </s-box>
        ) : (
          <s-table loading={tableLoading}>
            <s-table-header-row>
              <s-table-header>Customer name</s-table-header>
              <s-table-header>Email</s-table-header>
              <s-table-header>Phone</s-table-header>
              <s-table-header>Company</s-table-header>
              <s-table-header>Customer ID</s-table-header>
              <s-table-header>Balance</s-table-header>
              <s-table-header>Customer since</s-table-header>
              <s-table-header>Status</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((c) => {
                const name =
                  c.displayName ||
                  [c.givenName, c.familyName].filter(Boolean).join(" ") ||
                  c.email ||
                  `Customer ${c.id}`;
                return (
                  <s-table-row key={c.id}>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small-200" alignItems="center">
                        <s-avatar
                          size="small-200"
                          initials={initialsOf(name)}
                          alt={name}
                        />
                        <s-text>{name}</s-text>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{c.email || "—"}</s-table-cell>
                    <s-table-cell>{c.phone || "—"}</s-table-cell>
                    <s-table-cell>{c.companyName || "—"}</s-table-cell>
                    <s-table-cell>#{c.id}</s-table-cell>
                    <s-table-cell>
                      {c.balance != null ? (
                        <s-text tone={c.balance > 0 ? "critical" : undefined}>
                          {formatAmount(c.balance, c.currency)}
                        </s-text>
                      ) : (
                        "—"
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      {c.createdAt ? fmtDueDate(c.createdAt) : "—"}
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone={c.active ? "success" : "default"}>
                        {c.active ? "Active" : "Inactive"}
                      </s-badge>
                    </s-table-cell>
                  </s-table-row>
                );
              })}
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
