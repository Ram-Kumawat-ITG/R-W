import { useState } from "react";
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
import { formatAmount } from "../utils/format.utils";

const PAGE_SIZE = 50;

// Status filter chips — Active / Inactive map to QBO's `Active` boolean.
// "All" sends no `where` clause.
const STATUS_FILTERS = [
  { id: "all", label: "All", where: null },
  { id: "active", label: "Active", where: "Active = true" },
  { id: "inactive", label: "Inactive", where: "Active = false" },
];

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
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const startPosition = (page - 1) * PAGE_SIZE + 1;

  const statusWhere =
    STATUS_FILTERS.find((s) => s.id === status)?.where || null;
  const searchWhere = buildSearchWhere(q);
  const where = combineWhere(statusWhere, searchWhere);

  // Page + total in parallel — QBO's list response only carries the
  // returned-on-this-page count, not the grand total.
  try {
    const [page1, total] = await Promise.all([
      listCustomers({ pageSize: PAGE_SIZE, startPosition, where }),
      countCustomers({ where }),
    ]);

    return {
      rows: page1.entities.map(projectCustomer),
      total,
      page,
      pageSize: PAGE_SIZE,
      q,
      status,
      error: null,
    };
  } catch (e) {
    console.error("[qbo/customers] loader failed:", e?.message || e);
    return {
      rows: [],
      total: 0,
      page,
      pageSize: PAGE_SIZE,
      q,
      status,
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
  const { rows, total, page, pageSize, q, status, error } = useLoaderData();
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

  const onStatusChip = (id) => updateParams({ status: id === "all" ? null : id });
  const onSearchSubmit = (e) => {
    e?.preventDefault?.();
    updateParams({ q: searchInput.trim() || null });
  };
  const onSearchClear = () => {
    setSearchInput("");
    updateParams({ q: null });
  };

  return (
    <s-section heading={`Customers (${total})`}>
      <s-stack direction="block" gap="base">
        <form onSubmit={onSearchSubmit}>
          <s-stack direction="inline" gap="small-200" alignItems="end">
            <s-search-field
              label="Search"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search by name, company, or email"
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

        <s-stack direction="inline" gap="small-200">
          {STATUS_FILTERS.map((f) => {
            const active = status === f.id;
            return (
              <s-clickable-chip
                key={f.id}
                color={active ? "strong" : "base"}
                accessibilityLabel={`Filter by ${f.label}`}
                onClick={() => onStatusChip(f.id)}
              >
                {f.label}
              </s-clickable-chip>
            );
          })}
        </s-stack>

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
              <s-table-header>Company</s-table-header>
              <s-table-header>Customer ID</s-table-header>
              <s-table-header>Balance</s-table-header>
              <s-table-header>Payment terms</s-table-header>
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
                    <s-table-cell>{name}</s-table-cell>
                    <s-table-cell>{c.email || "—"}</s-table-cell>
                    <s-table-cell>{c.companyName || "—"}</s-table-cell>
                    <s-table-cell>#{c.id}</s-table-cell>
                    <s-table-cell>
                      {c.balance != null
                        ? formatAmount(c.balance, c.currency)
                        : "—"}
                    </s-table-cell>
                    <s-table-cell>{c.paymentTerms || "—"}</s-table-cell>
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
  );
}
