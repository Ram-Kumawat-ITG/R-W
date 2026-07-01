/* eslint-disable react/prop-types */
import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  listPractitionerPayouts,
  getPractitionerKpis,
  getSettings,
} from "../services/cdo/cdo.service";
import StatusBadge from "../components/cdo/StatusBadge";
import MetricCard from "../components/cdo/MetricCard";
import { formatCurrency, formatDate, formatDateTime, formatPercent } from "../utils/format";

export { action } from "./app.cdo-program.payouts.jsx";

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);
  const [rows, kpis, settings] = await Promise.all([
    listPractitionerPayouts(params.id),
    getPractitionerKpis(params.id),
    getSettings(),
  ]);
  return { rows, kpis, settings };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPeriod(r) {
  if (!r.periodStart && !r.periodEnd) return "—";
  if (!r.periodStart) return `Up to ${formatDate(r.periodEnd)}`;
  if (!r.periodEnd) return `From ${formatDate(r.periodStart)}`;
  return `${formatDate(r.periodStart)} – ${formatDate(r.periodEnd)}`;
}

const METHOD_LABEL = { ach: "ACH / Bank Transfer", check: "Check", manual: "Manual" };
const METHOD_SHORT = { ach: "ACH", check: "Check", manual: "Manual" };

const STATUS_ACCENT = {
  paid: "#00a47c",
  approved: "#006fbb",
  awaiting_approval: "#b98900",
  draft: "#b98900",
  awaiting_settlement: "#006fbb",
  failed: "#d72c0d",
  rejected: "#8c9196",
  cancelled: "#d72c0d",
};

const REMARK_KIND_LABEL = {
  batch_created: "Batch created",
  approved: "Approved",
  rejected: "Rejected",
  transfer_initiated: "Transfer initiated",
  settled: "Settled",
  returned: "Returned",
  failed: "Failed",
  check_issued: "Check issued",
  settlement_checked: "Settlement checked",
  remarked: "Note",
};

// ── PayoutCard ────────────────────────────────────────────────────────────────

