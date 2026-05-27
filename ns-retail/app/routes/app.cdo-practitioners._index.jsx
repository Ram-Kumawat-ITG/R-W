import { useEffect, useMemo, useRef, useState } from "react";
import {
  useLoaderData,
  useNavigation,
  useRevalidator,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import connectDB from "../db/mongo.server";
import WholesaleApplication from "../models/wholesaleApplication.server";

// CDO Practitioners — approved wholesale applicants who indicated they
// resell products. The wholesale_applications collection lives in the
// wholesale workspace's MongoDB; ns-retail connects to the same URI.
//
// Filter is a literal string equality — `tax.itemsToResell` is stored
// as "yes" or "no" straight from the registration form's Step 2 radio.

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  await connectDB();

  const rows = await WholesaleApplication.find({
    "tax.itemsToResell": "yes",
    status: "approved",
  })
    .sort({ submittedAt: -1 })
    .select(
      "firstName lastName email phone businessName submittedAt customerId status tax.itemsToResell",
    )
    .lean();

  return {
    rows: rows.map((r) => ({
      id: r._id.toString(),
      firstName: r.firstName || "",
      lastName: r.lastName || "",
      email: r.email || "",
      phone: r.phone || "",
      businessName: r.businessName || "",
      submittedAt: r.submittedAt,
      customerId: r.customerId || null,
      status: r.status || "approved",
      itemsToResell: r.tax?.itemsToResell || "",
    })),
  };
};

const PAGE_SIZE = 15;

