import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getDashboardMetrics } from "../services/cdo/cdo.service";
import MetricCard from "../components/cdo/MetricCard";
import StatusBadge from "../components/cdo/StatusBadge";
import {
  formatCurrency,
  formatNumber,
  formatPercent,
  formatDate,
} from "../utils/format";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const metrics = await getDashboardMetrics();
  return { metrics };
};

const MONTH_LABEL = (key) => {
  const [y, m] = key.split("-");
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
};

export default function CdoDashboard() {
  const { metrics } = useLoaderData();
  const { kpis, upcoming, monthlyPerformance, topPractitioners, recentOrders } = metrics;

  return (
    <s-stack direction="block" gap="base">
      <s-section heading="Commission overview">
        <s-grid
          gap="base"
          gridTemplateColumns="repeat(auto-fill, minmax(220px, 1fr))"
        >
          <MetricCard
            label="Total Commission Earned"
            value={formatCurrency(kpis.totalCommissionEarned)}
            sublabel="Excludes reversed"
          />
          <MetricCard
            label="Total Commission Paid"
            value={formatCurrency(kpis.totalCommissionPaid)}
            tone="success"
          />
          <MetricCard
            label="Outstanding Liability"
            value={formatCurrency(kpis.outstandingLiability)}
            tone="critical"
            sublabel="Earned, not yet paid"
          />
          <MetricCard
            label="Pending Payouts"
            value={formatCurrency(kpis.pendingPayoutTotal)}
            sublabel="Awaiting approval / in flight"
          />
          <MetricCard
            label="Paid Out"
            value={formatCurrency(kpis.paidPayoutTotal)}
            tone="success"
          />
          <MetricCard
            label="Failed Payouts"
            value={formatCurrency(kpis.failedPayoutTotal)}
            tone={kpis.failedPayoutCount ? "critical" : "neutral"}
            sublabel={`${formatNumber(kpis.failedPayoutCount)} payout(s)`}
          />
        </s-grid>
      </s-section>

      <s-section heading="Program overview">
        <s-grid
          gap="base"
          gridTemplateColumns="repeat(auto-fill, minmax(220px, 1fr))"
        >
          <MetricCard
            label="Total Revenue"
            value={formatCurrency(kpis.totalRevenue)}
            sublabel={`${formatNumber(kpis.totalOrders)} attributed orders`}
          />
          <MetricCard
            label="Avg Order Value"
            value={formatCurrency(kpis.avgOrderValue)}
          />
          <MetricCard
            label="Total Referrals"
            value={formatNumber(kpis.totalReferrals)}
            sublabel={`${formatNumber(kpis.convertedReferrals)} converted`}
          />
          <MetricCard
            label="Active Practitioners"
            value={formatNumber(kpis.activePractitioners)}
          />
          <MetricCard
            label="Conversion Rate"
            value={formatPercent(kpis.conversionRate)}
            sublabel="Referrals → orders"
          />
        </s-grid>
      </s-section>

      <s-section heading="Upcoming payout (next cycle)">
        <s-stack direction="block" gap="base">
          <s-grid gap="base" gridTemplateColumns="repeat(auto-fill, minmax(220px, 1fr))">
            <MetricCard
              label="Scheduled total"
              value={formatCurrency(upcoming.totalAmount)}
              tone="success"
            />
            <MetricCard
              label="Estimated payout date"
              value={formatDate(upcoming.estimatedDate)}
            />
            <MetricCard
              label="Practitioners"
              value={formatNumber(upcoming.practitionerCount)}
              sublabel={`${formatNumber(upcoming.commissionCount)} commissions`}
            />
            <MetricCard
              label="Min payout threshold"
              value={formatCurrency(upcoming.minimumPayoutAmount)}
              sublabel={`${formatNumber(upcoming.belowMinimumCount)} below minimum (rolls over)`}
            />
          </s-grid>
          {upcoming.breakdown.length === 0 ? (
            <s-paragraph tone="subdued">
              No practitioner clears the minimum payout this cycle yet. Commissions accrue until
              the threshold is met.
            </s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>Practitioner</s-table-header>
                <s-table-header>Commissions</s-table-header>
                <s-table-header>Amount</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {upcoming.breakdown.map((p) => (
                  <s-table-row key={p.practitionerId}>
                    <s-table-cell>{p.practitionerName}</s-table-cell>
                    <s-table-cell>{formatNumber(p.commissionCount)}</s-table-cell>
                    <s-table-cell>{formatCurrency(p.amount)}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Top Practitioners">
        {topPractitioners.length === 0 ? (
          <s-paragraph tone="subdued">
            No attributed orders yet. Top earners appear here once orders are
            linked to practitioners.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Practitioner</s-table-header>
              <s-table-header>Orders</s-table-header>
              <s-table-header>Revenue</s-table-header>
              <s-table-header>Commission</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {topPractitioners.map((p, i) => (
                <s-table-row key={`${p.practitionerName}-${i}`}>
                  <s-table-cell>{p.practitionerName}</s-table-cell>
                  <s-table-cell>{formatNumber(p.orders)}</s-table-cell>
                  <s-table-cell>{formatCurrency(p.revenue)}</s-table-cell>
                  <s-table-cell>{formatCurrency(p.commission)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Recent Orders">
        {recentOrders.length === 0 ? (
          <s-paragraph tone="subdued">
            No CDO orders recorded yet.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Order</s-table-header>
              <s-table-header>Practitioner</s-table-header>
              <s-table-header>Amount</s-table-header>
              <s-table-header>Commission</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Date</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {recentOrders.map((o) => (
                <s-table-row key={o.id}>
                  <s-table-cell>{o.orderName}</s-table-cell>
                  <s-table-cell>{o.practitionerName}</s-table-cell>
                  <s-table-cell>
                    {formatCurrency(o.amount, o.currency)}
                  </s-table-cell>
                  <s-table-cell>
                    {formatCurrency(o.commissionAmount, o.currency)}
                  </s-table-cell>
                  <s-table-cell>
                    <StatusBadge status={o.status} />
                  </s-table-cell>
                  <s-table-cell>{formatDate(o.placedAt)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Monthly Performance">
        {monthlyPerformance.length === 0 ? (
          <s-paragraph tone="subdued">
            Monthly revenue and order trends appear here as orders accrue.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Month</s-table-header>
              <s-table-header>Orders</s-table-header>
              <s-table-header>Revenue</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {monthlyPerformance.map((m) => (
                <s-table-row key={m.month}>
                  <s-table-cell>{MONTH_LABEL(m.month)}</s-table-cell>
                  <s-table-cell>{formatNumber(m.orders)}</s-table-cell>
                  <s-table-cell>{formatCurrency(m.revenue)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-stack>
  );
}
