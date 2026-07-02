import { useLoaderData, useNavigate, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getDashboardSnapshot,
  getInvoiceWebUrl,
} from "../services/qbo/qbo.service";
import { derivePaymentMethod, linkedInvoiceIds } from "../services/qbo/qbo.utils";
import { formatAmount, fmtDueDate, initialsOf } from "../utils/format.utils";

// Pre-project the raw QBO Payment entities the loader gets back into the
// exact shape the table renders, resolving payment method + invoice deep
// links here (server-side) rather than in the component — importing
// qbo.service into render code drags its config/env chain into the
// client bundle (see the "client render must never import from
// svc.service.js" project rule).
function projectRecentPayment(p) {
  return {
    id: p.Id,
    customerName: p.CustomerRef?.name || null,
    totalAmount: p.TotalAmt != null ? Number(p.TotalAmt) : null,
    currency: p.CurrencyRef?.value || "USD",
    paymentMethod: derivePaymentMethod(p.PaymentMethodRef?.name, p.PaymentRefNum),
    paymentRef: p.PaymentRefNum || null,
    txnDate: p.TxnDate || null,
    linkedInvoices: linkedInvoiceIds(p).map((id) => ({
      id,
      url: getInvoiceWebUrl(id),
    })),
  };
}

// QBO Dashboard tab — analytics overview pulled live from the QBO API.
//
// All metrics are fetched in parallel inside `getDashboardSnapshot`
// (see services/qbo/qbo.service.js). Per-metric failures degrade to
// `null` rather than failing the whole loader so a single permission
// error on one entity doesn't take down the entire page.
//
// The loader is the entire data-fetch path — no client-side fetching
// — so React Router's standard revalidation (and the manual "Refresh"
// button below) is all the user needs to get fresh numbers.
export const loader = async ({ request }) => {
  await authenticate.admin(request);
  try {
    const snapshot = await getDashboardSnapshot();
    return {
      snapshot: {
        ...snapshot,
        recentPayments: (snapshot.recentPayments || []).map(projectRecentPayment),
      },
      fatalError: null,
    };
  } catch (e) {
    // A fatal error here means the underlying QBO client couldn't
    // refresh the token at all — none of the partial-failure handling
    // inside getDashboardSnapshot fired. Surface it as a top-level
    // banner so the operator can act (re-auth, check env).
    console.error("[qbo/dashboard] loader failed:", e?.message || e);
    return {
      snapshot: null,
      fatalError: e?.message || "Failed to load QBO dashboard",
    };
  }
};

