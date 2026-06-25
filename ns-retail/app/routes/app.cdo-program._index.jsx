import { useEffect, useState } from "react";
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
  formatDateTime,
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
  // null = not yet hydrated (avoids SSR / client mismatch)
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

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CdoDashboard() {
  const { metrics } = useLoaderData();
  const { kpis, upcoming, monthlyPerformance, topPractitioners, recentOrders } = metrics;

  return (
    <s-stack direction="block" gap="base">
      <s-section heading="Commission overview">
        <s-grid gap="base" gridTemplateColumns="repeat(3, minmax(0, 1fr))">
          <MetricCard
            label="Total Earned"
            value={formatCurrency(kpis.totalCommissionEarned)}
            sublabel="Lifetime, excl. reversed"
          />
          <MetricCard
            label="Total Paid"
            value={formatCurrency(kpis.totalCommissionPaid)}
            tone="success"
          />
          <MetricCard
            label="Outstanding"
            value={formatCurrency(kpis.outstandingLiability)}
            tone={kpis.outstandingLiability > 0 ? "critical" : undefined}
            sublabel={
              kpis.failedPayoutCount > 0
                ? `${formatNumber(kpis.failedPayoutCount)} failed payout(s)`
                : "Earned, not yet paid"
            }
          />
        </s-grid>
      </s-section>

      <s-section heading="Program overview">
        <s-grid gap="base" gridTemplateColumns="repeat(3, minmax(0, 1fr))">
          <MetricCard
            label="Total Revenue"
            value={formatCurrency(kpis.totalRevenue)}
            sublabel={`${formatNumber(kpis.totalOrders)} attributed orders`}
          />
          <MetricCard
            label="Active Practitioners"
            value={formatNumber(kpis.activePractitioners)}
          />
          <MetricCard
            label="Total Referrals"
            value={formatNumber(kpis.totalReferrals)}
            sublabel={`${formatNumber(kpis.convertedReferrals)} converted · ${formatPercent(kpis.conversionRate)} rate`}
          />
        </s-grid>
      </s-section>

      {/* ── Upcoming payout ───────────────────────────────────────────── */}
      <s-section heading="Upcoming payout (next cycle)">
        <s-stack direction="block" gap="base">

          {/* Countdown banner */}
          <s-box
            padding="base"
            background="bg-surface-secondary"
            border-radius="base"
          >
            <s-stack direction="block" gap="small-200">
              <s-text variant="headingSm">Time until next payout run</s-text>
              <PayoutCountdown payoutRunAt={upcoming.payoutRunAt} />
            </s-stack>
          </s-box>

          {/* Summary cards */}
          <s-grid gap="base" gridTemplateColumns="repeat(3, minmax(0, 1fr))">
            <MetricCard
              label="Scheduled total"
              value={formatCurrency(upcoming.totalAmount)}
              tone={upcoming.totalAmount > 0 ? "success" : undefined}
              sublabel={`${formatNumber(upcoming.practitionerCount)} practitioner(s) · ${formatNumber(upcoming.commissionCount)} commission(s)`}
            />
            <MetricCard
              label="Payout date"
              value={formatDate(upcoming.estimatedDate)}
              sublabel={new Date(upcoming.payoutRunAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                timeZoneName: "short",
              })}
            />
            <MetricCard
              label="Min payout threshold"
              value={formatCurrency(upcoming.minimumPayoutAmount)}
              sublabel={
                upcoming.belowMinimumCount > 0
                  ? `${formatNumber(upcoming.belowMinimumCount)} practitioner(s) below minimum`
                  : "All practitioners qualify"
              }
            />
          </s-grid>

          {/* Breakdown table */}
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
