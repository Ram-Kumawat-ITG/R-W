/* eslint-disable react/prop-types */
import { useEffect, useState } from "react";
import { useNavigate, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  listPayoutBatches,
  getUpcomingPayoutBatchDetails,
} from "../services/cdo/cdo.service";
import DataTable from "../components/cdo/DataTable";
import MetricCard from "../components/cdo/MetricCard";
import StatusBadge from "../components/cdo/StatusBadge";
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

// ── Countdown helpers ─────────────────────────────────────────────────────────

function calcTimeLeft(targetIso) {
  const diff = new Date(targetIso).getTime() - Date.now();
  if (diff <= 0) return null;
  return {
    days:    Math.floor(diff / 86_400_000),
    hours:   Math.floor((diff % 86_400_000) / 3_600_000),
    minutes: Math.floor((diff % 3_600_000)  / 60_000),
    seconds: Math.floor((diff % 60_000)     / 1_000),
  };
}

function CountdownUnit({ value, label }) {
  return (
    <s-box
      padding="base"
      border-color="border"
      border-width="base"
      border-radius="base"
      min-inline-size="80px"
    >
      <s-stack direction="block" gap="none" alignItems="center">
        <s-text variant="headingLg">
          {String(value).padStart(2, "0")}
        </s-text>
        <s-text tone="subdued">{label}</s-text>
      </s-stack>
    </s-box>
  );
}

function PayoutCountdown({ payoutRunAt }) {
  const [timeLeft, setTimeLeft] = useState(null);
  useEffect(() => {
    const tick = () => setTimeLeft(calcTimeLeft(payoutRunAt));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [payoutRunAt]);
  if (!timeLeft) return null;
  return (
    <s-stack direction="block" gap="small-200">
      <s-stack direction="inline" gap="small-200" wrap>
        <CountdownUnit value={timeLeft.days}    label="Days"    />
        <CountdownUnit value={timeLeft.hours}   label="Hours"   />
        <CountdownUnit value={timeLeft.minutes} label="Minutes" />
        <CountdownUnit value={timeLeft.seconds} label="Seconds" />
      </s-stack>
      <s-text tone="subdued">
        Next payout run: {formatDateTime(payoutRunAt)}
      </s-text>
    </s-stack>
  );
}

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
    <s-box padding="base" background="bg-surface-secondary" border-radius="base">
      <s-stack direction="block" gap="base">
        <s-text variant="headingSm">Upcoming Payout</s-text>

        {/* Live countdown */}
        <PayoutCountdown payoutRunAt={upcoming.payoutRunAt} />

        {/* Summary cards */}
        <s-stack direction="inline" gap="base" wrap>
          <MetricCard
            label="Scheduled Total"
            value={formatCurrency(upcoming.totalAmount)}
            tone={upcoming.totalAmount > 0 ? "success" : undefined}
            sublabel={`${formatNumber(upcoming.practitionerCount)} practitioner(s) · ${formatNumber(upcoming.commissionCount)} commission(s)`}
          />
          <MetricCard
            label="Total Sales Value"
            value={formatCurrency(upcoming.totalSalesValue)}
            sublabel={`${formatNumber(upcoming.totalOrderCount)} attributed order(s)`}
          />
          <MetricCard
            label="Payout Date"
            value={formatDate(upcoming.estimatedDate)}
            sublabel={new Date(upcoming.payoutRunAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              timeZoneName: "short",
            })}
          />
          <MetricCard
            label="Min Threshold"
            value={formatCurrency(upcoming.minimumPayoutAmount)}
            sublabel={
              upcoming.belowMinimumCount > 0
                ? `${formatNumber(upcoming.belowMinimumCount)} practitioner(s) below minimum`
                : "All practitioners qualify"
            }
          />
        </s-stack>

        {/* Practitioner breakdown */}
        {upcoming.breakdown.length === 0 ? (
          <s-box padding="small-200" background="bg-surface" border-radius="base">
            <s-text tone="subdued">
              No practitioners qualify for this cycle yet. Commissions accrue until
              each practitioner reaches the minimum threshold of{" "}
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

        {/* Below-minimum notice */}
        {upcoming.belowMinimumCount > 0 && (
          <s-box padding="small-200" background="bg-surface" border-radius="base">
            <s-text tone="subdued">
              {formatNumber(upcoming.belowMinimumCount)} practitioner(s) are accruing commissions
              below the {formatCurrency(upcoming.minimumPayoutAmount)} minimum — they will carry
              forward to the next cycle.
            </s-text>
          </s-box>
        )}
      </s-stack>
    </s-box>
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