export default function QboDashboard() {
  const { snapshot, fatalError } = useLoaderData();
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  if (fatalError) {
    return (
      <s-banner tone="critical" heading="QBO dashboard unavailable">
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

  const { counts, revenue, recentPayments, recentInvoices, errors, asOf } = snapshot;
  const refreshing = revalidator.state !== "idle";

  // Friendly null → "—" so missing metrics render visibly without
  // forcing the operator to interpret an empty cell.
  const fmtCount = (n) => (n == null ? "—" : new Intl.NumberFormat().format(n));

  return (
    <>
      <s-section
        heading={`Snapshot · ${revenue?.periodLabel || "Current period"}`}
      >
        <s-stack direction="block" gap="base">
          <s-stack
            direction="inline"
            gap="base"
            alignItems="center"
            justifyContent="space-between"
          >
            <s-text tone="subdued">
              Pulled live from QuickBooks at{" "}
              {asOf ? new Date(asOf).toLocaleString() : "—"}
            </s-text>
            <s-button
              variant="tertiary"
              icon="refresh"
              onClick={() => revalidator.revalidate()}
              {...(refreshing ? { loading: true } : {})}
            >
              Refresh
            </s-button>
          </s-stack>

          {/* Partial-failure surface — one metric failing should not
              block the rest. The dashboard helper collects per-metric
              errors and exposes them here as a warning banner. */}
          {errors?.length > 0 && (
            <s-banner tone="warning" heading="Some metrics could not be loaded">
              <s-paragraph>
                The following QBO calls returned an error. Other metrics on
                this page are unaffected and reflect the latest successful
                response.
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
              subtitle={
                counts.activeCustomers != null
                  ? `${fmtCount(counts.activeCustomers)} active`
                  : null
              }
              onClick={() => navigate("/app/qbo/customers")}
            />
            <MetricCard
              label="Total invoices"
              value={fmtCount(counts.invoices)}
              subtitle="All time"
              onClick={() => navigate("/app/qbo/invoices")}
            />
            <MetricCard
              label="Paid invoices"
              value={fmtCount(counts.paidInvoices)}
              subtitle="Balance settled"
              tone="success"
              onClick={() => navigate("/app/qbo/invoices?filter=paid")}
            />
            <MetricCard
              label="Pending invoices"
              value={fmtCount(counts.pendingInvoices)}
              subtitle={
                counts.overdueInvoices != null && counts.overdueInvoices > 0
                  ? `${fmtCount(counts.overdueInvoices)} overdue`
                  : "Awaiting payment"
              }
              tone={
                counts.overdueInvoices != null && counts.overdueInvoices > 0
                  ? "critical"
                  : "warning"
              }
              onClick={() => navigate("/app/qbo/invoices?filter=pending")}
            />
          </s-grid>

          <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
            <MetricCard
              label={`Billed (${revenue?.periodLabel || "this month"})`}
              value={
                revenue?.billed != null
                  ? formatAmount(revenue.billed, revenue.currency)
                  : "—"
              }
              subtitle={
                revenue?.sampledInvoiceCount != null
                  ? `${fmtCount(revenue.sampledInvoiceCount)} invoice${
                      revenue.sampledInvoiceCount === 1 ? "" : "s"
                    }${revenue.truncated ? " (sample capped)" : ""}`
                  : null
              }
            />
            <MetricCard
              label={`Collected (${revenue?.periodLabel || "this month"})`}
              value={
                revenue?.collected != null
                  ? formatAmount(revenue.collected, revenue.currency)
                  : "—"
              }
              subtitle={
                revenue?.billed != null && revenue.billed > 0
                  ? `${Math.round((revenue.collected / revenue.billed) * 100)}% of billed`
                  : null
              }
              tone="success"
            />
            <MetricCard
              label="Failed / overdue"
              value={fmtCount(counts.overdueInvoices)}
              subtitle="Past their due date"
              tone={
                counts.overdueInvoices != null && counts.overdueInvoices > 0
                  ? "critical"
                  : "default"
              }
              onClick={() => navigate("/app/qbo/invoices?filter=overdue")}
            />
          </s-grid>
        </s-stack>
      </s-section>

      <s-section heading={`Recent transactions (${recentPayments?.length || 0})`}>
        {!recentPayments || recentPayments.length === 0 ? (
          <s-paragraph tone="subdued">
            No payment activity returned by QuickBooks.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Payment</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Amount</s-table-header>
              <s-table-header>Method</s-table-header>
              <s-table-header>Reference</s-table-header>
              <s-table-header>Applied to invoice</s-table-header>
              <s-table-header>Date</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {recentPayments.map((p) => (
                <s-table-row
                  key={p.id}
                  onClick={() => navigate("/app/qbo/transactions")}
                >
                  <s-table-cell>#{p.id}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <s-avatar
                        size="small-200"
                        initials={initialsOf(p.customerName)}
                        alt={p.customerName || "Customer"}
                      />
                      <s-text>{p.customerName || "—"}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    {p.totalAmount != null
                      ? formatAmount(p.totalAmount, p.currency)
                      : "—"}
                  </s-table-cell>
                  <s-table-cell>
                    {p.paymentMethod ? (
                      <s-badge tone="neutral">{p.paymentMethod}</s-badge>
                    ) : (
                      <s-text tone="subdued">—</s-text>
                    )}
                  </s-table-cell>
                  <s-table-cell>{p.paymentRef || "—"}</s-table-cell>
                  <s-table-cell>
                    {p.linkedInvoices.length > 0 ? (
                      <s-stack direction="block" gap="none">
                        {p.linkedInvoices.map((inv) => (
                          <s-link
                            key={inv.id}
                            href={inv.url}
                            target="_blank"
                            onClick={(e) => e.stopPropagation()}
                          >
                            #{inv.id}
                          </s-link>
                        ))}
                      </s-stack>
                    ) : (
                      <s-text tone="subdued">—</s-text>
                    )}
                  </s-table-cell>
                  <s-table-cell>{fmtDueDate(p.txnDate) || "—"}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading={`Recent invoices (${recentInvoices?.length || 0})`}>
        {!recentInvoices || recentInvoices.length === 0 ? (
          <s-paragraph tone="subdued">
            No invoice activity returned by QuickBooks.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Invoice</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Invoice date</s-table-header>
              <s-table-header>Total</s-table-header>
              <s-table-header>Balance</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Sent</s-table-header>
              <s-table-header>Due date</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {recentInvoices.map((inv) => {
                const total = Number(inv.TotalAmt || 0);
                const balance = Number(inv.Balance || 0);
                const paid = Number((total - balance).toFixed(2));
                let status;
                if (total === 0) status = "Voided";
                else if (balance === 0) status = "Paid";
                else if (paid > 0) status = "Partial";
                else status = "Pending";
                const statusTone =
                  status === "Paid" ? "success"
                  : status === "Partial" ? "info"
                  : status === "Voided" ? "default"
                  : "warning";
                const sentTone =
                  inv.EmailStatus === "EmailSent" ? "success"
                  : inv.EmailStatus === "NeedToSend" ? "warning"
                  : "default";
                const sentLabel =
                  inv.EmailStatus === "EmailSent" ? "Sent"
                  : inv.EmailStatus === "NeedToSend" ? "Pending"
                  : "Not set";
                return (
                  <s-table-row
                    key={inv.Id}
                    onClick={() => navigate("/app/qbo/invoices")}
                  >
                    <s-table-cell>
                      {inv.DocNumber ? `#${inv.DocNumber}` : `#${inv.Id}`}
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small-200" alignItems="center">
                        <s-avatar
                          size="small-200"
                          initials={initialsOf(inv.CustomerRef?.name)}
                          alt={inv.CustomerRef?.name || "Customer"}
                        />
                        <s-text>{inv.CustomerRef?.name || "—"}</s-text>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{fmtDueDate(inv.TxnDate) || "—"}</s-table-cell>
                    <s-table-cell>
                      {total > 0
                        ? formatAmount(total, inv.CurrencyRef?.value || "USD")
                        : "—"}
                    </s-table-cell>
                    <s-table-cell>
                      {formatAmount(balance, inv.CurrencyRef?.value || "USD")}
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone={statusTone}>{status}</s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone={sentTone}>{sentLabel}</s-badge>
                    </s-table-cell>
                    <s-table-cell>{fmtDueDate(inv.DueDate) || "—"}</s-table-cell>
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

// Single tile in the dashboard's metric grid. Polaris doesn't ship a
// dedicated KPI/stat-card so we compose one out of `s-box` + typography.
// `onClick` is optional — tiles that point at a list view become
// clickable, the pure metrics (Billed / Collected) stay static.
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
  // s-clickable wraps a tile in a button-equivalent so it gets focus +
  // keyboard activation without us bolting on tabIndex / role.
  return <s-clickable onClick={onClick}>{body}</s-clickable>;
}
