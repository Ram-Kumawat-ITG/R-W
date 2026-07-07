import { useEffect, useState } from "react";
import { useLoaderData, useNavigate, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";
import connectDB from "../services/APIService/mongo.service";
import {
  getUpcomingBatch,
  getBatchHistory,
} from "../services/scheduler/cronBatch.service";
import {
  OrdersTabBar,
  CollapsibleSection,
  AdvancedFilters,
} from "../components/admin-ui";
import { formatAmount, formatDuration } from "../utils/format.utils";

const BATCH_HISTORY_PAGE_SIZE = 10;

// Batch history filters — exact matches on CronBatchRun's own fields
// (status, tick) plus an inclusive date range on `startedAt`. Kept
// separate from the Practitioner Orders list's own filter set since
// this is a different route entirely.
const HISTORY_STATUS_OPTIONS = [
  { value: "", label: "Any" },
  { value: "success", label: "Success" },
  { value: "partial", label: "Partial" },
  { value: "failed", label: "Failed" },
];
const HISTORY_TICK_OPTIONS = [
  { value: "", label: "Any" },
  { value: "primary", label: "15th of the month" },
  { value: "secondary", label: "Last day of the month" },
  { value: "dev", label: "Dev interval" },
  { value: "manual", label: "Manual" },
];
const HISTORY_FILTER_FIELDS = [
  { key: "status", label: "Status", type: "select", options: HISTORY_STATUS_OPTIONS },
  { key: "tick", label: "Schedule", type: "select", options: HISTORY_TICK_OPTIONS },
  { key: "dateFrom", label: "From date", type: "date" },
  { key: "dateTo", label: "To date", type: "date" },
];
const HISTORY_FILTER_KEYS = HISTORY_FILTER_FIELDS.map((f) => f.key);

// CRON Batch tab — sibling of the Orders list (see the OrdersTabBar
// comment in components/admin-ui.jsx for why this is a standalone route
// rather than a nested layout). Surfaces the wholesale card/ACH
// auto-charge CRON (process-pending-payments):
//   - Upcoming batch: what the NEXT scheduled run would pick up right
//     now (a live estimate — invoices can be added/paid/paused before
//     it actually fires), with a live countdown to that run.
//   - Batch history: every past run (CronBatchRun, written once per
//     tick — see services/scheduler/jobs/processPendingPayments.job.js),
//     each rendered as a collapsible accordion revealing the per-order
//     breakdown (CronBatchRunItem) on expand.
//
// Both queries are wrapped in `safe()` so a scheduler/history hiccup
// degrades to a banner instead of a hard page failure — this page has
// no other content to protect, but the pattern matches the QBO/NMI
// dashboards' per-metric resilience.
async function safe(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[orders/cron-batch] ${label} failed:`, err?.message || err);
    return null;
  }
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  await connectDB();

  const url = new URL(request.url);
  const batchPage = Math.max(1, Number(url.searchParams.get("batchPage") || 1));
  const batchFilters = {};
  for (const key of HISTORY_FILTER_KEYS) {
    const v = (url.searchParams.get(key) || "").trim();
    if (v) batchFilters[key] = v;
  }

  const [upcomingBatch, batchHistory] = await Promise.all([
    safe("upcoming CRON batch", () => getUpcomingBatch()),
    safe("CRON batch history", () =>
      getBatchHistory({ page: batchPage, pageSize: BATCH_HISTORY_PAGE_SIZE, ...batchFilters }),
    ),
  ]);

  return { upcomingBatch, batchHistory, batchPage, batchFilters };
};

const UPCOMING_STATUS_TONE = {
  running: { tone: "info", label: "Running now" },
  scheduled: { tone: "default", label: "Scheduled" },
  unscheduled: { tone: "warning", label: "Not scheduled" },
};

function UpcomingStatusBadge({ status }) {
  const m = UPCOMING_STATUS_TONE[status] || { tone: "default", label: status || "—" };
  return <s-badge tone={m.tone}>{m.label}</s-badge>;
}

const BATCH_RUN_STATUS_TONE = {
  success: { tone: "success", label: "Success" },
  partial: { tone: "warning", label: "Partial" },
  failed: { tone: "critical", label: "Failed" },
};

function BatchRunStatusBadge({ status }) {
  const m = BATCH_RUN_STATUS_TONE[status] || { tone: "default", label: status || "—" };
  return <s-badge tone={m.tone}>{m.label}</s-badge>;
}

// Small stat tile — label above, value below. Used for the "Upcoming
// batch" summary grid and each batch history accordion's expanded stats.
function BatchStat({ label, value }) {
  return (
    <s-stack direction="block" gap="none">
      <s-text tone="subdued">{label}</s-text>
      <s-text variant="headingMd">{value}</s-text>
    </s-stack>
  );
}

const TICK_LABEL = {
  primary: "15th of the month",
  secondary: "Last day of the month",
  dev: "Dev interval",
  manual: "Manual",
};

// Result of a single invoice's CRON charge attempt (CronBatchRunItem.outcome)
// — distinct from BatchRunStatusBadge, which is the whole batch's rollup.
const ITEM_OUTCOME_TONE = {
  approved: { tone: "success", label: "Approved" },
  declined: { tone: "critical", label: "Declined" },
  errored: { tone: "critical", label: "Errored" },
  skipped: { tone: "default", label: "Skipped" },
};

function ItemOutcomeBadge({ outcome }) {
  const m = ITEM_OUTCOME_TONE[outcome] || { tone: "default", label: outcome || "—" };
  return <s-badge tone={m.tone}>{m.label}</s-badge>;
}

// Payment-status cell for an UPCOMING (not-yet-attempted) invoice. All
// items in the upcoming list match `paymentStatus: 'pending'`, but a
// nonzero attemptCount means earlier retries already failed, so that
// context is worth surfacing alongside the badge.
function PendingStatusCell({ item }) {
  return (
    <s-stack direction="block" gap="none">
      <s-badge tone="warning">Pending</s-badge>
      {item.attemptCount > 0 && (
        <s-text tone="subdued">
          {item.attemptCount}/{item.maxAttempts} attempts
        </s-text>
      )}
    </s-stack>
  );
}

// Shared per-order breakdown table — used both for a completed batch's
// history (outcome-based status) and the upcoming batch's live preview
// (pending-status). Columns: Order ID, Practitioner, Order date,
// Invoice #, Invoice amount, Processing fee, Payment status.
function OrderBreakdownTable({ items, renderStatus }) {
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header>Order ID</s-table-header>
        <s-table-header>Practitioner</s-table-header>
        <s-table-header>Order date</s-table-header>
        <s-table-header>Invoice #</s-table-header>
        <s-table-header>Invoice amount</s-table-header>
        <s-table-header>Processing fee</s-table-header>
        <s-table-header>Payment status</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {items.map((it) => (
          <s-table-row key={it._id}>
            <s-table-cell>{it.orderLabel || it.shopifyOrderId || "—"}</s-table-cell>
            <s-table-cell>
              <s-stack direction="block" gap="none">
                <s-text>{it.practitionerName || "—"}</s-text>
                {it.practitionerEmail && (
                  <s-text tone="subdued">{it.practitionerEmail}</s-text>
                )}
              </s-stack>
            </s-table-cell>
            <s-table-cell>
              {it.orderDate ? new Date(it.orderDate).toLocaleDateString() : "—"}
            </s-table-cell>
            <s-table-cell>{it.qboDocNumber || "—"}</s-table-cell>
            <s-table-cell>{formatAmount(it.invoiceAmount, it.currency) ?? "—"}</s-table-cell>
            <s-table-cell>{formatAmount(it.processingFeeAmount, it.currency) ?? "—"}</s-table-cell>
            <s-table-cell>{renderStatus(it)}</s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}

// Live "time remaining" readout — ticks once a second on the client
// against a fixed `targetIso` timestamp from the loader. Purely local
// component state (setInterval → setState), so it never triggers a
// loader revalidation; only this one small tile re-renders each second.
function CountdownTimer({ targetIso }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!targetIso) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [targetIso]);

  if (!targetIso) return <s-text variant="headingMd">—</s-text>;

  const diffMs = new Date(targetIso).getTime() - now;
  if (diffMs <= 0) {
    return (
      <s-text variant="headingMd" tone="success">
        Due now
      </s-text>
    );
  }

  const totalSeconds = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (days || hours) parts.push(`${hours}h`);
  if (days || hours || minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return <s-text variant="headingMd">{parts.join(" ")}</s-text>;
}

// One CRON batch's history entry, rendered as a collapsible accordion.
// Collapsed: a compact one-line summary (batch id, run time, status,
// quick-glance counts) so a long history scans quickly. Expanded: the
// full stat grid + error summary + complete per-order breakdown. Data
// is already loaded (embedded on `batch.items` by getBatchHistory), so
// expanding is a pure client-side render toggle — no extra fetch, no
// perf cost — safe to open/close freely without affecting the rest of
// the page.
//
// The expanded card is visually distinguished from its collapsed
// siblings via `<s-box>`'s design-token border/background props — a
// stronger, thicker border plus a subdued fill — rather than a
// `<s-section>` (which has no border/background props) or any custom
// CSS (admin routes are Polaris-token-only, no `style={{}}`/classes per
// project convention, so there's no animated open/close transition —
// the visual state change itself is the signal).
function BatchHistoryCard({ batch: b, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const items = b.items || [];
  const shortId = String(b._id).slice(-8);

  return (
    <s-box
      border="base"
      borderWidth={open ? "base" : "small"}
      borderColor={open ? "strong" : "subdued"}
      borderRadius="base"
      background={open ? "subdued" : "transparent"}
    >
      <s-clickable onClick={() => setOpen((v) => !v)}>
        <s-box padding="base">
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between" wrap>
            <s-stack direction="inline" gap="base" alignItems="center" wrap>
              <s-text tone="subdued">{open ? "▾" : "▸"}</s-text>
              <s-stack direction="block" gap="none">
                <s-text variant="headingSm">{shortId}</s-text>
                <s-text tone="subdued">
                  {b.startedAt ? new Date(b.startedAt).toLocaleString() : "—"} ·{" "}
                  {TICK_LABEL[b.tick] || b.tick || "—"}
                </s-text>
              </s-stack>
            </s-stack>
            <s-stack direction="inline" gap="base" alignItems="center" wrap>
              {!open && (
                <s-text tone="subdued">
                  {b.totalPractitioners ?? 0} practitioner{b.totalPractitioners === 1 ? "" : "s"} ·{" "}
                  {b.totalInvoicesProcessed ?? 0} invoice{b.totalInvoicesProcessed === 1 ? "" : "s"} ·{" "}
                  {formatAmount(b.totalInvoiceAmount, "USD") ?? "—"}
                </s-text>
              )}
              <BatchRunStatusBadge status={b.status} />
            </s-stack>
          </s-stack>
        </s-box>
      </s-clickable>

      {open && (
        <s-box padding="base" paddingBlockStart="none">
          <s-stack direction="block" gap="base">
            <s-grid gap="base" gridTemplateColumns="repeat(auto-fill, minmax(140px, 1fr))">
              <BatchStat label="Practitioners" value={b.totalPractitioners ?? 0} />
              <BatchStat label="Invoices" value={b.totalInvoicesProcessed ?? 0} />
              <BatchStat label="Invoice amount" value={formatAmount(b.totalInvoiceAmount, "USD") ?? "—"} />
              <BatchStat label="Duration" value={formatDuration(b.durationMs)} />
            </s-grid>

            {b.errorSummary && <s-text tone="critical">{b.errorSummary}</s-text>}

            {items.length > 0 ? (
              <>
                <s-text variant="headingSm">Order breakdown ({items.length})</s-text>
                <OrderBreakdownTable
                  items={items}
                  renderStatus={(it) => (
                    <s-stack direction="block" gap="none">
                      <ItemOutcomeBadge outcome={it.outcome} />
                      {it.detail && <s-text tone="subdued">{it.detail}</s-text>}
                    </s-stack>
                  )}
                />
              </>
            ) : (
              <s-text tone="subdued">No order-level detail recorded for this batch.</s-text>
            )}
          </s-stack>
        </s-box>
      )}
    </s-box>
  );
}

export default function OrdersCronBatch() {
  const { upcomingBatch, batchHistory, batchPage, batchFilters } = useLoaderData();
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  const historyTotal = batchHistory?.total ?? 0;
  const historyPageSize = batchHistory?.pageSize || BATCH_HISTORY_PAGE_SIZE;
  const historyTotalPages = Math.max(1, Math.ceil(historyTotal / historyPageSize));
  const hasHistoryFilter = HISTORY_FILTER_KEYS.some((k) => batchFilters?.[k]);

  // Pagination preserves whatever filters are currently active — only
  // `batchPage` changes. Filter changes (via AdvancedFilters) reset to
  // page 1 by omission (it doesn't carry batchPage as an extraParam).
  const goBatchPage = (p) => {
    const params = new URLSearchParams();
    for (const key of HISTORY_FILTER_KEYS) {
      if (batchFilters?.[key]) params.set(key, batchFilters[key]);
    }
    params.set("batchPage", String(p));
    navigate(`?${params.toString()}`);
  };

  return (
    <s-page inlineSize="large" heading="Orders">
      <OrdersTabBar active="cron-batch" />

      <s-section heading="Upcoming batch">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between" wrap>
            <s-text tone="subdued">
              The wholesale card/ACH auto-charge CRON (process-pending-payments).
            </s-text>
            <s-button
              variant="tertiary"
              icon="refresh"
              onClick={() => revalidator.revalidate()}
              {...(revalidator.state !== "idle" ? { loading: true } : {})}
            >
              Refresh
            </s-button>
          </s-stack>

          {!upcomingBatch ? (
            <s-banner tone="warning">
              Could not load the upcoming batch estimate right now.
            </s-banner>
          ) : (
            <s-grid gap="base" gridTemplateColumns="repeat(auto-fill, minmax(180px, 1fr))">
              <s-stack direction="block" gap="none">
                <s-text tone="subdued">Time remaining</s-text>
                <CountdownTimer targetIso={upcomingBatch.nextRunAt} />
              </s-stack>
              <BatchStat
                label="Next scheduled run"
                value={
                  upcomingBatch.nextRunAt
                    ? new Date(upcomingBatch.nextRunAt).toLocaleString()
                    : "—"
                }
              />
              <BatchStat label="Invoices to process" value={upcomingBatch.totalInvoices} />
              <BatchStat
                label="Total invoice amount"
                value={formatAmount(upcomingBatch.totalAmount, "USD") ?? "—"}
              />
              <BatchStat label="Practitioners included" value={upcomingBatch.totalPractitioners} />
              <s-stack direction="block" gap="none">
                <s-text tone="subdued">Batch status</s-text>
                <UpcomingStatusBadge status={upcomingBatch.status} />
              </s-stack>
            </s-grid>
          )}
          {upcomingBatch?.tick && TICK_LABEL[upcomingBatch.tick] && (
            <s-text tone="subdued">Schedule: {TICK_LABEL[upcomingBatch.tick]}</s-text>
          )}

          {upcomingBatch?.items?.length > 0 && (
            <CollapsibleSection
              heading={`Orders included in this estimate (${upcomingBatch.items.length})`}
              storageKey="orders-cron-batch-upcoming-items"
            >
              <s-stack direction="block" gap="base">
                <s-paragraph tone="subdued">
                  Live preview of what the next run would charge if it fired right now —
                  invoices can still be added, paid, or paused before then, so the actual
                  batch may differ slightly.
                </s-paragraph>
                <OrderBreakdownTable
                  items={upcomingBatch.items}
                  renderStatus={(it) => <PendingStatusCell item={it} />}
                />
              </s-stack>
            </CollapsibleSection>
          )}
        </s-stack>
      </s-section>

      <AdvancedFilters
        heading="Filter batch history"
        fields={HISTORY_FILTER_FIELDS}
        values={batchFilters}
        onRefresh={() => revalidator.revalidate()}
        refreshing={revalidator.state !== "idle"}
      />

      <s-section heading="Batch history">
        <s-stack direction="block" gap="base">
          {!batchHistory ? (
            <s-banner tone="warning">Could not load CRON batch history right now.</s-banner>
          ) : batchHistory.rows.length === 0 ? (
            <s-text tone="subdued">
              {hasHistoryFilter
                ? "No CRON batches match the current filters."
                : "No CRON batches recorded yet — history starts accumulating from the next run."}
            </s-text>
          ) : (
            <>
              <s-stack direction="block" gap="large">
                {batchHistory.rows.map((b, i) => (
                  <BatchHistoryCard key={b._id} batch={b} defaultOpen={batchPage === 1 && i === 0} />
                ))}
              </s-stack>

              {historyTotalPages > 1 && (
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-button
                    variant="tertiary"
                    disabled={batchPage <= 1}
                    onClick={() => goBatchPage(batchPage - 1)}
                    icon="arrow-left"
                  >
                    Previous
                  </s-button>
                  <s-text tone="subdued">
                    Page {batchPage} of {historyTotalPages}
                  </s-text>
                  <s-button
                    variant="tertiary"
                    disabled={batchPage >= historyTotalPages}
                    onClick={() => goBatchPage(batchPage + 1)}
                  >
                    Next
                  </s-button>
                </s-stack>
              )}
            </>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}
