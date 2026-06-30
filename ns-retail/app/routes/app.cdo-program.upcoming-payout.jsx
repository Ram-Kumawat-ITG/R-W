/* eslint-disable react/prop-types */
import { useState } from "react";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getUpcomingPayoutBatchDetails } from "../services/cdo/cdo.service";
import MetricCard from "../components/cdo/MetricCard";
import StatusBadge from "../components/cdo/StatusBadge";
import PayoutCountdown from "../components/cdo/PayoutCountdown";
import {
  formatCurrency,
  formatNumber,
  formatPercent,
  formatDate,
  formatDateTime,
} from "../utils/format";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const details = await getUpcomingPayoutBatchDetails();
  return { details };
};

// ── Practitioner card with expandable order table ─────────────────────────────

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

// ── Page ──────────────────────────────────────────────────────────────────────

export default function UpcomingPayoutBatch() {
  const { details } = useLoaderData();

  return (
    <s-stack direction="block" gap="base">

      {/* Countdown */}
      <s-section heading="Next Payout Run">
        <s-box padding="base" background="bg-surface-secondary" border-radius="base">
          <s-stack direction="block" gap="small-200">
            <s-text variant="headingSm">Time until next payout run</s-text>
            <PayoutCountdown payoutRunAt={details.payoutRunAt} />
          </s-stack>
        </s-box>
      </s-section>

      {/* Summary analytics */}
      <s-section heading="Batch Summary">
        <s-stack direction="inline" gap="base" wrap>
          <MetricCard
            label="Total Practitioners"
            value={formatNumber(details.practitionerCount)}
            sublabel="Qualify for this payout"
          />
          <MetricCard
            label="Total Orders"
            value={formatNumber(details.totalOrderCount)}
            sublabel="Across all practitioners"
          />
          <MetricCard
            label="Total Sales Value"
            value={formatCurrency(details.totalSalesValue)}
            sublabel="Attributed order revenue"
          />
          <MetricCard
            label="Commission Liability"
            value={formatCurrency(details.totalAmount)}
            tone="critical"
            sublabel={`${formatNumber(details.commissionCount)} pending commission(s)`}
          />
          <MetricCard
            label="Payout Date"
            value={formatDate(details.estimatedDate)}
            sublabel={new Date(details.payoutRunAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              timeZoneName: "short",
            })}
          />
        </s-stack>
      </s-section>

      {/* Practitioner breakdown */}
      <s-section heading="Practitioner Breakdown">
        {details.breakdown.length === 0 ? (
          <s-box padding="base" background="bg-surface-secondary" border-radius="base">
            <s-text tone="subdued">
              No practitioners qualify for the upcoming payout yet. Commissions accrue until each
              practitioner&apos;s balance reaches the minimum threshold of{" "}
              {formatCurrency(details.minimumPayoutAmount)}.
            </s-text>
          </s-box>
        ) : (
          <s-stack direction="block" gap="small-200">
            {details.breakdown.map((p) => (
              <PractitionerCard key={p.practitionerId} practitioner={p} />
            ))}
          </s-stack>
        )}
      </s-section>

      {/* Below-minimum notice */}
      {details.belowMinimumCount > 0 && (
        <s-section heading="Below Minimum Threshold">
          <s-box padding="base" background="bg-surface-secondary" border-radius="base">
            <s-text tone="subdued">
              {formatNumber(details.belowMinimumCount)} practitioner(s) have earned commissions but
              have not yet reached the minimum payout threshold of{" "}
              {formatCurrency(details.minimumPayoutAmount)}. Their commissions will carry forward
              and be included in a future payout once the threshold is met.
            </s-text>
          </s-box>
        </s-section>
      )}

    </s-stack>
  );
}
