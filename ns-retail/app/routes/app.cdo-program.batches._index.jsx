/* eslint-disable react/prop-types */
import { useState } from "react";
import { useNavigate, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  listPayoutBatches,
  getUpcomingPayoutBatchDetails,
} from "../services/cdo/cdo.service";
import DataTable from "../components/cdo/DataTable";
import MetricCard from "../components/cdo/MetricCard";
import StatusBadge from "../components/cdo/StatusBadge";
import PayoutCountdown from "../components/cdo/PayoutCountdown";
import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatNumber,
  formatPercent,
} from "../utils/format";

// Payout Batches — one row per automated CRON run (or manual reprocess) of
// process-commission-payouts. Each row links to a detail page snapshotting
// the commissions that run processed + their per-commission outcome.
// The upcoming-payout summary (countdown + practitioner breakdown) is shown
// above the batch list so admins have full context in one place.

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const [rows, upcoming] = await Promise.all([
    listPayoutBatches({ limit: 200 }),
    getUpcomingPayoutBatchDetails(),
  ]);
  return { rows, upcoming };
};

// ── Practitioner card with expandable order breakdown ─────────────────────────

function PractitionerCard({ practitioner }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <s-box
      padding="base"
      background="bg-surface"
      border-color="border"
      border-width="base"
      border-radius="base"
    >
      <s-stack direction="block" gap="small-200">
        {/* Summary row */}
        <s-stack direction="inline" gap="base" wrap alignItems="center">
          <s-box flex="1">
            <s-text variant="headingSm">{practitioner.practitionerName}</s-text>
          </s-box>
          <s-stack direction="inline" gap="large" wrap>
            <s-stack direction="block" gap="none">
              <s-text tone="subdued">Orders</s-text>
              <s-text>{formatNumber(practitioner.orders.length)}</s-text>
            </s-stack>
            <s-stack direction="block" gap="none">
              <s-text tone="subdued">Total Sales</s-text>
              <s-text>{formatCurrency(practitioner.salesTotal)}</s-text>
            </s-stack>
            <s-stack direction="block" gap="none">
              <s-text tone="subdued">Commissions</s-text>
              <s-text>{formatNumber(practitioner.commissionCount)}</s-text>
            </s-stack>
            <s-stack direction="block" gap="none">
              <s-text tone="subdued">Net Payout</s-text>
              <s-text variant="headingSm">{formatCurrency(practitioner.amount)}</s-text>
            </s-stack>
          </s-stack>
          <s-button
            variant="tertiary"
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded ? "Hide Orders" : "View Orders"}
          </s-button>
        </s-stack>

        {/* Expanded order breakdown */}
        {expanded && (
          <s-box padding-block-start="small-200">
            {practitioner.orders.length === 0 ? (
              <s-text tone="subdued">No linked orders found.</s-text>
            ) : (
              <s-table>
                <s-table-header-row>
                  <s-table-header>Order</s-table-header>
                  <s-table-header>Customer</s-table-header>
                  <s-table-header>Date</s-table-header>
                  <s-table-header>Order Total</s-table-header>
                  <s-table-header>Referral Code</s-table-header>
                  <s-table-header>Rate</s-table-header>
                  <s-table-header>Commission</s-table-header>
                  <s-table-header>Status</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {practitioner.orders.map((o) => (
                    <s-table-row key={o.commissionId}>
                      <s-table-cell>{o.orderName}</s-table-cell>
                      <s-table-cell>{o.customerName}</s-table-cell>
                      <s-table-cell>{formatDate(o.orderDate)}</s-table-cell>
                      <s-table-cell>{formatCurrency(o.orderTotal, o.currency)}</s-table-cell>
                      <s-table-cell>{o.referralCode}</s-table-cell>
                      <s-table-cell>{formatPercent(o.commissionRate)}</s-table-cell>
                      <s-table-cell>{formatCurrency(o.commissionAmount, o.currency)}</s-table-cell>
                      <s-table-cell>
                        <StatusBadge status={o.orderStatus} />
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
          </s-box>
        )}
      </s-stack>
    </s-box>
  );
}

// ── Upcoming Payout section (sits above the batch list) ───────────────────────

function UpcomingPayoutSummary({ upcoming }) {
  return (
    <div style={{ border: "1px solid #e1e3e5", borderRadius: "8px", overflow: "hidden" }}>

      {/* Header bar */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 20px",
        background: "#f6f6f7",
        borderBottom: "1px solid #e1e3e5",
      }}>
        <span style={{ fontWeight: 600, fontSize: "14px", color: "#303030" }}>
          Upcoming Payout
        </span>
        <span style={{ fontSize: "13px", color: "#6d7175" }}>
          {formatDate(upcoming.estimatedDate)} ·{" "}
          {new Date(upcoming.payoutRunAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            timeZoneName: "short",
          })}
        </span>
      </div>

      <div style={{ padding: "20px", background: "#fff" }}>
        <s-stack direction="block" gap="base">

          {/* Countdown + summary cards side by side */}
          <s-stack direction="inline" gap="base" wrap alignItems="flex-start">
            {/* Countdown */}
            <s-box
              padding="base"
              background="bg-surface-secondary"
              border-radius="base"
              min-inline-size="300px"
            >
              <s-stack direction="block" gap="small-200">
                <s-text tone="subdued">Time until next payout run</s-text>
                <PayoutCountdown payoutRunAt={upcoming.payoutRunAt} />
              </s-stack>
            </s-box>

            {/* KPI cards */}
            <s-box flex="1">
              <s-stack direction="inline" gap="base" wrap>
                <MetricCard
                  label="Scheduled Total"
                  value={formatCurrency(upcoming.totalAmount)}
                  tone={upcoming.totalAmount > 0 ? "success" : undefined}
                  sublabel={
                    upcoming.deferredByCeilingCount > 0
                      ? `Capped at ${formatCurrency(upcoming.maxTransferAmount)} transfer ceiling`
                      : `${formatNumber(upcoming.practitionerCount)} practitioner(s) · ${formatNumber(upcoming.commissionCount)} commission(s)`
                  }
                />
                <MetricCard
                  label="Total Sales Value"
                  value={formatCurrency(upcoming.totalSalesValue)}
                  sublabel={`${formatNumber(upcoming.totalOrderCount)} attributed order(s)`}
                />
                <MetricCard
                  label="Min Threshold"
                  value={formatCurrency(upcoming.minimumPayoutAmount)}
                  sublabel={
                    upcoming.belowMinimumCount > 0
                      ? `${formatNumber(upcoming.belowMinimumCount)} below minimum`
                      : "All practitioners qualify"
                  }
                />
              </s-stack>
            </s-box>
          </s-stack>

          {/* Batch transfer ceiling notice */}
          {upcoming.deferredByCeilingCount > 0 && (
            <s-box padding="base" background="bg-surface-secondary" border-radius="base">
              <s-text tone="subdued">
                This run is capped at the {formatCurrency(upcoming.maxTransferAmount)} transfer
                ceiling (CDO_PAYOUT_MAX_TRANSFER_AMOUNT). {formatNumber(upcoming.deferredByCeilingCount)}{" "}
                commission(s) totalling {formatCurrency(upcoming.deferredByCeilingTotal)} exceed the
                ceiling and will carry forward automatically to the next payout run.
              </s-text>
            </s-box>
          )}

          {/* Divider */}
          <div style={{ borderTop: "1px solid #e1e3e5" }} />

          {/* Practitioner breakdown heading */}
          <s-stack direction="inline" gap="none" alignItems="center" justifyContent="space-between">
            <s-text variant="headingSm">Practitioner Breakdown</s-text>
            {upcoming.belowMinimumCount > 0 && (
              <s-text tone="subdued">
                {formatNumber(upcoming.belowMinimumCount)} practitioner(s) below the{" "}
                {formatCurrency(upcoming.minimumPayoutAmount)} minimum — carrying forward
              </s-text>
            )}
          </s-stack>

          {/* Practitioner cards */}
          {upcoming.breakdown.length === 0 ? (
            <s-box padding="base" background="bg-surface-secondary" border-radius="base">
              <s-text tone="subdued">
                No practitioners qualify for this cycle yet. Commissions accrue until each
                practitioner reaches the minimum threshold of{" "}
                {formatCurrency(upcoming.minimumPayoutAmount)}.
              </s-text>
            </s-box>
          ) : (
            <s-stack direction="block" gap="small-200">
              {upcoming.breakdown.map((p) => (
                <PractitionerCard key={p.practitionerId} practitioner={p} />
              ))}
            </s-stack>
          )}

        </s-stack>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CdoPayoutBatches() {
  const { rows, upcoming } = useLoaderData();
  const navigate = useNavigate();

  const columns = [
    { key: "reference", header: "Batch" },
    {
      key: "mode",
      header: "Trigger",
      render: (r) => (r.mode === "manual_reprocess" ? "Reprocess" : "CRON"),
    },
    {
      key: "executionTime",
      header: "Executed",
      render: (r) => formatDate(r.executionTime),
    },
    { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "totalCommissions", header: "Commissions", render: (r) => r.totalCommissions },
    {
      key: "totalAmount",
      header: "Amount",
      render: (r) => formatCurrency(r.totalAmount, "USD"),
    },
    {
      // Processing = batched into a payout but not yet settled (awaiting admin
      // approval or bank settlement). Surfaced so the breakdown reconciles with
      // the Commissions count instead of showing 0 / 0 / 0 for in-flight runs.
      key: "counts",
      header: "Paid / Failed / Skipped / Processing",
      render: (r) => (
        <s-stack direction="inline" gap="small-200">
          <s-badge tone="success">{r.successCount}</s-badge>
          <s-badge tone={r.failedCount ? "critical" : "neutral"}>{r.failedCount}</s-badge>
          <s-badge tone="neutral">{r.skippedCount}</s-badge>
          <s-badge tone={r.processingCount ? "info" : "neutral"}>{r.processingCount}</s-badge>
        </s-stack>
      ),
    },
    {
      key: "open",
      header: "",
      render: (r) => (
        <s-button
          variant="tertiary"
          onClick={() => navigate(`/app/cdo-program/batches/${r.id}`)}
        >
          View
        </s-button>
      ),
    },
  ];

  return (
    <s-stack direction="block" gap="base">
      <UpcomingPayoutSummary upcoming={upcoming} />
      <DataTable
        columns={columns}
        rows={rows}
        searchKeys={["reference", "status", "mode"]}
        searchPlaceholder="Search by batch reference or status"
        description="Every automated commission-payout run is recorded as a batch. Open a batch to see the commissions it processed, their payout status, attempts, and failure reasons."
        emptyHeading="No payout batches yet"
        emptyBody="The process-commission-payouts CRON records a batch each time it runs."
      />
    </s-stack>
  );
}
