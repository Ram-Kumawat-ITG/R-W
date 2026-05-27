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
  const { kpis, monthlyPerformance, topPractitioners, recentOrders } = metrics;

  return (
    <s-stack direction="block" gap="base">
      <s-section heading="Overview">
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
            label="Total Commissions"
            value={formatCurrency(kpis.totalCommissions)}
          />
          <MetricCard
            label="Pending Payouts"
            value={formatCurrency(kpis.pendingPayoutTotal)}
            tone="critical"
          />
          <MetricCard
            label="Paid Out"
            value={formatCurrency(kpis.paidPayoutTotal)}
            tone="success"
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
