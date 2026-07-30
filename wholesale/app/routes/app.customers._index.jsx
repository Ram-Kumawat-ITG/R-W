import { useEffect, useMemo, useRef, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useNavigation,
  useRevalidator,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import connectDB from "../services/APIService/mongo.service";
import WholesaleApplication from "../models/wholesaleApplication.server";
import { getNotificationSettings } from "../services/scheduler/cronNotificationSettings.service";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  await connectDB();

  const rows = await WholesaleApplication.find({})
    .sort({ submittedAt: -1 })
    .select(
      "firstName lastName email phone submittedAt customerId shopifyCreateFailed businessName status reviewedAt",
    )
    .lean();

  const emailPause = await getNotificationSettings();

  return {
    emailPause: {
      paused: emailPause.emailNotificationsPaused === true,
      pausedAt: emailPause.pausedAt ? new Date(emailPause.pausedAt).toISOString() : null,
      pausedBy: emailPause.pausedBy || null,
    },
    rows: rows.map((r) => ({
      id: r._id.toString(),
      firstName: r.firstName || "",
      lastName: r.lastName || "",
      email: r.email || "",
      phone: r.phone || "",
      businessName: r.businessName || "",
      submittedAt: r.submittedAt,
      customerId: r.customerId || null,
      shopifyCreateFailed: Boolean(r.shopifyCreateFailed),
      status: r.status || "pending",
      reviewedAt: r.reviewedAt || null,
    })),
  };
};

const STATUS_FILTERS = [
  { id: "all", label: "All" },
  { id: "sync-failed", label: "Sync failed" },
];

// Records per page. Filtering and pagination both happen client-side
// (the loader returns the full list), so we just slice the filtered
// array. Matches the project's existing list-page pattern (Orders list
// uses 25).
const PAGE_SIZE = 15;