export default function CDOPractitionersList() {
  const { rows } = useLoaderData();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();

  const [search, setSearch] = useState("");
  const [sortOrder, setSortOrder] = useState("desc");
  const [page, setPage] = useState(1);
  const [filterPending, setFilterPending] = useState(false);
  const [detailRow, setDetailRow] = useState(null);
  const detailModalRef = useRef(null);
  const loadedToastShown = useRef(false);

  useEffect(() => {
    if (loadedToastShown.current) return;
    loadedToastShown.current = true;
    const n = rows.length;
    shopify?.toast?.show(
      `Loaded ${n} CDO ${n === 1 ? "practitioner" : "practitioners"}`,
    );
  }, [rows.length, shopify]);

  const flashFilterLoading = () => {
    setFilterPending(true);
    setTimeout(() => setFilterPending(false), 220);
  };

  const tableLoading =
    filterPending ||
    navigation.state === "loading" ||
    revalidator.state === "loading";

  useEffect(() => {
    setPage(1);
  }, [search]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const result = rows.filter((r) => {
      if (!q) return true;
      const haystack = [
        r.firstName,
        r.lastName,
        `${r.firstName} ${r.lastName}`,
        r.email,
        r.phone,
        r.businessName,
        r.customerId,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });

    result.sort((a, b) => {
      const tA = a.submittedAt ? new Date(a.submittedAt).getTime() : 0;
      const tB = b.submittedAt ? new Date(b.submittedAt).getTime() : 0;
      const cmp = tA - tB;
      return sortOrder === "asc" ? cmp : -cmp;
    });

    return result;
  }, [rows, search, sortOrder]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const firstShown =
    filtered.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const lastShown = Math.min(currentPage * PAGE_SIZE, filtered.length);
  const visibleRows = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  const openDetails = (row) => {
    setDetailRow(row);
    detailModalRef.current?.showOverlay?.();
  };
  const closeDetails = () => detailModalRef.current?.hideOverlay?.();

  return (
    <s-page inlineSize="large" heading="CDO Practitioners">
      <s-section padding="none">
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            <s-paragraph tone="subdued">
              Approved wholesale practitioners who indicated they resell
              products (Tax → Items to resell: Yes).
            </s-paragraph>
            <s-grid gap="small-200" gridTemplateColumns="1fr auto">
              <s-search-field
                label="Search"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search by name, email, phone, business, or customer ID"
                value={search}
                onInput={(e) => {
                  setSearch(e?.currentTarget?.value ?? "");
                  flashFilterLoading();
                }}
              />
              <s-button
                icon="sort"
                variant="secondary"
                accessibilityLabel="Sort"
                interestFor="cdo-sort-tooltip"
                commandFor="cdo-sort-actions"
              />
              <s-tooltip id="cdo-sort-tooltip">
                <s-text>Sort</s-text>
              </s-tooltip>
              <s-popover id="cdo-sort-actions">
                <s-stack gap="none">
                  <s-box padding="small">
                    <s-stack direction="block" gap="small-200">
                      <s-text variant="headingSm">Order</s-text>
                      <s-stack direction="inline" gap="small-200">
                        <s-clickable-chip
                          color={sortOrder === "asc" ? "strong" : "base"}
                          onClick={() => {
                            setSortOrder("asc");
                            flashFilterLoading();
                          }}
                        >
                          Oldest first
                        </s-clickable-chip>
                        <s-clickable-chip
                          color={sortOrder === "desc" ? "strong" : "base"}
                          onClick={() => {
                            setSortOrder("desc");
                            flashFilterLoading();
                          }}
                        >
                          Newest first
                        </s-clickable-chip>
                      </s-stack>
                    </s-stack>
                  </s-box>
                </s-stack>
              </s-popover>
            </s-grid>
          </s-stack>
        </s-box>

        {filtered.length === 0 ? (
          <EmptyState
            rowsTotal={rows.length}
            search={search}
            onClearSearch={() => {
              setSearch("");
              flashFilterLoading();
            }}
          />
        ) : (
          <s-table loading={tableLoading}>
            <s-table-header-row>
              <s-table-header>Practitioner</s-table-header>
              <s-table-header>Business</s-table-header>
              <s-table-header>Email</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Resells</s-table-header>
              <s-table-header>Created</s-table-header>
              <s-table-header>Customer ID</s-table-header>
              <s-table-header>
                <s-stack alignItems="center">Actions</s-stack>
              </s-table-header>
            </s-table-header-row>
            <s-table-body>
              {visibleRows.map((r) => {
                const fullName =
                  `${r.firstName} ${r.lastName}`.trim() || "(no name)";
                const submitted = r.submittedAt
                  ? new Date(r.submittedAt).toLocaleString()
                  : "—";
                return (
                  <s-table-row key={r.id} onClick={() => openDetails(r)}>
                    <s-table-cell>
                      <s-text>{fullName}</s-text>
                    </s-table-cell>
                    <s-table-cell>{r.businessName || "—"}</s-table-cell>
                    <s-table-cell>{r.email || "—"}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone="success">Approved</s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone="info">Yes</s-badge>
                    </s-table-cell>
                    <s-table-cell>{submitted}</s-table-cell>
                    <s-table-cell>{r.customerId || "—"}</s-table-cell>
                    <s-table-cell>
                      <s-stack
                        direction="inline"
                        gap="small"
                        justifyContent="center"
                        alignItems="center"
                      >
                        <s-button
                          variant="secondary"
                          accessibilityLabel={`View ${fullName}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            openDetails(r);
                          }}
                        >
                          View
                        </s-button>
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                );
              })}
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

      <s-modal
        ref={detailModalRef}
        id="cdo-practitioner-modal"
        heading={
          detailRow
            ? `${detailRow.firstName} ${detailRow.lastName}`.trim() ||
              "Practitioner"
            : "Practitioner"
        }
        accessibilityLabel="Practitioner details"
      >
        {detailRow ? (
          <s-stack direction="block" gap="base">
            <DetailRow label="Practitioner name" value={`${detailRow.firstName} ${detailRow.lastName}`.trim() || "—"} />
            <DetailRow label="Business name" value={detailRow.businessName || "—"} />
            <DetailRow label="Email" value={detailRow.email || "—"} />
            <DetailRow label="Phone" value={detailRow.phone || "—"} />
            <DetailRow label="Status" value="Approved" />
            <DetailRow label="Tax resell status" value="Yes" />
            <DetailRow
              label="Created date"
              value={
                detailRow.submittedAt
                  ? new Date(detailRow.submittedAt).toLocaleString()
                  : "—"
              }
            />
            <DetailRow label="Customer / Practitioner ID" value={detailRow.customerId || "—"} />
          </s-stack>
        ) : null}
        <s-button slot="primary-action" onClick={closeDetails}>
          Close
        </s-button>
      </s-modal>
    </s-page>
  );
}

function DetailRow({ label, value }) {
  return (
    <s-stack direction="block" gap="none">
      <s-text tone="subdued">{label}</s-text>
      <s-text>{value || "—"}</s-text>
    </s-stack>
  );
}

function EmptyState({ rowsTotal, search, onClearSearch }) {
  const hasSearch = (search || "").trim().length > 0;
  let heading = "No CDO practitioners yet";
  let body =
    "Approved practitioners who choose to resell products will appear here.";
  let actionLabel = null;
  let actionHandler = null;

  if (rowsTotal > 0 && hasSearch) {
    heading = "No matches";
    body = `No CDO practitioners match "${search}". Try a different keyword or clear the search.`;
    actionLabel = "Clear search";
    actionHandler = onClearSearch;
  }

  return (
    <s-box padding="large-500">
      <s-stack
        direction="block"
        gap="base"
        alignItems="center"
        justifyContent="center"
      >
        <s-heading>{heading}</s-heading>
        <s-paragraph tone="subdued">{body}</s-paragraph>
        {actionLabel && actionHandler && (
          <s-button onClick={actionHandler}>{actionLabel}</s-button>
        )}
      </s-stack>
    </s-box>
  );
}
