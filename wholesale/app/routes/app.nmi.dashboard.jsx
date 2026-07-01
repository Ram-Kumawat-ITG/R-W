import { useLoaderData, useNavigate, useRevalidator, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import { getNmiDashboardSnapshot } from "../services/nmi/nmi.service";
// Pure helpers come from nmi.utils.js (NOT nmi.service.js) to keep
// nmi.config.js — which calls process.env at module init — out of the
// client bundle. See nmi.utils.js for the split rationale.
import { latestAction, fromNmiDate } from "../services/nmi/nmi.utils";
import { formatAmount } from "../utils/format.utils";

// Allowed period windows. NMI's query.php pulls everything in the
// range in one shot — keeping the window bounded protects the page
// from runaway responses.
const PERIOD_OPTIONS = [
  { id: "7", label: "Last 7 days", days: 7 },
  { id: "30", label: "Last 30 days", days: 30 },
  { id: "90", label: "Last 90 days", days: 90 },
];

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const periodId = url.searchParams.get("period") || "30";
  const periodDays =
    PERIOD_OPTIONS.find((p) => p.id === periodId)?.days || 30;

  try {
    const snapshot = await getNmiDashboardSnapshot({ periodDays });
    return { snapshot, periodId, fatalError: null };
  } catch (e) {
    console.error("[nmi/dashboard] loader failed:", e?.message || e);
    return {
      snapshot: null,
      periodId,
      fatalError: e?.message || "Failed to load NMI dashboard",
    };
  }
};