export default function CustomersList() {
  const { rows, emailPause } = useLoaderData();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState("desc");
  const [page, setPage] = useState(1);
  const [filterPending, setFilterPending] = useState(false);
  const [decliningId, setDecliningId] = useState(null);
  const [pendingDeclineRow, setPendingDeclineRow] = useState(null);
  const declineFetcher = useFetcher();
  const emailPauseFetcher = useFetcher();

  // Global email kill switch. Optimistically reflect the in-flight toggle so
  // the banner flips immediately; the loader revalidates on completion.
  const emailBusy = emailPauseFetcher.state !== "idle";
  const emailPaused =
    emailPauseFetcher.data?.result?.emailNotificationsPaused ??
    emailPause?.paused ??
    false;

  useEffect(() => {
    if (emailPauseFetcher.state === "idle" && emailPauseFetcher.data) {
      const paused = emailPauseFetcher.data?.result?.emailNotificationsPaused;
      shopify.toast.show(
        paused
          ? "All email notifications are now PAUSED"
          : "Email notifications resumed",
      );
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailPauseFetcher.state, emailPauseFetcher.data]);

  const toggleEmailPause = () => {
    emailPauseFetcher.submit(
      {},
      {
        method: "post",
        action: emailPaused
          ? "/api/admin/cron-notifications/resume"
          : "/api/admin/cron-notifications/pause",
        encType: "application/json",
      },
    );
  };
  const declineModalRef = useRef(null);
  const loadedToastShown = useRef(false);
  // Track which response payload we've already handled so React-Router's
  // automatic post-action revalidation doesn't re-fire toast / state resets
  // on every subsequent render.
  const handledDeclineRef = useRef(null);

  // One-time toast on initial mount confirming data was fetched.
  useEffect(() => {
    if (loadedToastShown.current) return;
    loadedToastShown.current = true;
    const n = rows.length;
    shopify?.toast?.show(
      `Loaded ${n} ${n === 1 ? "application" : "applications"}`,
    );
  }, [rows.length, shopify]);

  // Brief artificial loading so search + chip clicks feel responsive even
  // though the actual filter runs client-side in useMemo.
  const flashFilterLoading = () => {
    setFilterPending(true);
    setTimeout(() => setFilterPending(false), 220);
  };

  const tableLoading =
    filterPending ||
    navigation.state === "loading" ||
    revalidator.state === "loading" ||
    declineFetcher.state !== "idle";

  // Whenever the filter inputs change, snap back to page 1 so the user
  // isn't stranded on (e.g.) page 4 of an empty result set.
  useEffect(() => {
    setPage(1);
  }, [search, statusFilter]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const result = rows.filter((r) => {
      if (statusFilter === "sync-failed") {
        if (!r.shopifyCreateFailed) return false;
      }
      if (!q) return true;
      const haystack = [
        r.firstName,
        r.lastName,
        `${r.firstName} ${r.lastName}`,
        r.email,
        r.phone,
        r.businessName,
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
  }, [rows, search, statusFilter, sortOrder]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const firstShown =
    filtered.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const lastShown = Math.min(currentPage * PAGE_SIZE, filtered.length);
  const visibleRows = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  // Handle decline result.
  useEffect(() => {
    if (!declineFetcher.data) return;
    if (declineFetcher.state !== "idle") return;
    if (handledDeclineRef.current === declineFetcher.data) return;
    handledDeclineRef.current = declineFetcher.data;

    if (declineFetcher.data.status === "success") {
      shopify?.toast?.show("Customer blocked.");
      setDecliningId(null);
    } else if (declineFetcher.data.status === "error") {
      shopify?.toast?.show(
        declineFetcher.data.result?.detail ||
          declineFetcher.data.message ||
          "Decline failed.",
        { isError: true },
      );
      setDecliningId(null);
    }
  }, [declineFetcher.data, declineFetcher.state, shopify]);

  const openDeclineModal = (row) => {
    if (!row?.id) return;
    setPendingDeclineRow(row);
    declineModalRef.current?.showOverlay?.();
  };
  const closeDeclineModal = () => declineModalRef.current?.hideOverlay?.();
  const onConfirmDecline = () => {
    if (!pendingDeclineRow?.id) return;
    const id = pendingDeclineRow.id;
    closeDeclineModal();
    setDecliningId(id);
    declineFetcher.submit(null, {
      method: "POST",
      action: `/api/admin/customers/${id}/block`,
    });
    setPendingDeclineRow(null);
  };

  return (
    <s-page inlineSize="large" heading="Wholesale applications">
      {/* Global email kill switch — silences ALL outbound email (SMTP
          notifications, QuickBooks invoice emails, Shopify invites) from a
          single control. Does not affect charge processing, invoicing, or
          data sync — only email delivery. */}
      <s-section padding="none">
        <s-banner
          tone={emailPaused ? "critical" : "info"}
          heading={
            emailPaused
              ? "All email notifications are PAUSED"
              : "Email notifications are active"
          }
        >
          <s-stack direction="block" gap="small-200">
            <s-text>
              {emailPaused
                ? "No emails are being sent from any source — SMTP notifications, QuickBooks invoice emails, and Shopify invites are all suppressed. Charging, invoicing, and data sync are unaffected."
                : "Use this to stop ALL outbound customer + admin email from every source (SMTP, QuickBooks invoices, Shopify invites) in one click — e.g. while working with migrated/real customer data."}
            </s-text>
            {emailPaused && emailPause?.pausedBy ? (
              <s-text tone="subdued">
                Paused by {emailPause.pausedBy}
                {emailPause.pausedAt
                  ? ` on ${new Date(emailPause.pausedAt).toLocaleString()}`
                  : ""}
              </s-text>
            ) : null}
            <s-box>
              <s-button
                variant={emailPaused ? "secondary" : "primary"}
                tone={emailPaused ? undefined : "critical"}
                onClick={toggleEmailPause}
                {...(emailBusy ? { loading: true } : {})}
              >
                {emailBusy
                  ? "Working…"
                  : emailPaused
                    ? "Resume email notifications"
                    : "Stop all email notifications"}
              </s-button>
            </s-box>
          </s-stack>
        </s-banner>
      </s-section>

      <s-section padding="none">
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            <s-grid gap="small-200" gridTemplateColumns="1fr auto">
              <s-search-field
                label="Search"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search by name, email, phone, or business"
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
                interestFor="sort-tooltip"
                commandFor="sort-actions"
              />
              <s-tooltip id="sort-tooltip">
                <s-text>Sort</s-text>
              </s-tooltip>
              <s-popover id="sort-actions">
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
            <s-stack direction="inline" gap="small-200">
              {STATUS_FILTERS.map((f) => {
                const active = statusFilter === f.id;
                const count =
                  f.id === "all"
                    ? rows.length
                    : rows.filter((r) => r.shopifyCreateFailed).length;
                return (
                  <s-clickable-chip
                    key={f.id}
                    color={active ? "strong" : "base"}
                    accessibilityLabel={`Filter by ${f.label}`}
                    onClick={() => {
                      setStatusFilter(f.id);
                      flashFilterLoading();
                    }}
                  >
                    {f.label} ({count})
                  </s-clickable-chip>
                );
              })}
            </s-stack>
          </s-stack>
        </s-box>

        {filtered.length === 0 ? (
          <EmptyState
            rowsTotal={rows.length}
            statusFilter={statusFilter}
            search={search}
            onClearSearch={() => {
              setSearch("");
              flashFilterLoading();
            }}
            onShowAll={() => {
              setStatusFilter("all");
              flashFilterLoading();
            }}
          />
        ) : (
          <s-table loading={tableLoading}>
            <s-table-header-row>
              <s-table-header>Name</s-table-header>
              <s-table-header>Email</s-table-header>
              <s-table-header>Phone</s-table-header>
              <s-table-header>Submitted</s-table-header>
              <s-table-header>Status</s-table-header>
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
                  : "";
                return (
                  <s-table-row key={r.id} clickDelegate={`row-link-${r.id}  `}>
                    <s-table-cell>
                      <s-link
                        id={`row-link-${r.id}`}
                        href={`/app/customers/${r.id}`}
                      >
                        <s-text>{fullName}</s-text>
                      </s-link>
                    </s-table-cell>
                    <s-table-cell>{r.email}</s-table-cell>
                    <s-table-cell>{r.phone || "-"}</s-table-cell>
                    <s-table-cell>{submitted}</s-table-cell>
                    <s-table-cell>
                      {r.shopifyCreateFailed ? (
                        <s-badge tone="critical">Sync failed</s-badge>
                      ) : r.status === "blocked" ? (
                        <s-badge tone="critical">Blocked</s-badge>
                      ) : (
                        <s-badge tone="success">Approved</s-badge>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack
                        direction="inline"
                        gap="small"
                        justifyContent="center"
                        alignItems="center"
                      >
                        <s-button
                          variant="secondary"
                          tone="critical"
                          disabled={r.status === "blocked"}
                          accessibilityLabel={`Block ${fullName}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            openDeclineModal(r);
                          }}
                          {...(decliningId === r.id ? { loading: true } : {})}
                        >
                          Block
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
        ref={declineModalRef}
        id="block-customer-modal"
        heading="Block this customer?"
        accessibilityLabel="Block customer confirmation"
      >
        <s-paragraph>
          This customer will be tagged as Blocked in Shopify. They keep their
          record and order history, but won't be able to place new wholesale
          orders. You can reverse this later.
        </s-paragraph>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          onClick={onConfirmDecline}
          {...(declineFetcher.state !== "idle" ? { loading: true } : {})}
        >
          Block customer
        </s-button>
        <s-button slot="secondary-actions" onClick={closeDeclineModal}>
          Cancel
        </s-button>
      </s-modal>
    </s-page>
  );
}

function EmptyState({
  rowsTotal,
  statusFilter,
  search,
  onClearSearch,
  onShowAll,
}) {
  let heading = "No applications yet";
  let body =
    "Once customers submit the wholesale form, their applications will show up here.";
  let actionLabel = null;
  let actionHandler = null;

  const hasSearch = (search || "").trim().length > 0;

  if (rowsTotal === 0) {
    heading = "No applications yet";
    body =
      "Share the wholesale registration form with your customers. Their applications will appear here as they come in.";
  } else if (hasSearch) {
    heading = "No matches";
    body = `No applications match "${search}". Try a different keyword or clear the search.`;
    actionLabel = "Clear search";
    actionHandler = onClearSearch;
  } else if (statusFilter === "sync-failed") {
    heading = "No failed syncs";
    body =
      "Every application has successfully synced to Shopify. Any future sync failures will appear here.";
    actionLabel = "Show all";
    actionHandler = onShowAll;
  } else {
    heading = "No applications match the current filters";
    body = "Try changing the filters or clearing the search.";
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