function PayoutCard({ row, fetcher }) {
  const [expanded, setExpanded] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);

  const busy = fetcher.state !== "idle" && fetcher.formData?.get("payoutId") === row.id;
  const pendingOp = busy ? fetcher.formData?.get("_action") : null;
  const accent = STATUS_ACCENT[row.status] || "#c9cccf";

  const submit = (payload, confirmText) => {
    if (confirmText && !confirm(confirmText)) return;
    fetcher.submit(payload, { method: "POST" });
  };

  const totalCommission = row.commissions.reduce((s, c) => s + (c.amount || 0), 0);

  return (
    <div style={{
      background: "#fff",
      border: "1px solid #e1e3e5",
      borderLeft: `3px solid ${accent}`,
      borderRadius: "8px",
      overflow: "hidden",
    }}>
      {/* ── Header ── */}
      <div
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: "14px",
          padding: "12px 16px",
          cursor: "pointer", userSelect: "none",
          background: expanded ? "#f9fafb" : "#fff",
          borderBottom: expanded ? "1px solid #e1e3e5" : "none",
        }}
      >
        {/* Amount block */}
        <div style={{ flex: "0 0 auto", minWidth: "120px" }}>
          <div style={{ fontWeight: 700, fontSize: "16px", color: "#202223" }}>
            {formatCurrency(row.amount, row.currency)}
          </div>
          <div style={{ fontSize: "11px", color: "#8c9196", marginTop: "1px" }}>
            {row.commissionCount} commission{row.commissionCount !== 1 ? "s" : ""}
            {row.reference && (
              <span style={{ marginLeft: "6px", color: "#c9cccf" }}>· {row.reference}</span>
            )}
          </div>
        </div>

        {/* Status + method badges */}
        <div style={{ display: "flex", gap: "6px", alignItems: "center", flex: "0 0 auto" }}>
          <StatusBadge status={row.status} />
          <s-badge>{METHOD_SHORT[row.method] || row.method || "—"}</s-badge>
          {row.hasInconsistency && (
            <s-badge tone="warning">⚠ Data issue</s-badge>
          )}
        </div>

        {/* Period */}
        <div style={{ flex: 1, fontSize: "13px", color: "#6d7175" }}>
          {fmtPeriod(row)}
        </div>

        {/* QBO bill */}
        <div style={{ flex: "0 0 auto" }} onClick={(e) => e.stopPropagation()}>
          {row.qboBillUrl ? (
            <s-link href={row.qboBillUrl} target="_blank">Bill {row.qboBillId}</s-link>
          ) : (
            <span style={{ color: "#c9cccf", fontSize: "12px" }}>No bill</span>
          )}
        </div>

        {/* Paid date */}
        {row.paidAt && (
          <div style={{ flex: "0 0 auto", fontSize: "12px", color: "#8c9196" }}>
            {formatDate(row.paidAt)}
          </div>
        )}

        <span style={{ fontSize: "12px", color: "#9ba0a5" }}>
          {expanded ? "▲" : "▼"}
        </span>
      </div>

      {/* ── Expanded body ── */}
      {expanded && (
        <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: "14px" }}>

          {/* Inconsistency warning */}
          {row.hasInconsistency && (
            <div style={{
              display: "flex", gap: "12px", alignItems: "flex-start",
              padding: "12px 14px",
              background: "#fff8f0",
              border: "1px solid #e59c1a",
              borderLeft: "4px solid #e59c1a",
              borderRadius: "6px",
            }}>
              <span style={{ fontSize: "18px", flexShrink: 0 }}>⚠️</span>
              <div>
                <div style={{ fontWeight: 600, fontSize: "13px", color: "#916800" }}>
                  Data inconsistency — payout is {row.status} but {row.paidCommissionCount} commission{row.paidCommissionCount !== 1 ? "s are" : " is"} marked Paid
                </div>
                <div style={{ fontSize: "12px", color: "#916800", marginTop: "3px", opacity: 0.85 }}>
                  This is a legacy record. The commissions were settled (money went out) before this payout record
                  was cancelled by an automated process. The financial transaction is real — the payout status is
                  a record-keeping artefact. Review the QBO bill and audit trail below for the full history.
                </div>
              </div>
            </div>
          )}

          {/* Last error */}
          {row.lastError && !row.hasInconsistency && (
            <s-banner tone="critical">
              <s-paragraph>{row.lastError}</s-paragraph>
            </s-banner>
          )}

          {/* ── Audit summary strip ── */}
          <div style={{
            display: "flex", gap: "0", flexWrap: "wrap",
            background: "#f9fafb", border: "1px solid #e1e3e5",
            borderRadius: "8px", overflow: "hidden",
          }}>
            {[
              { label: "Batch ID", value: row.reference || "—" },
              { label: "Payout Date", value: row.paidAt ? formatDate(row.paidAt) : "—" },
              { label: "Method", value: METHOD_LABEL[row.method] || row.method || "—" },
              {
                label: row.method === "check" ? "Check Number" : "Transaction ID",
                value: row.checkNumber
                  ? `#${row.checkNumber}`
                  : (row.transactionId || "—"),
              },
              { label: "Processed By", value: row.processedBy || row.approvedBy || "—" },
              {
                label: "Processing Date",
                value: row.transferInitiatedAt
                  ? formatDateTime(row.transferInitiatedAt)
                  : (row.checkDate ? formatDate(row.checkDate) : (row.approvedAt ? formatDateTime(row.approvedAt) : "—")),
              },
            ].map((stat, i, arr) => (
              <div key={stat.label} style={{
                flex: "1 0 140px",
                padding: "9px 14px",
                borderRight: i < arr.length - 1 ? "1px solid #e1e3e5" : "none",
                borderBottom: "none",
              }}>
                <div style={{ fontSize: "10px", color: "#8c9196", textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "3px" }}>
                  {stat.label}
                </div>
                <div style={{ fontSize: "12px", fontWeight: 600, color: "#303030", wordBreak: "break-all" }}>
                  {stat.value}
                </div>
              </div>
            ))}
          </div>

          {/* ── Action buttons ── */}
          {(row.status === "awaiting_approval" || row.status === "draft" ||
            row.status === "approved" || row.status === "failed" ||
            row.status === "awaiting_settlement") && (
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {(row.status === "awaiting_approval" || row.status === "draft") && (
                <>
                  <s-button
                    variant="primary"
                    {...(busy && pendingOp === "approve" ? { loading: true } : {})}
                    onClick={() => submit({ _action: "approve", payoutId: row.id })}
                  >
                    Approve
                  </s-button>
                  <s-button
                    variant="tertiary"
                    tone="critical"
                    {...(busy && pendingOp === "reject" ? { loading: true } : {})}
                    onClick={() =>
                      submit(
                        { _action: "reject", payoutId: row.id },
                        "Reject this payout? Its commissions return to the pool.",
                      )
                    }
                  >
                    Reject
                  </s-button>
                </>
              )}
              {(row.status === "approved" || row.status === "failed") && (
                <s-button
                  variant="primary"
                  {...(busy && pendingOp === "execute" ? { loading: true } : {})}
                  onClick={() =>
                    submit(
                      { _action: "execute", payoutId: row.id },
                      row.status === "failed"
                        ? "Retry executing this payout in QuickBooks?"
                        : "Execute payout? This posts a Bill + BillPayment to QuickBooks.",
                    )
                  }
                >
                  {row.status === "failed" ? "Retry" : "Execute"}
                </s-button>
              )}
              {row.status === "awaiting_settlement" && (
                <s-button
                  variant="secondary"
                  {...(busy && pendingOp === "check-settlement" ? { loading: true } : {})}
                  onClick={() => submit({ _action: "check-settlement", payoutId: row.id })}
                >
                  Sync settlement
                </s-button>
              )}
            </div>
          )}

          {/* ── Commission breakdown ── */}
          {row.commissions.length > 0 && (
            <div>
              <div style={{
                fontSize: "11px", fontWeight: 600, color: "#6d7175",
                textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "8px",
              }}>
                Commission breakdown ({row.commissions.length})
              </div>
              <s-table>
                <s-table-header-row>
                  <s-table-header>Order</s-table-header>
                  <s-table-header>Earned</s-table-header>
                  <s-table-header>Order Amount</s-table-header>
                  <s-table-header>Rate</s-table-header>
                  <s-table-header>Commission</s-table-header>
                  <s-table-header>Status</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {row.commissions.map((c) => (
                    <s-table-row key={c.id}>
                      <s-table-cell><strong>{c.orderName}</strong></s-table-cell>
                      <s-table-cell>{c.earnedAt ? formatDate(c.earnedAt) : "—"}</s-table-cell>
                      <s-table-cell>
                        {c.rate > 0 ? formatCurrency(c.amount / c.rate, c.currency) : "—"}
                      </s-table-cell>
                      <s-table-cell>{formatPercent(c.rate)}</s-table-cell>
                      <s-table-cell>
                        <strong>{formatCurrency(c.amount, c.currency)}</strong>
                      </s-table-cell>
                      <s-table-cell>
                        {/* If payout is cancelled but commission is paid, flag it */}
                        {row.hasInconsistency && c.status === "paid" ? (
                          <span style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                            <StatusBadge status={c.status} />
                            <span style={{ fontSize: "10px", color: "#916800" }}>⚠</span>
                          </span>
                        ) : (
                          <StatusBadge status={c.status} />
                        )}
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
              <div style={{
                display: "flex", justifyContent: "flex-end",
                padding: "8px 4px 0",
                borderTop: "1px solid #f1f2f3",
                marginTop: "4px",
                fontSize: "13px", color: "#6d7175",
              }}>
                {row.commissions.length} order{row.commissions.length !== 1 ? "s" : ""}
                &nbsp;·&nbsp;
                <strong style={{ color: "#202223" }}>
                  Total: {formatCurrency(totalCommission, row.currency)}
                </strong>
              </div>
            </div>
          )}

          {/* ── Audit trail (collapsible) ── */}
          {row.remarks.length > 0 && (
            <div>
              <button
                onClick={() => setAuditOpen((v) => !v)}
                style={{
                  display: "flex", alignItems: "center", gap: "6px",
                  background: "none", border: "none", padding: "0",
                  fontSize: "12px", fontWeight: 600, color: "#6d7175",
                  textTransform: "uppercase", letterSpacing: "0.4px",
                  cursor: "pointer",
                }}
              >
                <span>Audit trail ({row.remarks.length})</span>
                <span style={{ fontSize: "10px" }}>{auditOpen ? "▲" : "▼"}</span>
              </button>
              {auditOpen && (
                <div style={{ marginTop: "8px" }}>
                  <s-table>
                    <s-table-header-row>
                      <s-table-header>Timestamp</s-table-header>
                      <s-table-header>Event</s-table-header>
                      <s-table-header>Details</s-table-header>
                      <s-table-header>Actor</s-table-header>
                    </s-table-header-row>
                    <s-table-body>
                      {[...row.remarks].reverse().map((rem, i) => (
                        <s-table-row key={i}>
                          <s-table-cell>
                            <span style={{ fontSize: "12px", color: "#6d7175", whiteSpace: "nowrap" }}>
                              {rem.createdAt ? formatDateTime(rem.createdAt) : "—"}
                            </span>
                          </s-table-cell>
                          <s-table-cell>
                            <s-badge>{REMARK_KIND_LABEL[rem.kind] || rem.kind || "—"}</s-badge>
                          </s-table-cell>
                          <s-table-cell>
                            <span style={{ fontSize: "12px" }}>{rem.message || "—"}</span>
                          </s-table-cell>
                          <s-table-cell>
                            <span style={{ fontSize: "12px", color: "#6d7175" }}>
                              {rem.actor || "—"}
                            </span>
                          </s-table-cell>
                        </s-table-row>
                      ))}
                    </s-table-body>
                  </s-table>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CdoCustomerPayments() {
  const { rows, kpis, settings } = useLoaderData();
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const handledRef = useRef(null);

  useEffect(() => {
    if (!fetcher.data || fetcher.state !== "idle") return;
    if (handledRef.current === fetcher.data) return;
    handledRef.current = fetcher.data;
    if (fetcher.data.status === "success") {
      shopify?.toast?.show(fetcher.data.message || "Done");
    } else {
      shopify?.toast?.show(fetcher.data.message || "Action failed", { isError: true });
    }
  }, [fetcher.data, fetcher.state, shopify]);

  const inconsistentCount = rows.filter((r) => r.hasInconsistency).length;

  return (
    <s-stack direction="block" gap="base">
      {/* KPI strip */}
      <s-grid gap="base" gridTemplateColumns="repeat(3, minmax(0, 1fr))">
        <MetricCard
          label="Pending payout"
          value={formatCurrency(kpis.pendingPayout, settings.currency)}
          icon="⏳"
          tone={kpis.pendingPayout > 0 ? "warning" : undefined}
        />
        <MetricCard
          label="Paid to date"
          value={formatCurrency(kpis.paidPayout, settings.currency)}
          tone="success"
          icon="✅"
        />
        <MetricCard
          label="Total commissions"
          value={formatCurrency(kpis.totalCommissions, settings.currency)}
          icon="💰"
        />
      </s-grid>

      {/* Top-level inconsistency notice */}
      {inconsistentCount > 0 && (
        <div style={{
          display: "flex", gap: "12px", alignItems: "flex-start",
          padding: "12px 16px",
          background: "#fff8f0",
          border: "1px solid #e59c1a",
          borderLeft: "4px solid #e59c1a",
          borderRadius: "8px",
        }}>
          <span style={{ fontSize: "18px" }}>⚠️</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: "13px", color: "#916800" }}>
              {inconsistentCount} payout record{inconsistentCount !== 1 ? "s have" : " has"} a data inconsistency
            </div>
            <div style={{ fontSize: "12px", color: "#916800", marginTop: "2px", opacity: 0.85 }}>
              These payouts are marked Cancelled but their commissions are marked Paid. This is a legacy data issue —
              the commissions were settled before the payout was cancelled. Expand the payout to see the full details.
            </div>
          </div>
        </div>
      )}

      {/* Payout list */}
      <s-section>
        <s-stack direction="block" gap="small-200">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }}>
            <span style={{ fontSize: "13px", color: "#6d7175" }}>
              {rows.length} payout{rows.length !== 1 ? "s" : ""} — expand a row to see commission breakdown and audit trail
            </span>
            <s-button
              variant="tertiary"
              icon="refresh"
              {...(revalidator.state !== "idle" ? { loading: true } : {})}
              onClick={() => revalidator.revalidate()}
            >
              Refresh
            </s-button>
          </div>

          {rows.length === 0 ? (
            <div style={{ textAlign: "center", padding: "48px 16px" }}>
              <div style={{ fontSize: "28px", marginBottom: "10px", opacity: 0.4 }}>💳</div>
              <div style={{ fontWeight: 600, fontSize: "14px", color: "#303030", marginBottom: "4px" }}>
                No payouts yet
              </div>
              <div style={{ color: "#8c9196", fontSize: "13px" }}>
                Payouts appear here once a batch is generated from approved commissions.
              </div>
            </div>
          ) : (
            rows.map((row) => (
              <PayoutCard key={row.id} row={row} fetcher={fetcher} />
            ))
          )}
        </s-stack>
      </s-section>
    </s-stack>
  );
}