export default function NmiDashboard() {
  const { snapshot, periodId, fatalError } = useLoaderData();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();

  if (fatalError) {
    return (
      <s-banner tone="critical" heading="NMI dashboard unavailable">
        <s-paragraph>{fatalError}</s-paragraph>
        <s-button
          variant="primary"
          onClick={() => revalidator.revalidate()}
          {...(revalidator.state !== "idle" ? { loading: true } : {})}
        >
          Retry
        </s-button>
      </s-banner>
    );
  }

  const { counts, totals, recentTransactions, errors, asOf, periodStart, periodEnd } =
    snapshot;
  const refreshing = revalidator.state !== "idle";
  const fmtCount = (n) => (n == null ? "—" : new Intl.NumberFormat().format(n));

  const onPeriod = (id) => {
    const merged = new URLSearchParams(searchParams);
    if (id === "30") merged.delete("period");
    else merged.set("period", id);
    setSearchParams(merged);
  };

  return (
    <>
      <s-section
        heading={`Snapshot · ${PERIOD_OPTIONS.find((p) => p.id === periodId)?.label || "Last 30 days"}`}
      >
        <s-stack direction="block" gap="base">
          <s-stack
            direction="inline"
            gap="base"
            alignItems="center"
            justifyContent="space-between"
            wrap
          >
            <s-text tone="subdued">
              {periodStart && periodEnd
                ? `${new Date(periodStart).toLocaleDateString()} – ${new Date(periodEnd).toLocaleDateString()}`
                : null}
              {" · Pulled "}
              {asOf ? new Date(asOf).toLocaleString() : "—"}
            </s-text>
            <s-stack direction="inline" gap="small-200" alignItems="center">
              {PERIOD_OPTIONS.map((p) => (
                <s-clickable-chip
                  key={p.id}
                  color={periodId === p.id ? "strong" : "base"}
                  accessibilityLabel={`Period: ${p.label}`}
                  onClick={() => onPeriod(p.id)}
                >
                  {p.label}
                </s-clickable-chip>
              ))}
              <s-button
                variant="tertiary"
                icon="refresh"
                onClick={() => revalidator.revalidate()}
                {...(refreshing ? { loading: true } : {})}
              >
                Refresh
              </s-button>
            </s-stack>
          </s-stack>

          {errors?.length > 0 && (
            <s-banner tone="warning" heading="Some metrics could not be loaded">
              <s-paragraph>
                One or more NMI queries returned an error. Other metrics on
                this page are unaffected.
              </s-paragraph>
              <s-unordered-list>
                {errors.map((e, i) => (
                  <s-list-item key={i}>
                    <strong>{e.label}:</strong> {e.message}
                  </s-list-item>
                ))}
              </s-unordered-list>
            </s-banner>
          )}

          <s-grid gridTemplateColumns="1fr 1fr 1fr 1fr" gap="base">
            <MetricCard
              label="Total customers"
              value={fmtCount(counts.customers)}
              subtitle="Customer Vault entries"
              onClick={() => navigate("/app/nmi/customers")}
            />
            <MetricCard
              label="Total transactions"
              value={fmtCount(counts.transactions)}
              subtitle={`In selected period`}
              onClick={() => navigate("/app/nmi/transactions")}
            />
            <MetricCard
              label="Successful payments"
              value={fmtCount(counts.successful)}
              subtitle="Approved"
              tone="success"
              onClick={() => navigate("/app/nmi/payments")}
            />
            <MetricCard
              label="Failed payments"
              value={fmtCount(counts.failed)}
              subtitle="Declined / errored"
              tone={
                counts.failed != null && counts.failed > 0
                  ? "critical"
                  : "default"
              }
              onClick={() => navigate("/app/nmi/failed")}
            />
          </s-grid>

          <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
            <MetricCard
              label="Credit card payments"
              value={fmtCount(counts.creditCard)}
              subtitle="Credit card transactions"
              onClick={() => navigate("/app/nmi/payments?method=cc")}
            />
            <MetricCard
              label="ACH payments"
              value={fmtCount(counts.ach)}
              subtitle="ACH / eCheck transactions"
              onClick={() => navigate("/app/nmi/payments?method=ck")}
            />
            <MetricCard
              label="Payments collected"
              value={
                totals.paymentsAmount != null
                  ? formatAmount(totals.paymentsAmount, totals.currency)
                  : "—"
              }
              subtitle="Approved sale + capture only"
              tone="success"
            />
          </s-grid>

          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            <MetricCard
              label="Refunds"
              value={fmtCount(counts.refunds)}
              subtitle={
                totals.refundsAmount != null
                  ? `${formatAmount(totals.refundsAmount, totals.currency)} total`
                  : "Pulled live from NMI"
              }
              onClick={() => navigate("/app/nmi/refunds")}
            />
            <MetricCard
              label="Period transactions / day"
              value={
                counts.transactions != null
                  ? (
                      counts.transactions /
                      (PERIOD_OPTIONS.find((p) => p.id === periodId)?.days || 30)
                    ).toFixed(1)
                  : "—"
              }
              subtitle="Averaged across the window"
            />
          </s-grid>
        </s-stack>
      </s-section>

      <s-section heading={`Recent transactions (${recentTransactions?.length || 0})`}>
        {!recentTransactions || recentTransactions.length === 0 ? (
          <s-paragraph tone="subdued">
            No transactions returned by NMI for this window.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Transaction</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Type</s-table-header>
              <s-table-header>Method</s-table-header>
              <s-table-header>Amount</s-table-header>
              <s-table-header>Outcome</s-table-header>
              <s-table-header>When</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {recentTransactions.map((tx) => {
                const last = latestAction(tx) || {};
                const name = [tx.first_name, tx.last_name]
                  .filter(Boolean)
                  .join(" ");
                const txType = tx.transaction_type === "ck" ? "ACH" : "Card";
                const action = last.action_type || "—";
                const success = last.success === "1";
                const amount = Number(last.amount || 0);
                const when = fromNmiDate(last.date);
                return (
                  <s-table-row
                    key={tx.transaction_id}
                    onClick={() => navigate("/app/nmi/transactions")}
                  >
                    <s-table-cell>#{tx.transaction_id}</s-table-cell>
                    <s-table-cell>
                      <s-stack direction="block" gap="none">
                        <s-text>{name || "—"}</s-text>
                        {tx.email && (
                          <s-text tone="subdued">{tx.email}</s-text>
                        )}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{action}</s-table-cell>
                    <s-table-cell>{txType}</s-table-cell>
                    <s-table-cell>
                      {formatAmount(amount, tx.currency || "USD")}
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone={success ? "success" : "critical"}>
                        {success ? "Approved" : "Failed"}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      {when ? when.toLocaleString() : "—"}
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </>
  );
}

// eslint-disable-next-line react/prop-types
function MetricCard({ label, value, subtitle, tone, onClick }) {
  const toneTextProp = tone ? { tone } : {};
  const body = (
    <s-box
      padding="base"
      border="base"
      borderRadius="base"
      background={onClick ? "default" : "subdued"}
    >
      <s-stack direction="block" gap="tight">
        <s-text tone="subdued">{label}</s-text>
        <s-heading {...toneTextProp}>{value}</s-heading>
        {subtitle && <s-text tone="subdued">{subtitle}</s-text>}
      </s-stack>
    </s-box>
  );
  if (!onClick) return body;
  return <s-clickable onClick={onClick}>{body}</s-clickable>;
}
