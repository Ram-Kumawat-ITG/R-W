import { useRef, useState } from "react";
import {
  useLoaderData,
  useNavigation,
  useSearchParams,
  useRevalidator,
} from "react-router";
import { authenticate } from "../shopify.server";
import { listCustomers, countCustomers } from "../services/retailQbo/retailQbo.service";
import { formatCurrency, formatDate } from "../utils/format";

const PAGE_SIZE = 50;

function projectCustomer(c) {
  return {
    id: c.Id,
    displayName: c.DisplayName || null,
    givenName: c.GivenName || null,
    familyName: c.FamilyName || null,
    companyName: c.CompanyName || null,
    email: c.PrimaryEmailAddr?.Address || null,
    phone: c.PrimaryPhone?.FreeFormNumber || null,
    balance: Number(c.Balance || 0),
    currency: c.CurrencyRef?.value || "USD",
    // SalesTermRef.name gives the term label (e.g. "Net 30", "Due on receipt")
    paymentTerms: c.SalesTermRef?.name || c.SalesTermRef?.value || null,
    active: c.Active !== false,
    createdAt: c.MetaData?.CreateTime || null,
  };
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const status = url.searchParams.get("status") || "all";
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));

  try {
    const [rows, total] = await Promise.all([
      listCustomers({ search: q, status, page, pageSize: PAGE_SIZE }),
      countCustomers({ search: q, status }),
    ]);
    return { rows: rows.map(projectCustomer), total, page, pageSize: PAGE_SIZE, q, status, error: null };
  } catch (e) {
    console.error("[qbo/customers] loader failed:", e?.message || e);
    return { rows: [], total: 0, page, pageSize: PAGE_SIZE, q, status, error: e?.message || "Failed to load customers" };
  }
};

export default function QboCustomers() {
  const { rows, total, page, pageSize, q, status, error } = useLoaderData();
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

  const applySearch = () => updateParams({ q: localQRef.current, page: 1 });

  const resetFilters = () => {
    localQRef.current = "";
    setLocalQ("");
    updateParams({ q: "", status: "all", page: 1 });
  };

  const activeFilters = [
    q && { key: "q", label: `Search: ${q}`, clear: { q: "", page: 1 } },
    status !== "all" && {
      key: "status",
      label: status === "active" ? "Active" : "Inactive",
      clear: { status: "all", page: 1 },
    },
  ].filter(Boolean);

  return (
    <>
      <s-section heading="Filters">
        <s-stack direction="block" gap="base">
          {/* Filter grid */}
          <s-grid gap="base" gridTemplateColumns="repeat(auto-fill, minmax(220px, 1fr))">
            <s-text-field
              label="Search"
              placeholder="Name, company, or email"
              value={localQ}
              onInput={(e) => { localQRef.current = e.target.value; setLocalQ(e.target.value); }}
              onKeyDown={(e) => e.key === "Enter" && applySearch()}
            />
            <s-select
              label="Status"
              value={status}
              onChange={(e) =>
                updateParams({ status: e?.target?.value ?? e?.currentTarget?.value ?? "all", page: 1 })
              }
            >
              <s-option value="all">All customers</s-option>
              <s-option value="active">Active</s-option>
              <s-option value="inactive">Inactive</s-option>
            </s-select>
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

      <s-section heading={`Customers (${total.toLocaleString()})`}>
        <s-stack direction="block" gap="base">
          {error && (
            <s-banner tone="critical" heading="Could not load customers">
              <s-paragraph>{error}</s-paragraph>
            </s-banner>
          )}

          {rows.length === 0 && !error ? (
            <s-box padding="large-500">
              <s-stack direction="block" gap="base" alignItems="center" justifyContent="center">
                <s-heading>{q ? "No matches" : "No customers"}</s-heading>
                <s-paragraph tone="subdued">
                  {q ? `No QBO customers match "${q}".` : "No customers found in QBO."}
                </s-paragraph>
              </s-stack>
            </s-box>
          ) : (
            <s-table loading={tableLoading}>
              <s-table-header-row>
                <s-table-header>Name</s-table-header>
                <s-table-header>Company</s-table-header>
                <s-table-header>Email</s-table-header>
                <s-table-header>Phone</s-table-header>
                <s-table-header>Balance</s-table-header>
                <s-table-header>Terms</s-table-header>
                <s-table-header>Created</s-table-header>
                <s-table-header>Status</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {rows.map((c) => (
                  <s-table-row key={c.id}>
                    <s-table-cell>
                      <s-stack direction="block" gap="none">
                        <s-text>{c.displayName || "—"}</s-text>
                        {(c.givenName || c.familyName) &&
                          c.displayName !== `${c.givenName || ""} ${c.familyName || ""}`.trim() && (
                            <s-text tone="subdued">
                              {[c.givenName, c.familyName].filter(Boolean).join(" ")}
                            </s-text>
                          )}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{c.companyName || "—"}</s-table-cell>
                    <s-table-cell>{c.email || "—"}</s-table-cell>
                    <s-table-cell>{c.phone || "—"}</s-table-cell>
                    <s-table-cell>{formatCurrency(c.balance, c.currency)}</s-table-cell>
                    <s-table-cell>
                      {c.paymentTerms ? (
                        <s-badge tone="info">{c.paymentTerms}</s-badge>
                      ) : (
                        <s-text tone="subdued">—</s-text>
                      )}
                    </s-table-cell>
                    <s-table-cell>{c.createdAt ? formatDate(c.createdAt) : "—"}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={c.active ? "success" : "default"}>
                        {c.active ? "Active" : "Inactive"}
                      </s-badge>
                    </s-table-cell>
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
