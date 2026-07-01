import { useLoaderData, useNavigation, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getDashboardSnapshot,
  getBillCountSnapshot,
  countPayments,
} from "../services/retailQbo/retailQbo.service";
import {
  getDashboardMetrics,
  getPayoutMethodBreakdown,
  getSyncStatusSnapshot,
  listRecentPayouts,
} from "../services/cdo/cdo.service";
import { formatCurrency, formatDate } from "../utils/format";
import MetricCard from "../components/cdo/MetricCard";

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const safe = async (label, fn) => {
    try { return await fn(); }
    catch (e) {
      console.error(`[qbo/dashboard] ${label} failed:`, e?.message || e);
      return null;
    }
  };

  const [qboSnap, billSnap, paymentCount, cdoMetrics, payoutBreakdown, syncStatus, recentPayouts] =
    await Promise.all([
      safe("qbo", getDashboardSnapshot),
      safe("bills", getBillCountSnapshot),
      safe("paymentCount", countPayments),
      safe("cdo", getDashboardMetrics),
      safe("payoutBreakdown", getPayoutMethodBreakdown),
      safe("sync", getSyncStatusSnapshot),
      safe("recentPayouts", () => listRecentPayouts(5)),
    ]);

  return {
    qboSnap,
    billSnap,
    paymentCount: paymentCount ?? 0,
    cdoMetrics,
    payoutBreakdown,
    syncStatus,
    recentPayouts: recentPayouts ?? [],
    asOf: new Date().toISOString(),
  };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function invoiceStatus(inv) {
  const total = Number(inv.TotalAmt || 0);
  const balance = Number(inv.Balance || 0);
  const paid = Number((total - balance).toFixed(2));
  if (total === 0) return { label: "Voided", tone: "default" };
  if (balance === 0) return { label: "Paid", tone: "success" };
  if (paid > 0) return { label: "Partial", tone: "info" };
  return { label: "Pending", tone: "warning" };
}

function billStatus(b) {
  const total = Number(b.TotalAmt || 0);
  const balance = Number(b.Balance || 0);
  const paid = Number((total - balance).toFixed(2));
  if (total === 0) return { label: "Voided", tone: "default" };
  if (balance === 0) return { label: "Paid", tone: "success" };
  if (paid > 0) return { label: "Partial", tone: "info" };
  return { label: "Open", tone: "warning" };
}

function fmtDueDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return { label: dateStr, overdue: false };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return { label: d.toLocaleDateString(), overdue: d < today };
}

function fmtMethod(p) {
  return p.PaymentMethodRef?.name || p.PaymentType || "—";
}

function fmtDeposit(p) {
  const ref = p.DepositToAccountRef;
  if (!ref) return "—";
  return ref.name || ref.value || "—";
}

const RESPONSIVE_4 = "repeat(auto-fit, minmax(180px, 1fr))";
const RESPONSIVE_3 = "repeat(auto-fit, minmax(200px, 1fr))";
const RESPONSIVE_2 = "repeat(auto-fit, minmax(260px, 1fr))";

const PAYOUT_STATUS_TONE = {
  paid: "success", processing: "info", awaiting_settlement: "info",
  approved: "info", awaiting_approval: "warning", draft: "default",
  failed: "critical", rejected: "critical", cancelled: "default",
};
const PAYOUT_STATUS_LABEL = {
  paid: "Paid", processing: "Processing", awaiting_settlement: "Awaiting settlement",
  approved: "Approved", awaiting_approval: "Awaiting approval", draft: "Draft",
  failed: "Failed", rejected: "Rejected", cancelled: "Cancelled",
};

function SectionDivider({ label }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "14px", margin: "8px 0 0" }}>
      <div style={{ flex: 1, height: "1px", background: "#e1e3e5" }} />
      <span style={{
        fontSize: "10px",
        fontWeight: 700,
        color: "#8c9196",
        textTransform: "uppercase",
        letterSpacing: "0.10em",
        whiteSpace: "nowrap",
        padding: "0 4px",
      }}>
        {label}
      </span>
      <div style={{ flex: 1, height: "1px", background: "#e1e3e5" }} />
    </div>
  );
}

function ViewAllLink({ href, label = "View all" }) {
  return (
    <div style={{ textAlign: "right", marginTop: "4px" }}>
      <a
        href={href}
        style={{ fontSize: "13px", color: "#2c6ecb", textDecoration: "none", fontWeight: 500 }}
      >
        {label} →
      </a>
    </div>
  );
}

