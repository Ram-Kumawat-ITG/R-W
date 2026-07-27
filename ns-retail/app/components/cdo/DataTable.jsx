/* eslint-disable react/prop-types */
import { useEffect, useMemo, useState } from "react";
import { useNavigation, useRevalidator } from "react-router";

// Reusable list table for the CDO Program tabs (Orders, Commissions,
// Payouts, Referrals, Transactions, CDO Customers). Owns client-side
// search + pagination so each tab route only declares its columns and
// hands over rows. No data fetching here — loaders do that.
//
// `columns`: [{ key, header, render?(row) => node, align? }]
// `searchKeys`: row keys concatenated into the search haystack. Omit to
//   hide the search field.
// `filters`: optional [{ key, label, options:[{label,value}], predicate(row,value) }]
//   — rendered as <s-select> chips next to the search box and applied
//   client-side (before search). The first option is the default/"no filter"
//   choice; a falsy value means "don't filter".

const DEFAULT_PAGE_SIZE = 15;

export default function DataTable({
  columns,
  rows,
  searchKeys,
  searchPlaceholder = "Search",
  emptyHeading = "Nothing here yet",
  emptyBody = "Records will appear here once they exist.",
  pageSize = DEFAULT_PAGE_SIZE,
  description,
  filters,
}) {
  const navigation = useNavigation();
  const revalidator = useRevalidator();

  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const searchable = Array.isArray(searchKeys) && searchKeys.length > 0;
  const hasFilters = Array.isArray(filters) && filters.length > 0;

  const [filterValues, setFilterValues] = useState(() =>
    hasFilters ? Object.fromEntries(filters.map((f) => [f.key, f.options[0]?.value ?? ""])) : {},
  );

  useEffect(() => {
    setPage(1);
  }, [search, filterValues]);

  const filtered = useMemo(() => {
    let base = rows;
    if (hasFilters) {
      for (const f of filters) {
        const v = filterValues[f.key];
        if (v) base = base.filter((r) => f.predicate(r, v));
      }
    }
    const q = search.trim().toLowerCase();
    if (!searchable || !q) return base;
    return base.filter((r) =>
      searchKeys
        .map((k) => r[k])
        .filter((v) => v != null && v !== "")
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [rows, search, searchKeys, searchable, hasFilters, filters, filterValues]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const firstShown =
    filtered.length === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const lastShown = Math.min(currentPage * pageSize, filtered.length);
  const visibleRows = filtered.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  const tableLoading =
    navigation.state === "loading" || revalidator.state === "loading";

  return (
    <s-section padding="none">
      {(description || searchable || hasFilters) && (
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            {description ? (
              <s-paragraph tone="subdued">{description}</s-paragraph>
            ) : null}
            {searchable || hasFilters ? (
              <s-stack direction="inline" gap="base" alignItems="end" wrap>
                {searchable ? (
                  <s-search-field
                    label="Search"
                    labelAccessibilityVisibility="exclusive"
                    placeholder={searchPlaceholder}
                    value={search}
                    onInput={(e) => setSearch(e?.currentTarget?.value ?? "")}
                  />
                ) : null}
                {hasFilters
                  ? filters.map((f) => (
                      <s-select
                        key={f.key}
                        label={f.label}
                        labelAccessibilityVisibility={f.label ? "visible" : "exclusive"}
                        value={filterValues[f.key] ?? f.options[0]?.value ?? ""}
                        onChange={(e) =>
                          setFilterValues((prev) => ({
                            ...prev,
                            [f.key]: e?.target?.value ?? "",
                          }))
                        }
                      >
                        {f.options.map((o) => (
                          <s-option key={o.value} value={o.value}>
                            {o.label}
                          </s-option>
                        ))}
                      </s-select>
                    ))
                  : null}
                <s-button
                  variant="tertiary"
                  icon="refresh"
                  onClick={() => revalidator.revalidate()}
                  {...(revalidator.state !== "idle" ? { loading: true } : {})}
                >
                  Refresh
                </s-button>
              </s-stack>
            ) : null}
          </s-stack>
        </s-box>
      )}

      {filtered.length === 0 ? (
        <EmptyState
          rowsTotal={rows.length}
          search={search}
          emptyHeading={emptyHeading}
          emptyBody={emptyBody}
          onClearSearch={() => setSearch("")}
        />
      ) : (
        <s-table loading={tableLoading}>
          <s-table-header-row>
            {columns.map((c) => (
              <s-table-header key={c.key}>{c.header}</s-table-header>
            ))}
          </s-table-header-row>
          <s-table-body>
            {visibleRows.map((row) => (
              <s-table-row key={row.id}>
                {columns.map((c) => (
                  <s-table-cell key={c.key}>
                    {c.render ? c.render(row) : row[c.key] ?? "—"}
                  </s-table-cell>
                ))}
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      )}

      {filtered.length > 0 && (
        <s-box padding="base">
          <s-stack
            direction="inline"
            gap="base"
            alignItems="center"
            justifyContent="space-between"
          >
            <s-text tone="subdued">
              Showing {firstShown}–{lastShown} of {filtered.length}
            </s-text>
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-button
                variant="tertiary"
                disabled={currentPage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                icon="arrow-left"
              >
                Previous
              </s-button>
              <s-text tone="subdued">
                Page {currentPage} of {totalPages}
              </s-text>
              <s-button
                variant="tertiary"
                disabled={currentPage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </s-button>
            </s-stack>
          </s-stack>
        </s-box>
      )}
    </s-section>
  );
}

function EmptyState({ rowsTotal, search, emptyHeading, emptyBody, onClearSearch }) {
  const hasSearch = (search || "").trim().length > 0;
  const matchMode = rowsTotal > 0 && hasSearch;

  return (
    <s-box padding="large-500">
      <s-stack
        direction="block"
        gap="base"
        alignItems="center"
        justifyContent="center"
      >
        <s-heading>{matchMode ? "No matches" : emptyHeading}</s-heading>
        <s-paragraph tone="subdued">
          {matchMode
            ? `No records match "${search}". Try a different keyword or clear the search.`
            : emptyBody}
        </s-paragraph>
        {matchMode ? (
          <s-button onClick={onClearSearch}>Clear search</s-button>
        ) : null}
      </s-stack>
    </s-box>
  );
}
