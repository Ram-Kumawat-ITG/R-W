/* eslint-disable react/prop-types */
import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  listPayoutBatches,
  listCheckPayouts,
  getPayoutBatch,
  getPayoutCommissions,
  accrueCommissionsForOrders,
  buildPayoutBatch,
  approvePayout,
  rejectPayout,
  executeApprovedPayout,
  checkPayoutSettlement,
  markCheckPayoutPaid,
} from "../services/cdo/cdo.service";
import StatusBadge from "../components/cdo/StatusBadge";
import { MigratedBadge } from "../components/cdo/MigratedBadge";
import { formatCurrency, formatDate, formatDateTime, formatPercent } from "../utils/format";

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const { searchParams } = new URL(request.url);

  // Lazy-load: full batch detail for an expanded BatchCard
  const batchId = searchParams.get("batchId");
  if (batchId) {
    const batch = await getPayoutBatch(batchId);
    return { type: "batch", batch };
  }

  // Lazy-load: commission rows for an expanded CheckPayoutCard
  const payoutId = searchParams.get("payoutId");
  if (payoutId) {
    const commissions = await getPayoutCommissions(payoutId);
    return { type: "payout-commissions", commissions };
  }

  // Default: batch list + check payouts list
  const [batches, checkPayouts] = await Promise.all([
    listPayoutBatches(),
    listCheckPayouts(),
  ]);
  return { type: "list", batches, checkPayouts };
};

// ── Action ────────────────────────────────────────────────────────────────────

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const actor =
    session?.onlineAccessInfo?.associated_user?.email || session?.shop || "admin";

  const formData = await request.formData();
  const op = String(formData.get("_action") || "").trim();
  const payoutId = formData.get("payoutId");

  try {
    switch (op) {
      case "generate-batch": {
        const periodEndRaw = formData.get("periodEnd");
        const periodEnd = periodEndRaw ? new Date(periodEndRaw) : new Date();
        const accrual = await accrueCommissionsForOrders();
        const { created, skipped } = await buildPayoutBatch({ periodEnd, actor });
        return {
          status: "success",
          op,
          message: `Accrued ${accrual.createdCount} new commission(s); created ${created.length} payout(s); skipped ${skipped.length}.`,
        };
      }
      case "approve": {
        const p = await approvePayout(payoutId, actor);
        return { status: "success", op, message: `Approved payout ${p.reference || ""}`.trim() };
      }
      case "reject": {
        const p = await rejectPayout(payoutId, actor, formData.get("reason") || "");
        return { status: "success", op, message: `Rejected payout ${p.reference || ""}`.trim() };
      }
      case "execute": {
        const p = await executeApprovedPayout(payoutId, { actor });
        if (p.status === "awaiting_settlement") {
          return { status: "success", op, message: `Transfer initiated — awaiting settlement. QBO Bill ${p.qboBillId}.` };
        }
        if (p.status === "paid") {
          return { status: "success", op, message: `Payout settled — QBO Bill ${p.qboBillId}` };
        }
        return { status: "error", op, message: `Payout ${p.status}${p.lastError ? `: ${p.lastError}` : ""}` };
      }
      case "check-settlement": {
        const res = await checkPayoutSettlement(payoutId, { actor, source: "admin" });
        const message =
          res.status === "paid" ? "Transfer settled — payout marked paid." :
          res.status === "failed" ? "Transfer returned/failed — retry once banking is fixed." :
          "Still settling — check back later.";
        return { status: res.status === "failed" ? "error" : "success", op, message };
      }
      case "mark-check-paid": {
        const payout = await markCheckPayoutPaid(payoutId, {
          checkNumber: formData.get("checkNumber") || "",
          checkDate: formData.get("checkDate") || null,
          notes: formData.get("notes") || "",
          actor,
        });
        const num = payout.checkDetails?.checkNumber;
        return {
          status: "success",
          op,
          message: `Check${num ? ` #${num}` : ""} marked as paid for ${payout.practitionerName || "practitioner"}.`,
        };
      }
      default:
        return { status: "error", op, message: `Unknown action: ${op}` };
    }
  } catch (e) {
    console.error(`[cdo-program/payouts] action ${op} failed:`, e?.message || e);
    return { status: "error", op, message: e?.message || "Action failed" };
  }
};

// ── Shared constants ──────────────────────────────────────────────────────────

const METHOD_SHORT = { ach: "ACH", check: "Check", manual: "Manual" };

const BATCH_STATUS_TONE = {
  completed: "success",
  running: "info",
  completed_with_errors: "warning",
  failed: "critical",
};
const BATCH_STATUS_LABEL = {
  completed: "Completed",
  running: "Running",
  completed_with_errors: "Partial",
  failed: "Failed",
};
const BATCH_STATUS_ACCENT = {
  completed: "#00a47c",
  running: "#006fbb",
  completed_with_errors: "#b98900",
  failed: "#d72c0d",
};
const PAYOUT_STATUS_ACCENT = {
  paid: "#00a47c",
  approved: "#006fbb",
  awaiting_approval: "#b98900",
  draft: "#b98900",
  awaiting_settlement: "#006fbb",
  failed: "#d72c0d",
  rejected: "#8c9196",
  cancelled: "#d72c0d",
};

