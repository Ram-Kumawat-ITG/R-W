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

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  await connectDB();

  const rows = await WholesaleApplication.find({})
    .sort({ submittedAt: -1 })
    .select(
      "firstName lastName email phone submittedAt customerId shopifyCreateFailed businessName status reviewedAt",
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
      shopifyCreateFailed: Boolean(r.shopifyCreateFailed),
      status: r.status || "pending",
      reviewedAt: r.reviewedAt || null,
    })),
  };
};


const STATUS_FILTERS = [
  { id: "all", label: "All" },
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "sync-failed", label: "Sync failed" },
];

export default function CustomersList() {
  const { rows } = useLoaderData();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const reviewFetcher = useFetcher();
  const revalidator = useRevalidator();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [declineTarget, setDeclineTarget] = useState(null);
  const [filterPending, setFilterPending] = useState(false);
  const [reviewingId, setReviewingId] = useState(null);
  const modalRef = useRef(null);
  const loadedToastShown = useRef(false);
  // Track which response payload we've already handled so React-Router's
  // automatic post-action revalidation doesn't re-fire toast / state resets
  // on every subsequent render.
  const handledDeclineRef = useRef(null);
  const handledReviewRef = useRef(null);

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
    fetcher.state !== "idle" ||
    reviewFetcher.state !== "idle";

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter === "approved") {
        if (!(r.status === "approved" && !r.shopifyCreateFailed)) return false;
      } else if (statusFilter === "pending") {
        if (r.status === "approved" || r.shopifyCreateFailed) return false;
      } else if (statusFilter === "sync-failed") {
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
  }, [rows, search, statusFilter]);

  const declining = fetcher.state === "submitting" || fetcher.state === "loading";

  // Handle decline result. React-Router auto-revalidates the loader after a
  // fetcher action, so we don't call revalidator.revalidate() manually — that
  // would race with the auto-revalidation and (because revalidator's reference
  // changes on each state transition) put this effect into an infinite loop.
  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.state !== "idle") return;
    if (handledDeclineRef.current === fetcher.data) return;
    handledDeclineRef.current = fetcher.data;

    if (fetcher.data.status === "success") {
      shopify?.toast?.show("Customer declined and removed.");
      setDeclineTarget(null);
    } else if (fetcher.data.status === "error") {
      shopify?.toast?.show(
        fetcher.data.result?.detail || fetcher.data.message || "Decline failed.",
        { isError: true },
      );
    }
  }, [fetcher.data, fetcher.state, shopify]);

  // Handle review / un-review result (same pattern as decline above).
  useEffect(() => {
    if (!reviewFetcher.data) return;
    if (reviewFetcher.state !== "idle") return;
    if (handledReviewRef.current === reviewFetcher.data) return;
    handledReviewRef.current = reviewFetcher.data;

    if (reviewFetcher.data.status === "success") {
      shopify?.toast?.show(reviewFetcher.data.message || "Updated.");
      setReviewingId(null);
    } else if (reviewFetcher.data.status === "error") {
      shopify?.toast?.show(
        reviewFetcher.data.result?.detail ||
          reviewFetcher.data.message ||
          "Update failed.",
        { isError: true },
      );
      setReviewingId(null);
    }
  }, [reviewFetcher.data, reviewFetcher.state, shopify]);

  const toggleReviewForRow = (row) => {
    if (!row?.id) return;
    const isApproved = row.status === "approved";
    setReviewingId(row.id);
    reviewFetcher.submit(null, {
      method: "POST",
      action: `/api/admin/customers/${row.id}/${isApproved ? "unreview" : "review"}`,
    });
  };

  const openDeclineFor = (row) => {
    setDeclineTarget(row);
    requestAnimationFrame(() => modalRef.current?.showOverlay?.());
  };
  const closeModal = () => {
    modalRef.current?.hideOverlay?.();
    setDeclineTarget(null);
  };
  const confirmDecline = () => {
    if (!declineTarget) return;
    fetcher.submit(null, {
      method: "POST",
      action: `/api/admin/customers/${declineTarget.id}/decline`,
    });
    modalRef.current?.hideOverlay?.();
  };

  return (
    <s-page inlineSize="large" heading="Wholesale applications">
      <s-section padding="none">
        <s-box padding="base">
          <s-stack direction="block" gap="base">
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
            <s-stack direction="inline" gap="small-200">
              {STATUS_FILTERS.map((f) => {
                const active = statusFilter === f.id;
                const count =
                  f.id === "all"
                    ? rows.length
                    : f.id === "approved"
                      ? rows.filter(
                          (r) => r.status === "approved" && !r.shopifyCreateFailed,
                        ).length
                      : f.id === "pending"
                        ? rows.filter(
                            (r) => r.status !== "approved" && !r.shopifyCreateFailed,
                          ).length
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
              <s-table-header><s-stack alignItems="center">Actions</s-stack></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {filtered.map((r) => {
                const fullName =
                  `${r.firstName} ${r.lastName}`.trim() || "(no name)";
                const submitted = r.submittedAt
                  ? new Date(r.submittedAt).toLocaleString()
                  : "";
                const go = () => navigate(`/app/customers/${r.id}`);
                return (
                  <s-table-row key={r.id} onClick={go}>
                    <s-table-cell>
                      <s-text>{fullName}</s-text>
                    </s-table-cell>
                    <s-table-cell>{r.email}</s-table-cell>
                    <s-table-cell>{r.phone || "—"}</s-table-cell>
                    <s-table-cell>{submitted}</s-table-cell>
                    <s-table-cell>
                      {r.shopifyCreateFailed ? (
                        <s-badge tone="critical">Sync failed</s-badge>
                      ) : r.status === "approved" ? (
                        <s-badge tone="success">Approved</s-badge>
                      ) : (
                        <s-badge>Pending</s-badge>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="inline" gap="tight" justifyContent="center" alignItems="center">
                        <s-button
                          variant={r.status === "approved" ? "secondary" : "primary"}
                          tone={r.status === "approved" ? "critical" : undefined}
                          icon={r.status === "approved" ? "undo" : "check"}
                          accessibilityLabel={
                            r.status === "approved"
                              ? `Revoke ${fullName}`
                              : `Review ${fullName}`
                          }
                          disabled={!r.customerId || r.shopifyCreateFailed}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleReviewForRow(r);
                          }}
                          {...(reviewingId === r.id ? { loading: true } : {})}
                        >
                          {r.status === "approved" ? "Revoke" : "Review"}
                        </s-button>
                        <s-button
                          variant="tertiary"
                          tone="critical"
                          icon="delete"
                          accessibilityLabel={`Decline ${fullName}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            openDeclineFor(r);
                          }}
                        />
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-modal
        ref={modalRef}
        id="decline-customer-modal"
        heading={
          declineTarget
            ? `Decline ${declineTarget.firstName} ${declineTarget.lastName}?`
            : "Decline customer?"
        }
        accessibilityLabel="Decline customer confirmation"
      >
        <s-paragraph>
          This will remove the customer from Shopify, delete their record from the
          database, and send them a rejection email. This cannot be undone.
        </s-paragraph>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          onClick={confirmDecline}
          {...(declining ? { loading: true } : {})}
        >
          Decline &amp; delete
        </s-button>
        <s-button slot="secondary-actions" onClick={closeModal}>
          Cancel
        </s-button>
      </s-modal>
    </s-page>
  );
}

function EmptyState({ rowsTotal, statusFilter, search, onClearSearch, onShowAll }) {
  // Pick the right copy + action based on context.
  let icon = "📭";
  let heading = "No applications yet";
  let body = "Once customers submit the wholesale form, their applications will show up here.";
  let actionLabel = null;
  let actionHandler = null;

  const hasSearch = (search || "").trim().length > 0;

  if (rowsTotal === 0) {
    // Truly empty database.
    icon = "📭";
    heading = "No applications yet";
    body =
      "Share the wholesale registration form with your customers. Their applications will appear here as they come in.";
  } else if (hasSearch) {
    icon = "🔍";
    heading = "No matches";
    body = `No applications match "${search}". Try a different keyword or clear the search.`;
    actionLabel = "Clear search";
    actionHandler = onClearSearch;
  } else if (statusFilter === "approved") {
    icon = "✅";
    heading = "No approved applications";
    body =
      "Approved customers will appear here once you review and approve them.";
    actionLabel = "Show all";
    actionHandler = onShowAll;
  } else if (statusFilter === "pending") {
    icon = "📨";
    heading = "No pending applications";
    body =
      "Pending applications waiting on your review will appear here.";
    actionLabel = "Show all";
    actionHandler = onShowAll;
  } else if (statusFilter === "sync-failed") {
    icon = "🎉";
    heading = "No failed syncs";
    body =
      "Every application has successfully synced to Shopify. If any fail in the future, they'll show up here so you can retry them.";
    actionLabel = "Show all";
    actionHandler = onShowAll;
  } else {
    // Fallback — shouldn't normally hit this branch.
    icon = "📭";
    heading = "No applications match the current filters";
    body = "Try changing the filters or clearing the search.";
  }

  return (
    <s-box padding="large-500">
      <s-stack direction="block" gap="base" alignItems="center" justifyContent="center">
        <s-text>{icon}</s-text>
        <s-heading>{heading}</s-heading>
        <s-paragraph tone="subdued">{body}</s-paragraph>
        {actionLabel && actionHandler && (
          <s-button onClick={actionHandler}>{actionLabel}</s-button>
        )}
      </s-stack>
    </s-box>
  );
}
