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
}) {
  const navigation = useNavigation();
  const revalidator = useRevalidator();

  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const searchable = Array.isArray(searchKeys) && searchKeys.length > 0;

  useEffect(() => {
    setPage(1);
  }, [search]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!searchable || !q) return rows;
    return rows.filter((r) =>
      searchKeys
        .map((k) => r[k])
        .filter((v) => v != null && v !== "")
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [rows, search, searchKeys, searchable]);

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
      {(description || searchable) && (
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            {description ? (
              <s-paragraph tone="subdued">{description}</s-paragraph>
            ) : null}
            {searchable ? (
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-search-field
                  label="Search"
                  labelAccessibilityVisibility="exclusive"
                  placeholder={searchPlaceholder}
                  value={search}
                  onInput={(e) => setSearch(e?.currentTarget?.value ?? "")}
                />
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