const PAYOUT_ACTION_STATUSES = new Set([
  "awaiting_approval", "draft", "approved", "failed", "awaiting_settlement",
]);

// ── Shared helpers ────────────────────────────────────────────────────────────

function fmtPeriod(r) {
  if (!r.periodStart && !r.periodEnd) return "—";
  if (!r.periodStart) return `Up to ${formatDate(r.periodEnd)}`;
  if (!r.periodEnd) return `From ${formatDate(r.periodStart)}`;
  return `${formatDate(r.periodStart)} – ${formatDate(r.periodEnd)}`;
}

function Stat({ label, value, mono }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
      <span style={{ fontSize: "10px", color: "#8c9196", textTransform: "uppercase", letterSpacing: "0.4px" }}>
        {label}
      </span>
      <span style={{ fontSize: "13px", fontWeight: 600, color: "#202223", fontFamily: mono ? "monospace" : undefined }}>
        {value}
      </span>
    </div>
  );
}

function Divider() {
  return <div style={{ width: "1px", alignSelf: "stretch", background: "#e1e3e5", flexShrink: 0 }} />;
}

function DateField({ label, value, onChange }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <span style={{ fontSize: "13px", fontWeight: 550 }}>{label}</span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: "7px 12px",
          border: "1px solid var(--p-color-border, #919191)",
          borderRadius: "8px",
          fontSize: "14px",
          background: "var(--p-color-bg-surface, #fff)",
          outline: "none",
          width: "100%",
          boxSizing: "border-box",
          cursor: "pointer",
        }}
      />
    </div>
  );
}