function SyncCard({ label, synced, errors, pending, lastSyncAt }) {
  const tone = errors > 0 ? "critical" : synced > 0 ? "success" : "warning";
  const statusLabel =
    errors > 0 ? `${errors} error${errors !== 1 ? "s" : ""}` :
    synced > 0 ? "Synced" : "No data";
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack direction="block" gap="tight">
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-text>{label}</s-text>
          <s-badge tone={tone}>{statusLabel}</s-badge>
        </s-stack>
        <s-stack direction="block" gap="none">
          <s-text tone="subdued">
            {synced.toLocaleString()} synced
            {pending > 0 ? ` · ${pending.toLocaleString()} pending` : ""}
            {errors > 0 ? ` · ${errors.toLocaleString()} failed` : ""}
          </s-text>
          {lastSyncAt && (
            <s-text tone="subdued">Last sync: {new Date(lastSyncAt).toLocaleString()}</s-text>
          )}
        </s-stack>
      </s-stack>
    </s-box>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export default function QboDashboard() {
  const { qboSnap, billSnap, paymentCount, cdoMetrics, payoutBreakdown, syncStatus, recentPayouts, asOf } =
    useLoaderData();

  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const refreshing = revalidator.state !== "idle";
  const loading = navigation.state === "loading" || refreshing;

  const kpis = cdoMetrics?.kpis || {};
  const upcoming = cdoMetrics?.upcoming || {};
  const topPractitioners = cdoMetrics?.topPractitioners || [];

  const qboErrors = qboSnap?.errors || [];
  const currency = qboSnap?.revenue?.currency || "USD";
  const billCurrency = billSnap?.currency || "USD";
  const outstandingBalance = (qboSnap?.revenue?.billed || 0) - (qboSnap?.revenue?.collected || 0);

  const totalSyncErrors =
    (syncStatus?.invoices?.errors || 0) +
    (syncStatus?.bills?.errors || 0) +
    (syncStatus?.payments?.errors || 0);

  const billAmountSublabel = billSnap
    ? billSnap.truncated
      ? `Sampled (last ${billSnap.billCount} bills)`
      : "All bills"
    : "";

  return (
    <s-stack direction="block" gap="base">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
        <s-text tone="subdued">
          As of {asOf ? new Date(asOf).toLocaleString() : "—"}
        </s-text>
        <s-button variant="tertiary" icon="refresh" loading={refreshing} onClick={() => revalidator.revalidate()}>
          Refresh
        </s-button>
      </s-stack>

      {/* ── Alerts ──────────────────────────────────────────────────────────── */}
      {qboErrors.length > 0 && (
        <s-banner tone="warning" heading="Some QBO metrics could not be loaded">
          <s-paragraph>Failed to fetch: {qboErrors.join(", ")}</s-paragraph>
        </s-banner>
      )}
      {totalSyncErrors > 0 && (
        <s-banner tone="critical" heading={`${totalSyncErrors} sync error${totalSyncErrors !== 1 ? "s" : ""} detected`}>
          <s-paragraph>Check the Sync &amp; System Status section below for details.</s-paragraph>
        </s-banner>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          1 · INVOICE ANALYTICS
      ══════════════════════════════════════════════════════════════════════ */}
      <SectionDivider label="Invoice Analytics" />
      <s-section heading="Invoice Analytics">
        {!qboSnap ? (
          <s-banner tone="critical" heading="Invoice data unavailable">
            <s-paragraph>Could not connect to QuickBooks Online.</s-paragraph>
          </s-banner>
        ) : (
          <s-stack direction="block" gap="base">
            {/* Count KPIs */}
            <s-grid gap="base" gridTemplateColumns={RESPONSIVE_4}>
              <MetricCard
                label="Total Invoices"
                value={(qboSnap.counts.invoices || 0).toLocaleString()}
                sublabel="All time"
                icon="🧾"
              />
              <MetricCard
                label="Open Invoices"
                value={(qboSnap.counts.pendingInvoices || 0).toLocaleString()}
                sublabel="Balance outstanding"
                tone={qboSnap.counts.pendingInvoices > 0 ? "warning" : undefined}
                icon="📋"
              />
              <MetricCard
                label="Paid Invoices"
                value={(qboSnap.counts.paidInvoices || 0).toLocaleString()}
                sublabel="Fully settled"
                tone="success"
                icon="✅"
              />
              <MetricCard
                label="Overdue Invoices"
                value={(qboSnap.counts.overdueInvoices || 0).toLocaleString()}
                tone={qboSnap.counts.overdueInvoices > 0 ? "critical" : undefined}
                sublabel="Past due date"
                icon="⚠️"
              />
            </s-grid>

            {/* Revenue KPIs */}
            <s-grid gap="base" gridTemplateColumns={RESPONSIVE_3}>
              <MetricCard
                label="Total Invoice Amount"
                value={formatCurrency(qboSnap.revenue.billed, currency)}
                sublabel={
                  qboSnap.revenue.truncated
                    ? `Sampled (${qboSnap.revenue.sampledInvoiceCount} invoices)`
                    : qboSnap.revenue.periodLabel
                }
                icon="💰"
              />
              <MetricCard
                label="Amount Collected"
                value={formatCurrency(qboSnap.revenue.collected, currency)}
                sublabel="Payments applied"
                tone="success"
                icon="💳"
              />
              <MetricCard
                label="Outstanding Balance"
                value={formatCurrency(outstandingBalance, currency)}
                tone={outstandingBalance > 0 ? "warning" : undefined}
                sublabel={`${(qboSnap.counts.pendingInvoices || 0).toLocaleString()} open invoice${qboSnap.counts.pendingInvoices !== 1 ? "s" : ""}`}
                icon="⏳"
              />
            </s-grid>

            {/* Recent Invoices table */}
            <s-table loading={loading}>
              <s-table-header-row>
                <s-table-header>Invoice #</s-table-header>
                <s-table-header>Customer</s-table-header>
                <s-table-header>Date</s-table-header>
                <s-table-header>Due Date</s-table-header>
                <s-table-header>Total</s-table-header>
                <s-table-header>Balance</s-table-header>
                <s-table-header>Status</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {(qboSnap.recentInvoices || []).length === 0 ? (
                  <s-table-row>
                    <s-table-cell colSpan="7">
                      <s-text tone="subdued">No recent invoices</s-text>
                    </s-table-cell>
                  </s-table-row>
                ) : (
                  (qboSnap.recentInvoices || []).map((inv) => {
                    const st = invoiceStatus(inv);
                    const due = fmtDueDate(inv.DueDate);
                    return (
                      <s-table-row key={inv.Id}>
                        <s-table-cell>{inv.DocNumber || inv.Id}</s-table-cell>
                        <s-table-cell>{inv.CustomerRef?.name || "—"}</s-table-cell>
                        <s-table-cell>{formatDate(inv.TxnDate) || inv.TxnDate || "—"}</s-table-cell>
                        <s-table-cell>
                          {due ? (
                            <s-stack direction="block" gap="none">
                              <s-text>{due.label}</s-text>
                              {due.overdue && st.label !== "Paid" && st.label !== "Voided" && (
                                <s-badge tone="critical">Overdue</s-badge>
                              )}
                            </s-stack>
                          ) : "—"}
                        </s-table-cell>
                        <s-table-cell>{formatCurrency(Number(inv.TotalAmt || 0), inv.CurrencyRef?.value)}</s-table-cell>
                        <s-table-cell>{formatCurrency(Number(inv.Balance || 0), inv.CurrencyRef?.value)}</s-table-cell>
                        <s-table-cell><s-badge tone={st.tone}>{st.label}</s-badge></s-table-cell>
                      </s-table-row>
                    );
                  })
                )}
              </s-table-body>
            </s-table>
            <ViewAllLink href="/app/qbo/invoices" label="View all invoices" />
          </s-stack>
        )}
      </s-section>

      {/* ══════════════════════════════════════════════════════════════════════
          2 · VENDOR BILL ANALYTICS
      ══════════════════════════════════════════════════════════════════════ */}
      <SectionDivider label="Vendor Bill Analytics" />
      <s-section heading="Vendor Bill Analytics">
        {!billSnap ? (
          <s-banner tone="warning" heading="Vendor bill data unavailable">
            <s-paragraph>Could not load bill analytics from QuickBooks Online.</s-paragraph>
          </s-banner>
        ) : (
          <s-stack direction="block" gap="base">
            <s-grid gap="base" gridTemplateColumns={RESPONSIVE_4}>
              <MetricCard label="Total Bills" value={billSnap.total.toLocaleString()} sublabel="All time" icon="📄" />
              <MetricCard
                label="Open Bills"
                value={billSnap.open.toLocaleString()}
                sublabel="Balance outstanding"
                tone={billSnap.open > 0 ? "warning" : undefined}
                icon="📋"
              />
              <MetricCard label="Paid Bills" value={billSnap.paid.toLocaleString()} sublabel="Fully settled" tone="success" icon="✅" />
              <MetricCard
                label="Overdue Bills"
                value={billSnap.overdue.toLocaleString()}
                tone={billSnap.overdue > 0 ? "critical" : undefined}
                sublabel="Past due date"
                icon="⚠️"
              />
            </s-grid>

            <s-grid gap="base" gridTemplateColumns={RESPONSIVE_2}>
              <MetricCard
                label="Total Vendor Bills Issued"
                value={formatCurrency(billSnap.totalBilled, billCurrency)}
                sublabel={billAmountSublabel}
                icon="🏦"
              />
              <MetricCard
                label="Total Outstanding Amount"
                value={formatCurrency(billSnap.totalOutstanding, billCurrency)}
                tone={billSnap.totalOutstanding > 0 ? "warning" : undefined}
                sublabel="Unpaid bill balance"
                icon="⏳"
              />
            </s-grid>

            {/* Recent Bills table */}
            <s-table loading={loading}>
              <s-table-header-row>
                <s-table-header>Bill #</s-table-header>
                <s-table-header>Vendor</s-table-header>
                <s-table-header>Date</s-table-header>
                <s-table-header>Due Date</s-table-header>
                <s-table-header>Total</s-table-header>
                <s-table-header>Balance</s-table-header>
                <s-table-header>Status</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {(billSnap.recentBills || []).length === 0 ? (
                  <s-table-row>
                    <s-table-cell colSpan="7">
                      <s-text tone="subdued">No recent bills</s-text>
                    </s-table-cell>
                  </s-table-row>
                ) : (
                  (billSnap.recentBills || []).map((b) => {
                    const st = billStatus(b);
                    const due = fmtDueDate(b.DueDate);
                    return (
                      <s-table-row key={b.Id}>
                        <s-table-cell>{b.DocNumber || b.Id}</s-table-cell>
                        <s-table-cell>{b.VendorRef?.name || "—"}</s-table-cell>
                        <s-table-cell>{formatDate(b.TxnDate) || b.TxnDate || "—"}</s-table-cell>
                        <s-table-cell>
                          {due ? (
                            <s-stack direction="block" gap="none">
                              <s-text>{due.label}</s-text>
                              {due.overdue && st.label !== "Paid" && st.label !== "Voided" && (
                                <s-badge tone="critical">Overdue</s-badge>
                              )}
                            </s-stack>
                          ) : "—"}
                        </s-table-cell>
                        <s-table-cell>{formatCurrency(Number(b.TotalAmt || 0), b.CurrencyRef?.value)}</s-table-cell>
                        <s-table-cell>{formatCurrency(Number(b.Balance || 0), b.CurrencyRef?.value)}</s-table-cell>
                        <s-table-cell><s-badge tone={st.tone}>{st.label}</s-badge></s-table-cell>
                      </s-table-row>
                    );
                  })
                )}
              </s-table-body>
            </s-table>
            <ViewAllLink href="/app/qbo/bills" label="View all bills" />
          </s-stack>
        )}
      </s-section>

      {/* ══════════════════════════════════════════════════════════════════════
          3 · PAYMENT ANALYTICS
      ══════════════════════════════════════════════════════════════════════ */}
      <SectionDivider label="Payment Analytics" />
      <s-section heading="Payment Analytics">
        {!qboSnap ? (
          <s-banner tone="warning" heading="Payment data unavailable">
            <s-paragraph>Could not load payment analytics from QuickBooks Online.</s-paragraph>
          </s-banner>
        ) : (
          <s-stack direction="block" gap="base">
            <s-grid gap="base" gridTemplateColumns={RESPONSIVE_3}>
              <MetricCard
                label="Total Payments Received"
                value={paymentCount.toLocaleString()}
                sublabel="Recorded in QBO"
                icon="💳"
              />
              <MetricCard
                label="Total Amount Collected"
                value={formatCurrency(qboSnap.revenue.collected, currency)}
                sublabel="Sum of all payments applied"
                tone="success"
                icon="✅"
              />
              <MetricCard
                label="Outstanding Balance"
                value={formatCurrency(outstandingBalance, currency)}
                sublabel={`${(qboSnap.counts.pendingInvoices || 0).toLocaleString()} open invoice${qboSnap.counts.pendingInvoices !== 1 ? "s" : ""}`}
                tone={outstandingBalance > 0 ? "warning" : undefined}
                icon="⏳"
              />
            </s-grid>

            {/* Recent Payments table */}
            <s-table loading={loading}>
              <s-table-header-row>
                <s-table-header>Date</s-table-header>
                <s-table-header>Customer</s-table-header>
                <s-table-header>Amount</s-table-header>
                <s-table-header>Ref #</s-table-header>
                <s-table-header>Method</s-table-header>
                <s-table-header>Deposit To</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {(qboSnap.recentPayments || []).length === 0 ? (
                  <s-table-row>
                    <s-table-cell colSpan="6">
                      <s-text tone="subdued">No recent payments</s-text>
                    </s-table-cell>
                  </s-table-row>
                ) : (
                  (qboSnap.recentPayments || []).map((p) => (
                    <s-table-row key={p.Id}>
                      <s-table-cell>{formatDate(p.TxnDate) || p.TxnDate || "—"}</s-table-cell>
                      <s-table-cell>{p.CustomerRef?.name || "—"}</s-table-cell>
                      <s-table-cell>{formatCurrency(Number(p.TotalAmt || 0), p.CurrencyRef?.value)}</s-table-cell>
                      <s-table-cell>{p.PaymentRefNum || "—"}</s-table-cell>
                      <s-table-cell>{fmtMethod(p)}</s-table-cell>
                      <s-table-cell>{fmtDeposit(p)}</s-table-cell>
                    </s-table-row>
                  ))
                )}
              </s-table-body>
            </s-table>
            <ViewAllLink href="/app/qbo/transactions" label="View all payments" />
          </s-stack>
        )}
      </s-section>

      {/* ══════════════════════════════════════════════════════════════════════
          4 · PRACTITIONER COMMISSION ANALYTICS
      ══════════════════════════════════════════════════════════════════════ */}
      {!cdoMetrics ? (
        <>
          <SectionDivider label="Commission Analytics" />
          <s-section heading="Practitioner Commission Analytics">
            <s-banner tone="warning" heading="Commission data unavailable">
              <s-paragraph>Could not load CDO commission analytics.</s-paragraph>
            </s-banner>
          </s-section>
        </>
      ) : (
        <>
          <SectionDivider label="Commission Analytics" />
          <s-section heading="Practitioner Commission Analytics">
            <s-stack direction="block" gap="base">
              <s-grid gap="base" gridTemplateColumns={RESPONSIVE_4}>
                <MetricCard
                  label="Total Practitioners"
                  value={(kpis.activePractitioners || 0).toLocaleString()}
                  sublabel="Active in program"
                />
                <MetricCard
                  label="Commission Earned"
                  value={formatCurrency(kpis.totalCommissionEarned || 0, "USD")}
                  sublabel={`${(kpis.totalOrders || 0).toLocaleString()} attributed orders`}
                />
                <MetricCard
                  label="Commission Paid"
                  value={formatCurrency(kpis.totalCommissionPaid || 0, "USD")}
                  sublabel="Disbursed to practitioners"
                  tone="success"
                />
                <MetricCard
                  label="Outstanding Liability"
                  value={formatCurrency(kpis.outstandingLiability || 0, "USD")}
                  tone={kpis.outstandingLiability > 0 ? "warning" : undefined}
                  sublabel="Earned but not yet paid"
                />
              </s-grid>

              <s-grid gap="base" gridTemplateColumns={RESPONSIVE_3}>
                <MetricCard
                  label="Pending Approval"
                  value={formatCurrency(kpis.pendingApprovalAmount || 0, "USD")}
                  sublabel="Commissions awaiting approval"
                  tone="warning"
                />
                <MetricCard
                  label="Upcoming Payout Amount"
                  value={formatCurrency(upcoming.totalAmount || 0, "USD")}
                  sublabel={`${(upcoming.practitionerCount || 0).toLocaleString()} practitioner${upcoming.practitionerCount !== 1 ? "s" : ""} · ${(upcoming.commissionCount || 0).toLocaleString()} order${upcoming.commissionCount !== 1 ? "s" : ""}`}
                />
                <MetricCard
                  label="Next Payout Run"
                  value={upcoming.payoutRunAt ? new Date(upcoming.payoutRunAt).toLocaleDateString() : "—"}
                  sublabel={
                    upcoming.payoutRunAt
                      ? new Date(upcoming.payoutRunAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                      : "Scheduled date"
                  }
                />
              </s-grid>
            </s-stack>
          </s-section>

          {payoutBreakdown && (
            <s-section heading="Payout Method Breakdown">
              <s-grid gap="base" gridTemplateColumns={RESPONSIVE_3}>
                <s-box padding="base" border="base" borderRadius="base">
                  <s-stack direction="block" gap="tight">
                    <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                      <s-text>Check Payouts</s-text>
                      <s-badge tone="default">Check</s-badge>
                    </s-stack>
                    <s-stack direction="block" gap="none">
                      <s-text>
                        {(payoutBreakdown.check.paid || 0).toLocaleString()} paid · {(payoutBreakdown.check.pending || 0).toLocaleString()} pending
                      </s-text>
                      <s-text tone="subdued">{formatCurrency(payoutBreakdown.check.paidAmount || 0, "USD")} disbursed</s-text>
                      {payoutBreakdown.check.failed > 0 && (
                        <s-badge tone="critical">{payoutBreakdown.check.failed} failed</s-badge>
                      )}
                    </s-stack>
                  </s-stack>
                </s-box>

                <s-box padding="base" border="base" borderRadius="base">
                  <s-stack direction="block" gap="tight">
                    <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                      <s-text>ACH / Bank Transfer</s-text>
                      <s-badge tone="info">ACH</s-badge>
                    </s-stack>
                    <s-stack direction="block" gap="none">
                      <s-text>
                        {(payoutBreakdown.ach.paid || 0).toLocaleString()} paid · {(payoutBreakdown.ach.pending || 0).toLocaleString()} pending
                      </s-text>
                      <s-text tone="subdued">{formatCurrency(payoutBreakdown.ach.paidAmount || 0, "USD")} disbursed</s-text>
                      {payoutBreakdown.ach.failed > 0 && (
                        <s-badge tone="critical">{payoutBreakdown.ach.failed} failed</s-badge>
                      )}
                    </s-stack>
                  </s-stack>
                </s-box>

                <s-box padding="base" border="base" borderRadius="base">
                  <s-stack direction="block" gap="tight">
                    <s-text>Commission Status Summary</s-text>
                    <s-stack direction="block" gap="none">
                      <s-stack direction="inline" gap="small-200" alignItems="center">
                        <s-badge tone="success">Paid</s-badge>
                        <s-text>{formatCurrency(kpis.totalCommissionPaid || 0, "USD")}</s-text>
                      </s-stack>
                      <s-stack direction="inline" gap="small-200" alignItems="center">
                        <s-badge tone="warning">Pending</s-badge>
                        <s-text>{formatCurrency(kpis.pendingApprovalAmount || 0, "USD")}</s-text>
                      </s-stack>
                      <s-stack direction="inline" gap="small-200" alignItems="center">
                        <s-badge tone="info">Outstanding</s-badge>
                        <s-text>{formatCurrency(kpis.outstandingLiability || 0, "USD")}</s-text>
                      </s-stack>
                    </s-stack>
                  </s-stack>
                </s-box>
              </s-grid>
            </s-section>
          )}

          {topPractitioners.length > 0 && (
            <s-section heading="Top Practitioners by Commission Earned">
              <s-table loading={loading}>
                <s-table-header-row>
                  <s-table-header>Practitioner</s-table-header>
                  <s-table-header>Orders</s-table-header>
                  <s-table-header>Revenue Generated</s-table-header>
                  <s-table-header>Commission Earned</s-table-header>
                  <s-table-header>Effective Rate</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {topPractitioners.map((p, i) => (
                    <s-table-row key={i}>
                      <s-table-cell>{p.practitionerName || "—"}</s-table-cell>
                      <s-table-cell>{(p.orders || 0).toLocaleString()}</s-table-cell>
                      <s-table-cell>{formatCurrency(p.revenue || 0, "USD")}</s-table-cell>
                      <s-table-cell>{formatCurrency(p.commission || 0, "USD")}</s-table-cell>
                      <s-table-cell>
                        {p.revenue > 0 ? `${((p.commission / p.revenue) * 100).toFixed(1)}%` : "—"}
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            </s-section>
          )}

          {recentPayouts.length > 0 && (
            <s-section heading="Recently Processed Payouts">
              <s-table loading={loading}>
                <s-table-header-row>
                  <s-table-header>Practitioner</s-table-header>
                  <s-table-header>Amount</s-table-header>
                  <s-table-header>Method</s-table-header>
                  <s-table-header>Status</s-table-header>
                  <s-table-header>Reference</s-table-header>
                  <s-table-header>Paid At</s-table-header>
                  <s-table-header>Created</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {recentPayouts.map((p) => (
                    <s-table-row key={p.id}>
                      <s-table-cell>{p.practitionerName}</s-table-cell>
                      <s-table-cell>{formatCurrency(p.amount, p.currency)}</s-table-cell>
                      <s-table-cell>
                        <s-badge tone={p.method === "ach" || p.method === "bank" ? "info" : "default"}>
                          {p.method === "ach" || p.method === "bank" ? "ACH" : p.method === "check" ? "Check" : p.method}
                        </s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge tone={PAYOUT_STATUS_TONE[p.status] || "default"}>
                          {PAYOUT_STATUS_LABEL[p.status] || p.status}
                        </s-badge>
                      </s-table-cell>
                      <s-table-cell>{p.reference || "—"}</s-table-cell>
                      <s-table-cell>{p.paidAt ? new Date(p.paidAt).toLocaleDateString() : "—"}</s-table-cell>
                      <s-table-cell>{p.createdAt ? new Date(p.createdAt).toLocaleDateString() : "—"}</s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            </s-section>
          )}
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          5 · SYNC & SYSTEM STATUS
      ══════════════════════════════════════════════════════════════════════ */}
      <SectionDivider label="System Status" />
      <s-section heading="Sync &amp; System Status">
        {!syncStatus ? (
          <s-banner tone="warning" heading="Sync status unavailable">
            <s-paragraph>Could not load sync status from the database.</s-paragraph>
          </s-banner>
        ) : (
          <s-stack direction="block" gap="base">
            <s-text tone="subdued">
              Based on {syncStatus.totalOrders.toLocaleString()} total orders in the database.
            </s-text>
            <s-grid gap="base" gridTemplateColumns={RESPONSIVE_3}>
              <SyncCard
                label="Invoice Sync (QBO A/R)"
                synced={syncStatus.invoices.synced}
                errors={syncStatus.invoices.errors}
                pending={syncStatus.invoices.pending}
                lastSyncAt={syncStatus.invoices.lastSyncAt}
              />
              <SyncCard
                label="Vendor Bill Sync (QBO A/P)"
                synced={syncStatus.bills.synced}
                errors={syncStatus.bills.errors}
                pending={0}
                lastSyncAt={syncStatus.bills.lastSyncAt}
              />
              <SyncCard
                label="Payment Sync (QBO)"
                synced={syncStatus.payments.synced}
                errors={syncStatus.payments.errors}
                pending={0}
                lastSyncAt={syncStatus.payments.lastSyncAt}
              />
            </s-grid>

            {totalSyncErrors > 0 && (
              <s-banner tone="critical" heading="Failed sync records detected">
                <s-paragraph>
                  {syncStatus.invoices.errors > 0 &&
                    `${syncStatus.invoices.errors} invoice${syncStatus.invoices.errors !== 1 ? "s" : ""} failed to sync. `}
                  {syncStatus.bills.errors > 0 &&
                    `${syncStatus.bills.errors} bill${syncStatus.bills.errors !== 1 ? "s" : ""} failed to sync. `}
                  {syncStatus.payments.errors > 0 &&
                    `${syncStatus.payments.errors} payment${syncStatus.payments.errors !== 1 ? "s" : ""} failed to sync. `}
                  Review the Orders page for details.
                </s-paragraph>
              </s-banner>
            )}
          </s-stack>
        )}
      </s-section>

    </s-stack>
  );
}
