import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getDashboardMetrics } from "../services/cdo/cdo.service";
import MetricCard from "../components/cdo/MetricCard";
import { formatCurrency, formatNumber, formatPercent } from "../utils/format";

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

export default function CdoReports() {
  const { metrics } = useLoaderData();
  const { kpis, monthlyPerformance, topPractitioners } = metrics;

  return (
    <s-stack direction="block" gap="base">
      <s-section heading="Program Summary">
        <s-paragraph tone="subdued">
          Aggregated CDO Program performance. Export and date-range filtering
          will be added as the attribution pipeline lands.
        </s-paragraph>
        <s-grid
          gap="base"
          gridTemplateColumns="repeat(auto-fill, minmax(220px, 1fr))"
        >
          <MetricCard
            label="Lifetime Revenue"
            value={formatCurrency(kpis.totalRevenue)}
          />
          <MetricCard
            label="Lifetime Commissions"
            value={formatCurrency(kpis.totalCommissions)}
          />
          <MetricCard
            label="Total Paid Out"
            value={formatCurrency(kpis.paidPayoutTotal)}
          />
          <MetricCard
            label="Outstanding Payouts"
            value={formatCurrency(kpis.pendingPayoutTotal)}
          />
          <MetricCard
            label="Referral Conversion"
            value={formatPercent(kpis.conversionRate)}
          />
        </s-grid>
      </s-section>

      <s-section heading="Revenue by Month">
        {monthlyPerformance.length === 0 ? (
          <s-paragraph tone="subdued">No data for this report yet.</s-paragraph>
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

      <s-section heading="Practitioner Leaderboard">
        {topPractitioners.length === 0 ? (
          <s-paragraph tone="subdued">No data for this report yet.</s-paragraph>
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
    </s-stack>
  );
}