// Lazy-loaded commission table (shared by BatchCard practitioner rows + CheckPayoutCard)
function CommissionsTable({ commissions }) {
  const total = commissions.reduce((s, c) => s + (c.amount || 0), 0);
  return (
    <div>
      <s-table>
        <s-table-header-row>
          <s-table-header>Order</s-table-header>
          <s-table-header>Rate</s-table-header>
          <s-table-header>Commission</s-table-header>
          <s-table-header>Status</s-table-header>
          <s-table-header>Earned</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {commissions.map((c) => (
            <s-table-row key={c.id}>
              <s-table-cell><strong>{c.orderName}</strong></s-table-cell>
              <s-table-cell>{formatPercent(c.rate)}</s-table-cell>
              <s-table-cell><strong>{formatCurrency(c.amount, c.currency)}</strong></s-table-cell>
              <s-table-cell>
                <s-badge tone={c.status === "paid" ? "success" : c.status === "failed" ? "critical" : undefined}>
                  {c.status}
                </s-badge>
              </s-table-cell>
              <s-table-cell>{c.earnedAt ? formatDate(c.earnedAt) : "—"}</s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
      <div style={{
        textAlign: "right", fontSize: "12px", color: "#6d7175",
        paddingTop: "6px", borderTop: "1px solid #e1e3e5", marginTop: "4px",
      }}>
        {commissions.length} order{commissions.length !== 1 ? "s" : ""}
        &nbsp;·&nbsp;
        <strong style={{ color: "#202223" }}>{formatCurrency(total)}</strong>
      </div>
    </div>
  );
}

// ── PractitionerRow (inside BatchCard) ────────────────────────────────────────

function PractitionerRow({ p, items, actionFetcher }) {
  const [expanded, setExpanded] = useState(false);

  const myItems = useMemo(() => {
    if (!items?.length) return [];
    return items.filter((i) =>
      (p.practitionerId && i.practitionerId === p.practitionerId) ||
      (p.practitionerEmail && i.practitionerEmail === p.practitionerEmail),
    );
  }, [items, p.practitionerId, p.practitionerEmail]);

  const busy = actionFetcher.state !== "idle" && actionFetcher.formData?.get("payoutId") === p.payoutId;
  const pendingOp = busy ? actionFetcher.formData?.get("_action") : null;
  const needsAction = p.payoutId && PAYOUT_ACTION_STATUSES.has(p.status);

  const submit = (payload, confirmText) => {
    if (confirmText && !confirm(confirmText)) return;
    actionFetcher.submit(payload, { method: "POST" });
  };

  const paymentId =
    p.method === "check"
      ? p.checkNumber ? `#${p.checkNumber}` : "—"
      : p.transactionId || p.txnRef || "—";

  return (
    <div style={{ borderBottom: "1px solid #f1f2f3" }}>
      <div
        style={{
          display: "flex", alignItems: "center", gap: "10px",
          padding: "10px 16px",
          cursor: myItems.length > 0 ? "pointer" : "default",
          background: expanded ? "#f9fafb" : "#fff",
        }}
        onClick={() => myItems.length > 0 && setExpanded((v) => !v)}
      >
        <span style={{ fontSize: "10px", color: "#9ba0a5", width: "12px", flexShrink: 0 }}>
          {myItems.length > 0 ? (expanded ? "▲" : "▼") : "·"}
        </span>
        <div style={{ flex: "2 1 160px", minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: "13px", color: "#202223", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {p.practitionerName}
          </div>
          {p.practitionerEmail && <div style={{ fontSize: "11px", color: "#8c9196" }}>{p.practitionerEmail}</div>}
        </div>
        <div style={{ flex: "0 0 60px", textAlign: "center", fontSize: "13px" }}>{p.commissionCount}</div>
        <div style={{ flex: "0 0 90px", textAlign: "right", fontWeight: 600, fontSize: "13px" }}>{formatCurrency(p.totalAmount)}</div>
        <div style={{ flex: "0 0 70px" }}><s-badge>{METHOD_SHORT[p.method] || p.method || "—"}</s-badge></div>
        <div style={{ flex: "0 0 130px" }}><StatusBadge status={p.status} /></div>
        <div style={{ flex: "1 0 110px", fontSize: "12px", color: "#6d7175", fontFamily: "monospace" }}>{paymentId}</div>
        <div style={{ flex: "0 0 85px", fontSize: "12px", color: "#6d7175" }}>{p.paidAt ? formatDate(p.paidAt) : "—"}</div>
        <div style={{ flex: "0 0 80px" }} onClick={(e) => e.stopPropagation()}>
          {p.qboBillUrl
            ? <s-link href={p.qboBillUrl} target="_blank" style={{ fontSize: "12px" }}>Bill {p.qboBillId}</s-link>
            : <span style={{ color: "#c9cccf", fontSize: "12px" }}>—</span>}
        </div>
        {needsAction && (
          <div style={{ flex: "0 0 auto", display: "flex", gap: "6px" }} onClick={(e) => e.stopPropagation()}>
            {(p.status === "awaiting_approval" || p.status === "draft") && (
              <>
                <s-button variant="primary" size="slim"
                  {...(busy && pendingOp === "approve" ? { loading: true } : {})}
                  onClick={() => submit({ _action: "approve", payoutId: p.payoutId })}>
                  Approve
                </s-button>
                <s-button variant="tertiary" size="slim" tone="critical"
                  {...(busy && pendingOp === "reject" ? { loading: true } : {})}
                  onClick={() => submit({ _action: "reject", payoutId: p.payoutId }, `Reject payout for ${p.practitionerName}?`)}>
                  Reject
                </s-button>
              </>
            )}
            {(p.status === "approved" || p.status === "failed") && (
              <s-button variant="primary" size="slim"
                {...(busy && pendingOp === "execute" ? { loading: true } : {})}
                onClick={() => submit(
                  { _action: "execute", payoutId: p.payoutId },
                  p.status === "failed"
                    ? `Retry payout for ${p.practitionerName}?`
                    : `Execute ACH payout for ${p.practitionerName}? This initiates a real bank transfer of ${formatCurrency(p.totalAmount)}.`,
                )}>
                {p.status === "failed" ? "Retry" : "Execute"}
              </s-button>
            )}
            {p.status === "awaiting_settlement" && (
              <s-button variant="secondary" size="slim"
                {...(busy && pendingOp === "check-settlement" ? { loading: true } : {})}
                onClick={() => submit({ _action: "check-settlement", payoutId: p.payoutId })}>
                Sync
              </s-button>
            )}
          </div>
        )}
      </div>

      {expanded && myItems.length > 0 && (
        <div style={{ background: "#f9fafb", borderTop: "1px solid #f1f2f3", padding: "8px 16px 12px 40px" }}>
          <div style={{ fontSize: "10px", fontWeight: 600, color: "#8c9196", textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "6px" }}>
            Orders in this payout
          </div>
          <CommissionsTable commissions={myItems.map((i) => ({
            id: i.commissionId,
            orderName: i.orderName,
            amount: i.amount,
            currency: "USD",
            status: i.status,
            earnedAt: i.payoutDate,
            rate: 0,
          }))} />
        </div>
      )}
    </div>
  );
}

// ── BatchCard ─────────────────────────────────────────────────────────────────

function BatchCard({ batch }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState(null);
  const shopify = useAppBridge();
  const loadFetcher = useFetcher();
  const actionFetcher = useFetcher();
  const handledRef = useRef(null);

  useEffect(() => {
    if (!expanded || detail || loadFetcher.state !== "idle") return;
    loadFetcher.load(`/app/cdo-program/payouts?batchId=${batch.id}`);
  }, [expanded, detail, loadFetcher.state, batch.id]);

  useEffect(() => {
    if (!loadFetcher.data) return;
    if (loadFetcher.data.type === "batch" && loadFetcher.data.batch?.id === batch.id) {
      setDetail(loadFetcher.data.batch);
    }
  }, [loadFetcher.data, batch.id]);

  useEffect(() => {
    if (!actionFetcher.data || actionFetcher.state !== "idle") return;
    if (handledRef.current === actionFetcher.data) return;
    handledRef.current = actionFetcher.data;
    if (actionFetcher.data.status === "success") {
      shopify?.toast?.show(actionFetcher.data.message || "Done");
      loadFetcher.load(`/app/cdo-program/payouts?batchId=${batch.id}`);
    } else {
      shopify?.toast?.show(actionFetcher.data.message || "Action failed", { isError: true });
    }
  }, [actionFetcher.data, actionFetcher.state, batch.id, shopify]);

  const accent = BATCH_STATUS_ACCENT[batch.status] || "#c9cccf";
  const isLoading = loadFetcher.state !== "idle";

  const outcomeChips = detail ? [
    { label: "Paid", count: detail.successCount, tone: "success" },
    { label: "Failed", count: detail.failedCount, tone: "critical" },
    { label: "Skipped", count: detail.skippedCount, tone: "default" },
    { label: "Pending", count: detail.processingCount, tone: "info" },
  ].filter((c) => c.count > 0) : [];

  const pendingActionCount = detail
    ? (detail.practitionerPayouts || []).filter((p) => p.payoutId && PAYOUT_ACTION_STATUSES.has(p.status)).length
    : 0;

  return (
    <div style={{ border: "1px solid #e1e3e5", borderLeft: `3px solid ${accent}`, borderRadius: "8px", overflow: "hidden", background: "#fff" }}>
      <div
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex", alignItems: "center", flexWrap: "wrap", gap: "16px",
          padding: "14px 16px", cursor: "pointer", userSelect: "none",
          background: expanded ? "#f9fafb" : "#fff",
          borderBottom: expanded ? "1px solid #e1e3e5" : "none",
        }}
      >
        <div style={{ flex: "1 1 200px" }}>
          <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: "13px", color: "#202223" }}>
            {batch.reference || batch.id.slice(-8)}
          </div>
          <div style={{ fontSize: "11px", color: "#8c9196", marginTop: "2px" }}>
            {batch.mode === "manual_reprocess" ? "Manual reprocess" : "Automated run"}
            {batch.executionTime && ` · ${formatDateTime(batch.executionTime)}`}
          </div>
        </div>
        <div style={{ display: "flex", gap: "16px", alignItems: "center", flexWrap: "wrap" }}>
          <Stat label="Practitioners" value={batch.practitionerCount || "—"} />
          <Divider />
          <Stat label="Commissions" value={batch.totalCommissions} />
          <Divider />
          <Stat label="Total Amount" value={formatCurrency(batch.totalAmount)} />
        </div>
        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <s-badge tone={BATCH_STATUS_TONE[batch.status] || "default"}>
            {BATCH_STATUS_LABEL[batch.status] || batch.status}
          </s-badge>
          {pendingActionCount > 0 && <s-badge tone="warning">{pendingActionCount} need action</s-badge>}
        </div>
        <span style={{ fontSize: "12px", color: "#9ba0a5", marginLeft: "auto" }}>{expanded ? "▲" : "▼"}</span>
      </div>

      {expanded && (
        <div>
          {isLoading && !detail && (
            <div style={{ padding: "24px", textAlign: "center", color: "#8c9196", fontSize: "13px" }}>
              Loading batch detail…
            </div>
          )}
          {detail && (
            <>
              {detail.error && (
                <div style={{ margin: "12px 16px 0" }}>
                  <s-banner tone="critical"><s-paragraph>Batch error: {detail.error}</s-paragraph></s-banner>
                </div>
              )}
              {outcomeChips.length > 0 && (
                <div style={{ display: "flex", gap: "8px", padding: "10px 16px", borderBottom: "1px solid #f1f2f3", background: "#fafbfb" }}>
                  {outcomeChips.map((c) => <s-badge key={c.label} tone={c.tone}>{c.label}: {c.count}</s-badge>)}
                  {detail.completedAt && (
                    <span style={{ fontSize: "12px", color: "#8c9196", marginLeft: "auto" }}>
                      Completed {formatDateTime(detail.completedAt)}
                    </span>
                  )}
                </div>
              )}
              {detail.practitionerPayouts?.length > 0 && (
                <>
                  {/* Column headers */}
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 16px", borderBottom: "1px solid #e1e3e5", background: "#f9fafb" }}>
                    <div style={{ width: "12px" }} />
                    {[
                      { label: "Practitioner", style: { flex: "2 1 160px" } },
                      { label: "Orders", style: { flex: "0 0 60px", textAlign: "center" } },
                      { label: "Amount", style: { flex: "0 0 90px", textAlign: "right" } },
                      { label: "Method", style: { flex: "0 0 70px" } },
                      { label: "Status", style: { flex: "0 0 130px" } },
                      { label: "Txn / Check #", style: { flex: "1 0 110px" } },
                      { label: "Paid Date", style: { flex: "0 0 85px" } },
                      { label: "QBO", style: { flex: "0 0 80px" } },
                    ].map((col) => (
                      <div key={col.label} style={{ ...col.style, fontSize: "11px", fontWeight: 600, color: "#6d7175", textTransform: "uppercase" }}>
                        {col.label}
                      </div>
                    ))}
                    <div style={{ flex: "0 0 auto" }} />
                  </div>
                  {detail.practitionerPayouts.map((p) => (
                    <PractitionerRow key={p.id} p={p} items={detail.items} actionFetcher={actionFetcher} />
                  ))}
                </>
              )}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "24px", padding: "10px 16px", background: "#f9fafb", borderTop: "1px solid #e1e3e5", fontSize: "13px" }}>
                <span style={{ color: "#6d7175" }}>{detail.totalCommissions} commission{detail.totalCommissions !== 1 ? "s" : ""}</span>
                <span style={{ color: "#6d7175" }}>{(detail.practitionerPayouts || []).length} practitioner{(detail.practitionerPayouts || []).length !== 1 ? "s" : ""}</span>
                <strong style={{ color: "#202223" }}>Total: {formatCurrency(detail.totalAmount)}</strong>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── CheckPayoutCard ───────────────────────────────────────────────────────────

function CheckPayoutCard({ payout }) {
  const [expanded, setExpanded] = useState(false);
  const [commissions, setCommissions] = useState(null);
  const [checkNumber, setCheckNumber] = useState(payout.checkDetails?.checkNumber || "");
  const [checkDate, setCheckDate] = useState(
    payout.checkDetails?.checkDate
      ? new Date(payout.checkDetails.checkDate).toISOString().slice(0, 10)
      : "",
  );
  const [notes, setNotes] = useState("");
  const shopify = useAppBridge();
  const loadFetcher = useFetcher();
  const actionFetcher = useFetcher();
  const handledRef = useRef(null);

  // Lazy-load commissions on expand
  useEffect(() => {
    if (!expanded || commissions || loadFetcher.state !== "idle") return;
    loadFetcher.load(`/app/cdo-program/payouts?payoutId=${payout.id}`);
  }, [expanded, commissions, loadFetcher.state, payout.id]);

  useEffect(() => {
    if (!loadFetcher.data) return;
    if (loadFetcher.data.type === "payout-commissions") {
      setCommissions(loadFetcher.data.commissions);
    }
  }, [loadFetcher.data]);

  // Toast + local state refresh after action
  useEffect(() => {
    if (!actionFetcher.data || actionFetcher.state !== "idle") return;
    if (handledRef.current === actionFetcher.data) return;
    handledRef.current = actionFetcher.data;
    if (actionFetcher.data.status === "success") {
      shopify?.toast?.show(actionFetcher.data.message || "Done");
      // Reload commissions to pick up paid status changes
      setCommissions(null);
    } else {
      shopify?.toast?.show(actionFetcher.data.message || "Action failed", { isError: true });
    }
  }, [actionFetcher.data, actionFetcher.state, shopify]);

  const submit = (payload, confirmText) => {
    if (confirmText && !confirm(confirmText)) return;
    actionFetcher.submit(payload, { method: "POST" });
  };

  const busy = actionFetcher.state !== "idle";
  const pendingOp = busy ? actionFetcher.formData?.get("_action") : null;
  const accent = PAYOUT_STATUS_ACCENT[payout.status] || "#c9cccf";
  const checkNum = payout.checkDetails?.checkNumber;

  return (
    <div style={{ border: "1px solid #e1e3e5", borderLeft: `3px solid ${accent}`, borderRadius: "8px", overflow: "hidden", background: "#fff" }}>
      {/* Header */}
      <div
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap",
          padding: "12px 16px", cursor: "pointer", userSelect: "none",
          background: expanded ? "#f9fafb" : "#fff",
          borderBottom: expanded ? "1px solid #e1e3e5" : "none",
        }}
      >
        {/* Practitioner */}
        <div style={{ flex: "1 1 180px", minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: "14px", color: "#202223", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {payout.practitionerName}
          </div>
          <div style={{ fontSize: "11px", color: "#8c9196", marginTop: "1px" }}>
            {payout.practitionerEmail}
            {payout.reference && <span style={{ color: "#c9cccf", marginLeft: "6px" }}>· {payout.reference}</span>}
          </div>
        </div>

        {/* Stats */}
        <div style={{ display: "flex", gap: "14px", alignItems: "center", flexWrap: "wrap" }}>
          <Stat label="Period" value={fmtPeriod(payout)} />
          <Divider />
          <Stat label="Orders" value={payout.commissionCount} />
          <Divider />
          <Stat label="Amount" value={formatCurrency(payout.amount, payout.currency)} />
        </div>

        {/* Badges */}
        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <StatusBadge status={payout.status} />
          <s-badge>Check</s-badge>
          <MigratedBadge migrated={payout.migrated} />
        </div>

        {/* Check # */}
        {checkNum && (
          <div style={{ fontSize: "12px", color: "#6d7175", fontFamily: "monospace" }}>
            #{checkNum}
          </div>
        )}

        {/* Paid date */}
        {payout.paidAt && (
          <div style={{ fontSize: "12px", color: "#6d7175" }}>
            {formatDate(payout.paidAt)}
          </div>
        )}

        <span style={{ fontSize: "12px", color: "#9ba0a5", marginLeft: "auto" }}>{expanded ? "▲" : "▼"}</span>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: "14px" }}>

          {/* Details strip */}
          <div style={{ display: "flex", gap: "0", flexWrap: "wrap", background: "#f9fafb", border: "1px solid #e1e3e5", borderRadius: "8px", overflow: "hidden" }}>
            {[
              { label: "Practitioner", value: payout.practitionerName },
              { label: "Period", value: fmtPeriod(payout) },
              { label: "Check Number", value: checkNum ? `#${checkNum}` : "—" },
              { label: "Check Date", value: payout.checkDetails?.checkDate ? formatDate(payout.checkDetails.checkDate) : "—" },
              { label: "Issued By", value: payout.checkDetails?.issuedBy || payout.approvedBy || "—" },
              { label: "Payment Date", value: payout.paidAt ? formatDateTime(payout.paidAt) : "—" },
            ].map((s, i, arr) => (
              <div key={s.label} style={{ flex: "1 0 130px", padding: "9px 14px", borderRight: i < arr.length - 1 ? "1px solid #e1e3e5" : "none" }}>
                <div style={{ fontSize: "10px", color: "#8c9196", textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "3px" }}>{s.label}</div>
                <div style={{ fontSize: "12px", fontWeight: 600, color: "#303030", wordBreak: "break-all" }}>{s.value}</div>
              </div>
            ))}
          </div>

          {/* Mark-as-Paid form for approved check payouts */}
          {(payout.status === "approved" || payout.status === "awaiting_approval" || payout.status === "draft") && (
            <div style={{ padding: "14px", background: "#f9fafb", border: "1px solid #e1e3e5", borderRadius: "8px" }}>
              <div style={{ fontSize: "12px", fontWeight: 600, color: "#202223", marginBottom: "10px" }}>
                {payout.status === "approved" ? "Record check payment" : "Actions"}
              </div>

              {/* Approve / Reject for awaiting_approval */}
              {(payout.status === "awaiting_approval" || payout.status === "draft") && (
                <div style={{ display: "flex", gap: "8px" }}>
                  <s-button variant="primary"
                    {...(busy && pendingOp === "approve" ? { loading: true } : {})}
                    onClick={() => submit({ _action: "approve", payoutId: payout.id })}>
                    Approve
                  </s-button>
                  <s-button variant="tertiary" tone="critical"
                    {...(busy && pendingOp === "reject" ? { loading: true } : {})}
                    onClick={() => submit({ _action: "reject", payoutId: payout.id }, `Reject check payout for ${payout.practitionerName}?`)}>
                    Reject
                  </s-button>
                </div>
              )}

              {/* Mark-as-paid form for approved */}
              {payout.status === "approved" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "10px" }}>
                    <div>
                      <div style={{ fontSize: "12px", fontWeight: 550, marginBottom: "4px" }}>Check Number</div>
                      <s-text-field
                        placeholder="e.g. 1042"
                        value={checkNumber}
                        onChange={(e) => setCheckNumber(e?.target?.value ?? "")}
                      />
                    </div>
                    <DateField label="Check Date" value={checkDate} onChange={setCheckDate} />
                    <div style={{ gridColumn: "1 / -1" }}>
                      <div style={{ fontSize: "12px", fontWeight: 550, marginBottom: "4px" }}>Notes (optional)</div>
                      <s-text-field
                        placeholder="e.g. Mailed to practitioner address"
                        value={notes}
                        onChange={(e) => setNotes(e?.target?.value ?? "")}
                      />
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <s-button
                      variant="primary"
                      {...(busy && pendingOp === "mark-check-paid" ? { loading: true } : {})}
                      onClick={() =>
                        submit(
                          { _action: "mark-check-paid", payoutId: payout.id, checkNumber, checkDate, notes },
                          `Mark check payout for ${payout.practitionerName} as paid? This settles all ${payout.commissionCount} commission(s).`,
                        )
                      }
                    >
                      Mark as Paid
                    </s-button>
                    <s-button variant="tertiary" tone="critical"
                      {...(busy && pendingOp === "reject" ? { loading: true } : {})}
                      onClick={() => submit({ _action: "reject", payoutId: payout.id }, `Reject check payout for ${payout.practitionerName}?`)}>
                      Reject
                    </s-button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Commission breakdown */}
          <div>
            <div style={{ fontSize: "11px", fontWeight: 600, color: "#6d7175", textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "8px" }}>
              Commission breakdown ({payout.commissionCount} order{payout.commissionCount !== 1 ? "s" : ""})
            </div>
            {loadFetcher.state !== "idle" && !commissions && (
              <div style={{ color: "#8c9196", fontSize: "13px", padding: "8px 0" }}>Loading commissions…</div>
            )}
            {commissions && <CommissionsTable commissions={commissions} />}
          </div>

          {/* Check notes */}
          {payout.checkDetails?.notes && (
            <div style={{ fontSize: "12px", color: "#6d7175" }}>
              <strong>Notes:</strong> {payout.checkDetails.notes}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── CheckPayoutsSection ───────────────────────────────────────────────────────

function CheckPayoutsSection({ checkPayouts }) {
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    return checkPayouts.filter((p) => {
      if (statusFilter !== "all" && p.status !== statusFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          (p.practitionerName || "").toLowerCase().includes(q) ||
          (p.practitionerEmail || "").toLowerCase().includes(q) ||
          (p.checkDetails?.checkNumber || "").toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [checkPayouts, statusFilter, search]);

  const totalPaid = checkPayouts.filter((p) => p.status === "paid").reduce((s, p) => s + p.amount, 0);
  const pendingCount = checkPayouts.filter((p) => PAYOUT_ACTION_STATUSES.has(p.status)).length;

  return (
    <s-stack direction="block" gap="small-300">
      {/* Summary */}
      <div style={{ display: "flex", gap: "16px", padding: "10px 14px", background: "#f9fafb", border: "1px solid #e1e3e5", borderRadius: "8px" }}>
        <Stat label="Total check payouts" value={checkPayouts.length} />
        <Divider />
        <Stat label="Awaiting action" value={pendingCount || "0"} />
        <Divider />
        <Stat label="Total paid by check" value={formatCurrency(totalPaid)} />
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ flex: "1 0 200px" }}>
          <div style={{ fontSize: "12px", fontWeight: 550, marginBottom: "4px" }}>Search</div>
          <s-text-field
            placeholder="Practitioner or check #"
            value={search}
            onChange={(e) => setSearch(e?.target?.value ?? "")}
          />
        </div>
        <div style={{ flex: "0 0 180px" }}>
          <s-select
            label="Status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e?.target?.value ?? "all")}
          >
            <s-option value="all">All statuses</s-option>
            <s-option value="draft">Draft</s-option>
            <s-option value="awaiting_approval">Awaiting Approval</s-option>
            <s-option value="approved">Approved</s-option>
            <s-option value="paid">Paid</s-option>
            <s-option value="rejected">Rejected</s-option>
            <s-option value="cancelled">Cancelled</s-option>
          </s-select>
        </div>
        {(search || statusFilter !== "all") && (
          <s-button variant="tertiary" onClick={() => { setSearch(""); setStatusFilter("all"); }}>
            Clear
          </s-button>
        )}
        {(search || statusFilter !== "all") && (
          <span style={{ fontSize: "12px", color: "#8c9196", alignSelf: "center" }}>
            {filtered.length} of {checkPayouts.length}
          </span>
        )}
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 16px" }}>
          <div style={{ fontSize: "28px", marginBottom: "10px", opacity: 0.35 }}>✉️</div>
          <div style={{ fontWeight: 600, fontSize: "14px", color: "#303030" }}>
            {search || statusFilter !== "all" ? "No check payouts match the filters" : "No check payouts yet"}
          </div>
        </div>
      ) : (
        filtered.map((p) => <CheckPayoutCard key={p.id} payout={p} />)
      )}
    </s-stack>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CdoPayouts() {
  const { batches, checkPayouts } = useLoaderData();
  const shopify = useAppBridge();
  const genFetcher = useFetcher();
  const revalidator = useRevalidator();
  const handledRef = useRef(null);
  const [activeTab, setActiveTab] = useState("batches");

  // Filter state (batches tab)
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");

  const filteredBatches = useMemo(() => {
    if (!batches) return [];
    return batches.filter((b) => {
      if (statusFilter !== "all" && b.status !== statusFilter) return false;
      if (dateFrom || dateTo) {
        const d = b.executionTime ? new Date(b.executionTime) : null;
        if (!d) return false;
        if (dateFrom && d < new Date(dateFrom)) return false;
        if (dateTo && d > new Date(dateTo + "T23:59:59")) return false;
      }
      if (search) {
        const q = search.toLowerCase();
        if (!(b.reference || "").toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [batches, statusFilter, dateFrom, dateTo, search]);

  const hasFilters = statusFilter !== "all" || dateFrom || dateTo || search;

  // Toast on generate-batch
  useEffect(() => {
    if (!genFetcher.data || genFetcher.state !== "idle") return;
    if (handledRef.current === genFetcher.data) return;
    handledRef.current = genFetcher.data;
    if (genFetcher.data.status === "success") {
      shopify?.toast?.show(genFetcher.data.message || "Batch generated");
      revalidator.revalidate();
    } else {
      shopify?.toast?.show(genFetcher.data.message || "Failed", { isError: true });
    }
  }, [genFetcher.data, genFetcher.state, shopify, revalidator]);

  const onGenerate = () => {
    if (!confirm("Generate payout batch from all eligible approved commissions (up to today)?")) return;
    genFetcher.submit({ _action: "generate-batch" }, { method: "POST" });
  };

  const totalBatchPaid = (batches || []).filter((b) => b.status === "completed").reduce((s, b) => s + b.totalAmount, 0);
  const checkPendingCount = (checkPayouts || []).filter((p) => PAYOUT_ACTION_STATUSES.has(p.status)).length;

  const TAB = [
    { key: "batches", label: `ACH Batches (${(batches || []).length})` },
    { key: "check", label: `Check Payments (${(checkPayouts || []).length})${checkPendingCount > 0 ? ` · ${checkPendingCount} pending` : ""}` },
  ];

  return (
    <s-stack direction="block" gap="base">
      {/* Header */}
      <s-section padding="base">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px", flexWrap: "wrap" }}>
          <div style={{ flex: 1 }}>
            <s-paragraph tone="subdued">
              Commission payouts are maintained as batch-wise (ACH bank transfers) and practitioner-wise
              (check payments). Expand a batch to view per-practitioner breakdown and drill into individual
              orders. Check payments can be approved and recorded with a check number directly below.
            </s-paragraph>
            <div style={{ display: "flex", gap: "16px", marginTop: "12px", padding: "10px 14px", background: "#f9fafb", border: "1px solid #e1e3e5", borderRadius: "8px" }}>
              <Stat label="ACH batches" value={(batches || []).length} />
              <Divider />
              <Stat label="Check payouts" value={(checkPayouts || []).length} />
              <Divider />
              <Stat label="Check pending" value={checkPendingCount || "0"} />
              <Divider />
              <Stat label="All-time ACH paid" value={formatCurrency(totalBatchPaid)} />
            </div>
          </div>
          <s-button variant="primary"
            {...(genFetcher.state !== "idle" ? { loading: true } : {})}
            onClick={onGenerate}>
            Generate payout batch
          </s-button>
        </div>
      </s-section>

      {/* Tab switcher */}
      <div style={{ display: "flex", gap: "0", borderBottom: "2px solid #e1e3e5" }}>
        {TAB.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            style={{
              padding: "10px 20px",
              border: "none",
              borderBottom: activeTab === t.key ? "2px solid #303030" : "2px solid transparent",
              marginBottom: "-2px",
              background: "none",
              fontWeight: activeTab === t.key ? 700 : 400,
              fontSize: "13px",
              color: activeTab === t.key ? "#202223" : "#6d7175",
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        ))}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", paddingRight: "4px" }}>
          <s-button variant="tertiary" icon="refresh"
            {...(revalidator.state !== "idle" ? { loading: true } : {})}
            onClick={() => revalidator.revalidate()}>
            Refresh
          </s-button>
        </div>
      </div>

      {/* ── ACH BATCHES TAB ── */}
      {activeTab === "batches" && (
        <s-stack direction="block" gap="small-300">
          {/* Filters */}
          <s-section heading="Filters">
            <s-stack direction="block" gap="small-300">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px" }}>
                <DateField label="From date" value={dateFrom} onChange={setDateFrom} />
                <DateField label="To date" value={dateTo} onChange={setDateTo} />
                <s-select label="Batch status" value={statusFilter}
                  onChange={(e) => setStatusFilter(e?.target?.value ?? "all")}>
                  <s-option value="all">All statuses</s-option>
                  <s-option value="running">Running</s-option>
                  <s-option value="completed">Completed</s-option>
                  <s-option value="completed_with_errors">Partial (with errors)</s-option>
                  <s-option value="failed">Failed</s-option>
                </s-select>
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <span style={{ fontSize: "13px", fontWeight: 550 }}>Search batch ID</span>
                  <s-text-field placeholder="CDOB-…" value={search}
                    onChange={(e) => setSearch(e?.target?.value ?? "")} />
                </div>
              </div>
              {hasFilters && (
                <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                  {dateFrom && <s-tag onRemove={() => setDateFrom("")}>From: {dateFrom}</s-tag>}
                  {dateTo && <s-tag onRemove={() => setDateTo("")}>To: {dateTo}</s-tag>}
                  {statusFilter !== "all" && <s-tag onRemove={() => setStatusFilter("all")}>Status: {BATCH_STATUS_LABEL[statusFilter] || statusFilter}</s-tag>}
                  {search && <s-tag onRemove={() => setSearch("")}>ID: {search}</s-tag>}
                  <s-button variant="tertiary" onClick={() => { setDateFrom(""); setDateTo(""); setStatusFilter("all"); setSearch(""); }}>
                    Clear all
                  </s-button>
                  <span style={{ fontSize: "12px", color: "#8c9196" }}>
                    {filteredBatches.length} of {(batches || []).length} batch{(batches || []).length !== 1 ? "es" : ""}
                  </span>
                </div>
              )}
            </s-stack>
          </s-section>

          {/* Batch list */}
          <s-section>
            <div style={{ marginBottom: "12px", fontSize: "13px", color: "#6d7175" }}>
              {filteredBatches.length} batch{filteredBatches.length !== 1 ? "es" : ""} — expand to view practitioners and orders
            </div>
            <s-stack direction="block" gap="small-200">
              {filteredBatches.length === 0 ? (
                <div style={{ textAlign: "center", padding: "56px 16px" }}>
                  <div style={{ fontSize: "32px", marginBottom: "12px", opacity: 0.35 }}>📦</div>
                  <div style={{ fontWeight: 600, fontSize: "14px", color: "#303030", marginBottom: "4px" }}>
                    {hasFilters ? "No batches match the filters" : "No payout batches yet"}
                  </div>
                  <div style={{ color: "#8c9196", fontSize: "13px" }}>
                    {hasFilters
                      ? "Clear the filters to see all batches."
                      : 'Click "Generate payout batch" above to process eligible commissions.'}
                  </div>
                </div>
              ) : (
                filteredBatches.map((batch) => <BatchCard key={batch.id} batch={batch} />)
              )}
            </s-stack>
          </s-section>
        </s-stack>
      )}

      {/* ── CHECK PAYMENTS TAB ── */}
      {activeTab === "check" && (
        <s-section heading="Check Payment Payouts">
          <CheckPayoutsSection checkPayouts={checkPayouts || []} />
        </s-section>
      )}
    </s-stack>
  );
}
