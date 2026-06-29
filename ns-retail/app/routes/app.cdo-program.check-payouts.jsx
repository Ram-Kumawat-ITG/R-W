/* eslint-disable react/prop-types */
import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { CollapsibleSection } from "../components/ui";
import {
  listCheckPayoutPractitioners,
  voidCheckPreferredPayouts,
  approvePayout,
  rejectPayout,
  markCheckPayoutPaid,
  buildPayoutBatch,
  setCheckPayoutCronOverride,
} from "../services/cdo/cdo.service";
import StatusBadge from "../components/cdo/StatusBadge";
import MetricCard from "../components/cdo/MetricCard";
import { formatCurrency, formatDate, formatDateTime } from "../utils/format";

// ── loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  // Cancel any stale CRON-created payouts for check-preferred practitioners
  // and release their commissions back to the manual queue. Runs on every
  // page load so legacy payouts are cleaned up immediately without waiting
  // for the next CRON cycle.
  await voidCheckPreferredPayouts();
  const rows = await listCheckPayoutPractitioners();
  return { rows };
};

// ── action ────────────────────────────────────────────────────────────────────

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const actor =
    session?.onlineAccessInfo?.associated_user?.email || session?.shop || "admin";

  const formData = await request.formData();
  const op = String(formData.get("_action") || "").trim();
  const payoutId = formData.get("payoutId");
  const practitionerId = formData.get("practitionerId");

  try {
    switch (op) {
      case "approve": {
        const p = await approvePayout(payoutId, actor);
        return {
          status: "success",
          op,
          message: `Check payout approved for ${p.practitionerName || p.practitionerEmail || payoutId}`,
        };
      }
      case "reject": {
        const p = await rejectPayout(payoutId, actor, formData.get("reason") || "");
        return {
          status: "success",
          op,
          message: `Rejected check payout ${p.reference || ""}`.trim(),
        };
      }
      case "mark-check-paid": {
        const checkNumber = String(formData.get("checkNumber") || "").trim();
        const checkDate = String(formData.get("checkDate") || "").trim();
        const notes = String(formData.get("notes") || "").trim();
        if (!checkNumber) return { status: "error", op, message: "Check number is required" };
        if (!checkDate) return { status: "error", op, message: "Check date is required" };
        const p = await markCheckPayoutPaid(payoutId, { checkNumber, checkDate, notes, actor });
        return {
          status: "success",
          op,
          message: `Check #${checkNumber} marked paid — ${formatCurrency(p.amount || 0, p.currency)} to ${p.practitionerName || p.practitionerEmail}`,
        };
      }
      case "issue-check": {
        // Combined: create batch → auto-approve → mark paid, all in one admin action.
        if (!practitionerId) return { status: "error", op, message: "Practitioner id is required" };
        const checkNumber = String(formData.get("checkNumber") || "").trim();
        const checkDate = String(formData.get("checkDate") || "").trim();
        const notes = String(formData.get("notes") || "").trim();
        if (!checkNumber) return { status: "error", op, message: "Check number is required" };
        if (!checkDate) return { status: "error", op, message: "Check date is required" };

        // Admin may have deselected some commissions — only batch the selected ones.
        const onlyCommissionIds = formData.getAll("commissionIds").filter(Boolean);
        if (onlyCommissionIds.length === 0) {
          return { status: "error", op, message: "Select at least one commission to include." };
        }

        const result = await buildPayoutBatch({ practitionerId, actor, onlyCommissionIds });
        if (result.created.length === 0) {
          const skip = result.skipped[0];
          return {
            status: "error",
            op,
            message:
              skip?.reason === "open_payout_exists"
                ? "An open payout already exists for this practitioner — approve or mark it paid first."
                : skip?.reason === "below_minimum"
                  ? `Below minimum payout amount ($${(skip.minAmount || 0).toFixed(2)}).`
                  : "No eligible commissions to batch.",
          };
        }
        const newPayout = result.created[0];
        const payoutIdStr = String(newPayout._id);
        await approvePayout(payoutIdStr, actor);
        const paid = await markCheckPayoutPaid(payoutIdStr, { checkNumber, checkDate, notes, actor });
        return {
          status: "success",
          op,
          message: `Check #${checkNumber} issued — ${formatCurrency(paid.amount || 0, paid.currency || "USD")} to ${paid.practitionerName || paid.practitionerEmail}`,
        };
      }
      case "set-cron-override": {
        if (!practitionerId) return { status: "error", op, message: "Practitioner id is required" };
        const override = formData.get("override") === "true";
        const note = String(formData.get("note") || "").trim();
        await setCheckPayoutCronOverride(practitionerId, override, actor, note);
        return {
          status: "success",
          op,
          message: override
            ? "CRON override enabled — this practitioner will be included in automated ACH payouts."
            : "CRON override cleared — this practitioner returns to the check payout queue.",
        };
      }
      default:
        return { status: "error", op, message: `Unknown action: ${op}` };
    }
  } catch (e) {
    console.error(`[cdo-program/check-payouts] action ${op} failed:`, e?.message || e);
    return { status: "error", op, message: e?.message || "Action failed" };
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(rate) {
  if (!rate) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

// Initials avatar for the practitioner card header
function Avatar({ name }) {
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
  return (
    <div style={{
      width: "38px", height: "38px", borderRadius: "50%", flexShrink: 0,
      background: "#f0f4ff", border: "1px solid #c9d7f8",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontWeight: 700, fontSize: "13px", color: "#2c5ee8", letterSpacing: "0.5px",
    }}>
      {initials || "?"}
    </div>
  );
}

// Native date picker — s-text-field does not forward type="date" to its
// underlying input, so we use a plain input element styled to match Polaris.
function DateField({ label, value, onChange }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <span style={{ fontSize: "13px", fontWeight: 550, color: "var(--p-color-text)" }}>
        {label}
      </span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: "7px 12px",
          border: "1px solid var(--p-color-border, #919191)",
          borderRadius: "8px",
          fontSize: "14px",
          color: "var(--p-color-text)",
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

// ── Practitioner card ─────────────────────────────────────────────────────────

const STATUS_ACCENT = {
  approved: "#00a47c",
  awaiting_approval: "#b98900",
  draft: "#b98900",
  paid: "#8c9196",
  rejected: "#d72c0d",
  cancelled: "#8c9196",
};

function PractitionerCard({
  row,
  defaultExpanded,
  approveFetcher,
  onOpenMarkPaid,
  onOpenReject,
  onOpenGenerate,
  onOpenOverride,
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const approvingThis =
    approveFetcher.state !== "idle" &&
    approveFetcher.formData?.get("payoutId") === row.currentPayoutId;

  const noPayoutYet = !row.currentPayoutId;
  const canApprove = ["awaiting_approval", "draft"].includes(row.currentPayoutStatus || "");
  const canMarkPaid = row.currentPayoutStatus === "approved";
  const accent = STATUS_ACCENT[row.currentPayoutStatus] || "#c9cccf";

  return (
    <div style={{
      background: "#fff",
      border: "1px solid #e1e3e5",
      borderRadius: "8px",
      overflow: "hidden",
      borderLeft: `3px solid ${accent}`,
    }}>
      {/* Clickable header */}
      <div
        onClick={() => setExpanded((v) => !v)}
        style={{
          padding: "14px 18px",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: "14px",
          background: expanded ? "#f9fafb" : "#fff",
          borderBottom: expanded ? "1px solid #e1e3e5" : "none",
          userSelect: "none",
        }}
      >
        <Avatar name={row.name} />

        {/* Name + email + badges */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600, fontSize: "14px", color: "#303030" }}>{row.name}</span>
            <s-badge>Check</s-badge>
            {row.cronOverride && <s-badge tone="warning">CRON Override</s-badge>}
            {row.currentPayoutStatus ? (
              <StatusBadge status={row.currentPayoutStatus} />
            ) : (
              <s-badge tone="info">No Active Batch</s-badge>
            )}
          </div>
          <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "3px" }}>
            {row.email}
            {row.checkPayableTo && row.checkPayableTo !== row.name && (
              <span style={{ marginLeft: "12px" }}>
                Payable to: <strong style={{ color: "#303030" }}>{row.checkPayableTo}</strong>
              </span>
            )}
          </div>
        </div>

        {/* Inline stats */}
        <div style={{ display: "flex", gap: "28px", alignItems: "center", flexShrink: 0 }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: "11px", color: "#6d7175", marginBottom: "1px" }}>Orders</div>
            <div style={{ fontWeight: 600, fontSize: "13px", color: "#303030" }}>
              {row.upcomingOrderCount || 0}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: "11px", color: "#6d7175", marginBottom: "1px" }}>Total Sales</div>
            <div style={{ fontWeight: 600, fontSize: "13px", color: "#303030" }}>
              {row.totalSales > 0 ? formatCurrency(row.totalSales, "USD") : "—"}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: "11px", color: "#6d7175", marginBottom: "1px" }}>Pending Check</div>
            <div style={{
              fontWeight: 700, fontSize: "14px",
              color: row.upcomingPayoutAmount > 0 ? "#00a47c" : "#8c9196",
            }}>
              {row.upcomingPayoutAmount > 0 ? formatCurrency(row.upcomingPayoutAmount, "USD") : "—"}
            </div>
          </div>
          <span style={{ fontSize: "14px", color: "#9ba0a5", marginLeft: "4px" }}>
            {expanded ? "▲" : "▼"}
          </span>
        </div>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div style={{ padding: "16px 18px" }}>
          <s-stack direction="block" gap="base">
            {/* All-time summary strip */}
            <div style={{
              display: "flex", gap: "24px", flexWrap: "wrap",
              padding: "10px 14px", background: "#f9fafb",
              borderRadius: "6px", fontSize: "12px", color: "#6d7175",
            }}>
              <span>
                Total earned:{" "}
                <strong style={{ color: "#303030" }}>{formatCurrency(row.totalCommission, "USD")}</strong>
              </span>
              <span>
                Total paid:{" "}
                <strong style={{ color: "#303030" }}>{formatCurrency(row.totalPaid, "USD")}</strong>
              </span>
              {row.currentPayoutReference && (
                <span>
                  Active ref:{" "}
                  <strong style={{ color: "#303030" }}>{row.currentPayoutReference}</strong>
                </span>
              )}
            </div>

            {/* Warnings */}
            {row.cronOverride && (
              <s-banner tone="warning">
                <s-paragraph>
                  <strong>CRON Override Active</strong> — Next automated run will include this
                  practitioner as ACH. Set by {row.cronOverrideSetBy || "admin"}.
                  {row.cronOverrideNote && ` "${row.cronOverrideNote}"`}
                </s-paragraph>
              </s-banner>
            )}
            {row.currentPayoutBankingError && (
              <s-banner tone="critical">
                <s-paragraph>Banking issue: {row.currentPayoutBankingError}</s-paragraph>
              </s-banner>
            )}

            {/* Actions */}
            <div style={{
              display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center",
              paddingBottom: "4px", borderBottom: "1px solid #f1f2f3",
            }}>
              {noPayoutYet && (
                <s-button
                  variant="primary"
                  onClick={() => onOpenGenerate(row.id, row.name, row.upcomingPayoutAmount, row.orders)}
                >
                  Issue Check
                </s-button>
              )}
              {canApprove && (
                <>
                  <s-button
                    variant="primary"
                    {...(approvingThis ? { loading: true } : {})}
                    onClick={() =>
                      approveFetcher.submit(
                        { _action: "approve", payoutId: row.currentPayoutId },
                        { method: "POST" },
                      )
                    }
                  >
                    Approve
                  </s-button>
                  <s-button
                    variant="secondary"
                    tone="critical"
                    onClick={() => onOpenReject(row.currentPayoutId, row.name)}
                  >
                    Reject
                  </s-button>
                </>
              )}
              {canMarkPaid && (
                <s-button
                  variant="primary"
                  onClick={() => onOpenMarkPaid(row.currentPayoutId, row.name, row.upcomingPayoutAmount)}
                >
                  Mark as Paid
                </s-button>
              )}
              <div style={{ flex: 1 }} />
              <s-button
                variant="tertiary"
                onClick={() => onOpenOverride(row.id, row.name, row.cronOverride, row.cronOverrideNote)}
              >
                {row.cronOverride ? "Clear CRON Override" : "Override to CRON"}
              </s-button>
            </div>

            {/* Orders sub-section */}
            {row.orders.length > 0 && (
              <CollapsibleSection
                heading={`Orders included in payout (${row.orders.length})`}
                storageKey={`cpq-orders-${row.id}`}
              >
                <s-table>
                  <s-table-header-row>
                    <s-table-header>Order</s-table-header>
                    <s-table-header>Date</s-table-header>
                    <s-table-header>Order Amount</s-table-header>
                    <s-table-header>Rate</s-table-header>
                    <s-table-header>Commission</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {row.orders.map((o) => (
                      <s-table-row key={o.commissionId}>
                        <s-table-cell>{o.orderName}</s-table-cell>
                        <s-table-cell>{o.orderDate ? formatDate(o.orderDate) : "—"}</s-table-cell>
                        <s-table-cell>
                          {o.orderAmount != null
                            ? formatCurrency(o.orderAmount, o.currency || "USD")
                            : "—"}
                        </s-table-cell>
                        <s-table-cell>{pct(o.commissionRate)}</s-table-cell>
                        <s-table-cell>
                          <strong>{formatCurrency(o.commissionAmount, "USD")}</strong>
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
                <div style={{ textAlign: "right", padding: "8px 0", fontSize: "13px", color: "#6d7175" }}>
                  {row.orders.length} order{row.orders.length === 1 ? "" : "s"} ·{" "}
                  <strong style={{ color: "#303030" }}>
                    Total: {formatCurrency(row.upcomingPayoutAmount, "USD")}
                  </strong>
                </div>
              </CollapsibleSection>
            )}

            {/* Payout history sub-section */}
            {row.recentPayouts.length > 0 && (
              <CollapsibleSection
                heading={`Payout history (${row.recentPayouts.length})`}
                storageKey={`cpq-history-${row.id}`}
              >
                <s-table>
                  <s-table-header-row>
                    <s-table-header>Date</s-table-header>
                    <s-table-header>Status</s-table-header>
                    <s-table-header>Amount</s-table-header>
                    <s-table-header>Check #</s-table-header>
                    <s-table-header>Reference</s-table-header>
                    <s-table-header>Issued By</s-table-header>
                    <s-table-header>Notes</s-table-header>
                    <s-table-header>QBO Bill</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {row.recentPayouts.map((rp) => (
                      <s-table-row key={rp.id}>
                        <s-table-cell>{rp.paidAt ? formatDate(rp.paidAt) : "—"}</s-table-cell>
                        <s-table-cell><StatusBadge status={rp.status} /></s-table-cell>
                        <s-table-cell>{formatCurrency(rp.amount, "USD")}</s-table-cell>
                        <s-table-cell>{rp.checkNumber ? `#${rp.checkNumber}` : "—"}</s-table-cell>
                        <s-table-cell>{rp.reference || "—"}</s-table-cell>
                        <s-table-cell>{rp.issuedBy || "—"}</s-table-cell>
                        <s-table-cell>
                          {rp.notes ? <s-text tone="subdued">{rp.notes}</s-text> : "—"}
                        </s-table-cell>
                        <s-table-cell>
                          {rp.qboBillId ? (
                            <s-stack direction="block" gap="none">
                              <s-text tone="subdued" variant="bodySm">Bill #{rp.qboBillId}</s-text>
                              {rp.qboBillPaymentId && (
                                <s-text tone="subdued" variant="bodySm">Pmt #{rp.qboBillPaymentId}</s-text>
                              )}
                            </s-stack>
                          ) : (
                            <s-badge tone="warning">Pending</s-badge>
                          )}
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              </CollapsibleSection>
            )}

            {/* Audit trail */}
            {row.currentPayoutRemarks?.length > 0 && (
              <CollapsibleSection
                heading="Audit trail"
                storageKey={`cpq-audit-${row.id}`}
              >
                <s-table>
                  <s-table-header-row>
                    <s-table-header>Timestamp</s-table-header>
                    <s-table-header>Event</s-table-header>
                    <s-table-header>Details</s-table-header>
                    <s-table-header>Actor</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {[...row.currentPayoutRemarks].reverse().map((rem, i) => (
                      <s-table-row key={i}>
                        <s-table-cell>{formatDateTime(rem.createdAt)}</s-table-cell>
                        <s-table-cell>
                          <s-text tone="subdued">{rem.kind}</s-text>
                        </s-table-cell>
                        <s-table-cell>{rem.message}</s-table-cell>
                        <s-table-cell>{rem.actor || "—"}</s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              </CollapsibleSection>
            )}
          </s-stack>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CheckPayouts() {
  const { rows } = useLoaderData();
  const shopify = useAppBridge();

  // One fetcher per action type so each can track its own loading state
  const approveFetcher = useFetcher();
  const rejectFetcher = useFetcher();
  const markPaidFetcher = useFetcher();
  const generateFetcher = useFetcher();
  const overrideFetcher = useFetcher();

  // Idempotency refs — prevent double-firing effects on re-renders
  const approveHandled = useRef(null);
  const rejectHandled = useRef(null);
  const markPaidHandled = useRef(null);
  const generateHandled = useRef(null);
  const overrideHandled = useRef(null);

  // Modal refs
  const markPaidModalRef = useRef(null);
  const rejectModalRef = useRef(null);
  const generateModalRef = useRef(null);
  const overrideModalRef = useRef(null);

  // Modal target state
  // Modal target state (payload for the open modal)
  const [markPaidTarget, setMarkPaidTarget] = useState(null);
  const [rejectTarget, setRejectTarget] = useState(null);
  const [generateTarget, setGenerateTarget] = useState(null);
  const [overrideTarget, setOverrideTarget] = useState(null);

  // Modal form field state
  const [checkNumber, setCheckNumber] = useState("");
  const [checkDate, setCheckDate] = useState("");
  const [checkNotes, setCheckNotes] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [overrideNote, setOverrideNote] = useState("");

  // Per-commission selection for Issue Check modal (Set of commissionId strings)
  const [selectedCommIds, setSelectedCommIds] = useState(new Set());

  // ── Modal open helpers ──────────────────────────────────────────────────────

  const openMarkPaid = (payoutId, name, amount) => {
    setMarkPaidTarget({ payoutId, name, amount });
    setCheckNumber("");
    setCheckDate("");
    setCheckNotes("");
    markPaidModalRef.current?.showOverlay?.();
  };

  const openReject = (payoutId, name) => {
    setRejectTarget({ payoutId, name });
    setRejectReason("");
    rejectModalRef.current?.showOverlay?.();
  };

  const openGenerate = (practitionerId, name, amount, orders) => {
    const orderList = orders || [];
    setGenerateTarget({ practitionerId, name, amount, orders: orderList });
    setSelectedCommIds(new Set(orderList.map((o) => o.commissionId)));
    setCheckNumber("");
    setCheckDate("");
    setCheckNotes("");
    generateModalRef.current?.showOverlay?.();
  };

  const openOverride = (practitionerId, name, currentOverride, note) => {
    setOverrideTarget({ practitionerId, name, currentOverride });
    setOverrideNote(note || "");
    overrideModalRef.current?.showOverlay?.();
  };

  // ── Fetcher effects ─────────────────────────────────────────────────────────

  useEffect(() => {
    const d = approveFetcher.data;
    if (!d || approveFetcher.state !== "idle") return;
    if (approveHandled.current === d) return;
    approveHandled.current = d;
    shopify?.toast?.show(d.message || (d.status === "success" ? "Approved" : "Failed"), {
      isError: d.status !== "success",
    });
  }, [approveFetcher.data, approveFetcher.state, shopify]);

  useEffect(() => {
    const d = rejectFetcher.data;
    if (!d || rejectFetcher.state !== "idle") return;
    if (rejectHandled.current === d) return;
    rejectHandled.current = d;
    if (d.status === "success") {
      shopify?.toast?.show(d.message || "Payout rejected");
      rejectModalRef.current?.hideOverlay?.();
    } else {
      shopify?.toast?.show(d.message || "Failed to reject", { isError: true });
    }
  }, [rejectFetcher.data, rejectFetcher.state, shopify]);

  useEffect(() => {
    const d = markPaidFetcher.data;
    if (!d || markPaidFetcher.state !== "idle") return;
    if (markPaidHandled.current === d) return;
    markPaidHandled.current = d;
    if (d.status === "success") {
      shopify?.toast?.show(d.message || "Marked as paid");
      markPaidModalRef.current?.hideOverlay?.();
    } else {
      shopify?.toast?.show(d.message || "Failed", { isError: true });
    }
  }, [markPaidFetcher.data, markPaidFetcher.state, shopify]);

  useEffect(() => {
    const d = generateFetcher.data;
    if (!d || generateFetcher.state !== "idle") return;
    if (generateHandled.current === d) return;
    generateHandled.current = d;
    if (d.status === "success") {
      shopify?.toast?.show(d.message || "Check issued successfully");
      generateModalRef.current?.hideOverlay?.();
    } else {
      shopify?.toast?.show(d.message || "Failed to issue check", { isError: true });
    }
  }, [generateFetcher.data, generateFetcher.state, shopify]);

  useEffect(() => {
    const d = overrideFetcher.data;
    if (!d || overrideFetcher.state !== "idle") return;
    if (overrideHandled.current === d) return;
    overrideHandled.current = d;
    if (d.status === "success") {
      shopify?.toast?.show(d.message || "Override updated");
      overrideModalRef.current?.hideOverlay?.();
    } else {
      shopify?.toast?.show(d.message || "Failed", { isError: true });
    }
  }, [overrideFetcher.data, overrideFetcher.state, shopify]);

  // ── Summary stats ───────────────────────────────────────────────────────────

  const totalCommission = rows.reduce((sum, r) => sum + (r.totalCommission || 0), 0);
  const totalPending = rows.reduce((sum, r) => sum + (r.upcomingPayoutAmount || 0), 0);
  const awaitingApproval = rows.filter((r) =>
    ["draft", "awaiting_approval"].includes(r.currentPayoutStatus || ""),
  ).length;
  const readyToPay = rows.filter((r) => r.currentPayoutStatus === "approved").length;

  // ── Active vs settled split ─────────────────────────────────────────────────

  const active = rows.filter(
    (r) =>
      !r.currentPayoutStatus ||
      !["paid", "rejected", "cancelled"].includes(r.currentPayoutStatus) ||
      r.upcomingOrderCount > 0,
  );
  const settled = rows.filter(
    (r) =>
      ["paid", "rejected", "cancelled"].includes(r.currentPayoutStatus || "") &&
      r.upcomingOrderCount === 0,
  );

  const sharedCardProps = {
    approveFetcher,
    onOpenMarkPaid: openMarkPaid,
    onOpenReject: openReject,
    onOpenGenerate: openGenerate,
    onOpenOverride: openOverride,
  };

  return (
    <s-page inlineSize="large" heading="Check Payout Queue">
      <s-stack direction="block" gap="base">

        {/* Stats header — matches UpcomingPayoutSummary style from Payout Batches */}
        <div style={{ border: "1px solid #e1e3e5", borderRadius: "8px", overflow: "hidden" }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "12px 20px", background: "#f6f6f7", borderBottom: "1px solid #e1e3e5",
          }}>
            <span style={{ fontWeight: 600, fontSize: "14px", color: "#303030" }}>
              Queue Summary
            </span>
            <span style={{ fontSize: "12px", color: "#6d7175" }}>
              Practitioners opting for physical check — excluded from automated ACH CRON
            </span>
          </div>
          <div style={{ padding: "16px 20px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "12px" }}>
              <MetricCard
                label="Practitioners"
                value={String(rows.length)}
                sublabel="in check queue"
              />
              <MetricCard
                label="Total Earned"
                value={formatCurrency(totalCommission, "USD")}
                sublabel="all-time commissions"
              />
              <MetricCard
                label="Pending Payout"
                value={formatCurrency(totalPending, "USD")}
                tone={totalPending > 0 ? "warning" : undefined}
                sublabel={totalPending > 0 ? "unbatched & owed" : "none outstanding"}
              />
              <MetricCard
                label="Awaiting Approval"
                value={String(awaitingApproval)}
                tone={awaitingApproval > 0 ? "warning" : undefined}
                sublabel={awaitingApproval > 0 ? "batches pending review" : "queue clear"}
              />
              <MetricCard
                label="Ready to Pay"
                value={String(readyToPay)}
                tone={readyToPay > 0 ? "success" : undefined}
                sublabel={readyToPay > 0 ? "approved — issue check" : "none approved yet"}
              />
            </div>
          </div>
        </div>

        {/* Active queue */}
        <div style={{ border: "1px solid #e1e3e5", borderRadius: "8px", overflow: "hidden" }}>
          <div style={{
            padding: "12px 20px", background: "#f6f6f7", borderBottom: "1px solid #e1e3e5",
            display: "flex", alignItems: "center", gap: "8px",
          }}>
            <span style={{ fontWeight: 600, fontSize: "14px", color: "#303030" }}>
              Active Queue
            </span>
            <span style={{
              background: active.length > 0 ? "#2c5ee8" : "#8c9196",
              color: "#fff", borderRadius: "10px", padding: "1px 8px",
              fontSize: "11px", fontWeight: 600,
            }}>
              {active.length}
            </span>
          </div>
          <div style={{ padding: "16px 20px" }}>
            {active.length === 0 ? (
              <div style={{
                textAlign: "center", padding: "40px 16px",
                color: "#6d7175", fontSize: "13px",
              }}>
                No practitioners with pending check payouts.
                <br />
                <span style={{ fontSize: "12px" }}>
                  Check-preferred practitioners will appear here once they have eligible commissions.
                </span>
              </div>
            ) : (
              <s-stack direction="block" gap="small-200">
                {active.map((row, i) => (
                  <PractitionerCard
                    key={row.id}
                    row={row}
                    defaultExpanded={i === 0}
                    {...sharedCardProps}
                  />
                ))}
              </s-stack>
            )}
          </div>
        </div>

        {/* Completed / settled practitioners */}
        {settled.length > 0 && (
          <CollapsibleSection
            heading={`Completed (${settled.length})`}
            storageKey="cpq-completed"
          >
            <s-stack direction="block" gap="small-200">
              {settled.map((row) => (
                <PractitionerCard
                  key={row.id}
                  row={row}
                  defaultExpanded={false}
                  {...sharedCardProps}
                />
              ))}
            </s-stack>
          </CollapsibleSection>
        )}

        {/* ── Modals — inside s-page so the overlay renders correctly ─────── */}

        {/* Mark as Paid */}
        <s-modal
          ref={markPaidModalRef}
          id="cdo-mark-paid-modal"
          heading={`Mark as Paid — ${markPaidTarget?.name || ""}`}
          accessibilityLabel="Record check payment"
        >
          <s-stack direction="block" gap="base">
            {markPaidTarget && (
              <s-paragraph tone="subdued">
                Record the physical check issued to{" "}
                <strong>{markPaidTarget.name}</strong> for{" "}
                <strong>{formatCurrency(markPaidTarget.amount, "USD")}</strong>.
              </s-paragraph>
            )}
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-text-field
                label="Check Number *"
                placeholder="e.g. 1042"
                value={checkNumber}
                onInput={(e) => setCheckNumber(e.target.value)}
                onChange={(e) => setCheckNumber(e.target.value)}
              />
              <DateField
                label="Payment Date *"
                value={checkDate}
                onChange={setCheckDate}
              />
            </s-grid>
            <s-text-area
              label="Notes (optional)"
              placeholder="e.g. Mailed to 123 Main St via USPS"
              value={checkNotes}
              onInput={(e) => setCheckNotes(e.target.value)}
              onChange={(e) => setCheckNotes(e.target.value)}
            />
          </s-stack>
          <s-button
            slot="primary-action"
            variant="primary"
            {...(markPaidFetcher.state !== "idle" ? { loading: true } : {})}
            onClick={() => {
              if (!checkNumber.trim()) {
                shopify?.toast?.show("Check number is required", { isError: true });
                return;
              }
              if (!checkDate.trim()) {
                shopify?.toast?.show("Payment date is required", { isError: true });
                return;
              }
              markPaidFetcher.submit(
                {
                  _action: "mark-check-paid",
                  payoutId: markPaidTarget.payoutId,
                  checkNumber: checkNumber.trim(),
                  checkDate: checkDate.trim(),
                  notes: checkNotes.trim(),
                },
                { method: "POST" },
              );
            }}
          >
            Confirm — Mark as Paid
          </s-button>
          <s-button slot="secondary-actions" onClick={() => markPaidModalRef.current?.hideOverlay?.()}>
            Cancel
          </s-button>
        </s-modal>

        {/* Reject payout */}
        <s-modal
          ref={rejectModalRef}
          id="cdo-reject-modal"
          heading={`Reject Payout — ${rejectTarget?.name || ""}`}
          accessibilityLabel="Reject check payout"
        >
          <s-stack direction="block" gap="base">
            <s-paragraph tone="subdued">
              Rejecting will cancel this payout and release the commissions back to the eligible
              pool. This cannot be undone.
            </s-paragraph>
            <s-text-area
              label="Reason (optional)"
              placeholder="e.g. Incorrect banking info, practitioner request..."
              value={rejectReason}
              onInput={(e) => setRejectReason(e.target.value)}
              onChange={(e) => setRejectReason(e.target.value)}
            />
          </s-stack>
          <s-button
            slot="primary-action"
            variant="primary"
            tone="critical"
            {...(rejectFetcher.state !== "idle" ? { loading: true } : {})}
            onClick={() => {
              rejectFetcher.submit(
                {
                  _action: "reject",
                  payoutId: rejectTarget.payoutId,
                  reason: rejectReason.trim(),
                },
                { method: "POST" },
              );
            }}
          >
            Reject Payout
          </s-button>
          <s-button slot="secondary-actions" onClick={() => rejectModalRef.current?.hideOverlay?.()}>
            Cancel
          </s-button>
        </s-modal>

        {/* Issue Check — create batch + auto-approve + mark paid in one step */}
        <s-modal
          ref={generateModalRef}
          id="cdo-issue-check-modal"
          heading={`Issue Check — ${generateTarget?.name || ""}`}
          accessibilityLabel="Issue check payment"
        >
          {(() => {
            const orders = generateTarget?.orders || [];
            const allChecked = orders.length > 0 && orders.every((o) => selectedCommIds.has(o.commissionId));
            const someChecked = orders.some((o) => selectedCommIds.has(o.commissionId));
            const selectedTotal = orders
              .filter((o) => selectedCommIds.has(o.commissionId))
              .reduce((sum, o) => sum + (o.commissionAmount || 0), 0);
            const noneSelected = selectedCommIds.size === 0;

            return (
              <s-stack direction="block" gap="base">
                {/* Commission selection table */}
                {orders.length > 0 && (
                  <s-stack direction="block" gap="small-200">
                    {/* Header row with select-all */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <s-text variant="headingSm">
                        Select commissions to include
                      </s-text>
                      <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "#6d7175", cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={allChecked}
                          ref={(el) => { if (el) el.indeterminate = someChecked && !allChecked; }}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedCommIds(new Set(orders.map((o) => o.commissionId)));
                            } else {
                              setSelectedCommIds(new Set());
                            }
                          }}
                          style={{ width: "15px", height: "15px", cursor: "pointer" }}
                        />
                        {allChecked ? "Deselect all" : "Select all"}
                      </label>
                    </div>

                    <div style={{ border: "1px solid #e1e3e5", borderRadius: "8px", overflow: "hidden" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                        <thead>
                          <tr style={{ background: "#f6f6f7", borderBottom: "1px solid #e1e3e5" }}>
                            <th style={{ padding: "8px 12px", width: "36px" }}></th>
                            <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, color: "#6d7175" }}>Order</th>
                            <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, color: "#6d7175" }}>Date</th>
                            <th style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600, color: "#6d7175" }}>Order Amt</th>
                            <th style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600, color: "#6d7175" }}>Rate</th>
                            <th style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600, color: "#6d7175" }}>Commission</th>
                          </tr>
                        </thead>
                        <tbody>
                          {orders.map((o, i) => {
                            const checked = selectedCommIds.has(o.commissionId);
                            return (
                              <tr
                                key={o.commissionId}
                                style={{
                                  borderTop: i > 0 ? "1px solid #f1f2f3" : "none",
                                  background: checked ? "#fff" : "#fafafa",
                                  opacity: checked ? 1 : 0.55,
                                  cursor: "pointer",
                                }}
                                onClick={() => {
                                  setSelectedCommIds((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(o.commissionId)) next.delete(o.commissionId);
                                    else next.add(o.commissionId);
                                    return next;
                                  });
                                }}
                              >
                                <td style={{ padding: "9px 12px", textAlign: "center" }}>
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => {}}
                                    style={{ width: "14px", height: "14px", cursor: "pointer" }}
                                  />
                                </td>
                                <td style={{ padding: "9px 12px", fontWeight: 500 }}>{o.orderName}</td>
                                <td style={{ padding: "9px 12px", color: "#6d7175" }}>{o.orderDate ? formatDate(o.orderDate) : "—"}</td>
                                <td style={{ padding: "9px 12px", textAlign: "right" }}>
                                  {o.orderAmount != null ? formatCurrency(o.orderAmount, o.currency || "USD") : "—"}
                                </td>
                                <td style={{ padding: "9px 12px", textAlign: "right" }}>{pct(o.commissionRate)}</td>
                                <td style={{ padding: "9px 12px", textAlign: "right", fontWeight: 700, color: checked ? "#00a47c" : "#8c9196" }}>
                                  {formatCurrency(o.commissionAmount, "USD")}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot>
                          <tr style={{ borderTop: "2px solid #e1e3e5", background: "#f6f6f7" }}>
                            <td colSpan={5} style={{ padding: "9px 12px", fontWeight: 600, textAlign: "right", fontSize: "13px" }}>
                              {selectedCommIds.size} of {orders.length} selected — Check total:
                            </td>
                            <td style={{ padding: "9px 12px", textAlign: "right", fontWeight: 700, fontSize: "14px", color: noneSelected ? "#8c9196" : "#00a47c" }}>
                              {formatCurrency(selectedTotal, "USD")}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>

                    {noneSelected && (
                      <s-banner tone="warning">
                        <s-paragraph>Select at least one commission to issue a check.</s-paragraph>
                      </s-banner>
                    )}
                  </s-stack>
                )}

                <s-paragraph tone="subdued">
                  Issuing this check will create a <strong>QBO Vendor Bill and BillPayment</strong> for the
                  selected commissions and mark the payout as paid.
                </s-paragraph>

                <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                  <s-text-field
                    label="Check Number *"
                    placeholder="e.g. 1042"
                    value={checkNumber}
                    onInput={(e) => setCheckNumber(e.target.value)}
                    onChange={(e) => setCheckNumber(e.target.value)}
                  />
                  <DateField
                    label="Payment Date *"
                    value={checkDate}
                    onChange={setCheckDate}
                  />
                </s-grid>
                <s-text-area
                  label="Notes (optional)"
                  placeholder="e.g. Mailed to 123 Main St via USPS"
                  value={checkNotes}
                  onInput={(e) => setCheckNotes(e.target.value)}
                  onChange={(e) => setCheckNotes(e.target.value)}
                />
              </s-stack>
            );
          })()}
          <s-button
            slot="primary-action"
            variant="primary"
            {...(generateFetcher.state !== "idle" ? { loading: true } : {})}
            {...(selectedCommIds.size === 0 ? { disabled: true } : {})}
            onClick={() => {
              if (selectedCommIds.size === 0) return;
              if (!checkNumber.trim()) {
                shopify?.toast?.show("Check number is required", { isError: true });
                return;
              }
              if (!checkDate.trim()) {
                shopify?.toast?.show("Payment date is required", { isError: true });
                return;
              }
              const fd = new FormData();
              fd.append("_action", "issue-check");
              fd.append("practitionerId", generateTarget.practitionerId);
              fd.append("checkNumber", checkNumber.trim());
              fd.append("checkDate", checkDate.trim());
              fd.append("notes", checkNotes.trim());
              for (const id of selectedCommIds) {
                fd.append("commissionIds", id);
              }
              generateFetcher.submit(fd, { method: "POST" });
            }}
          >
            Issue Check{selectedCommIds.size > 0 ? ` (${selectedCommIds.size})` : ""}
          </s-button>
          <s-button slot="secondary-actions" onClick={() => generateModalRef.current?.hideOverlay?.()}>
            Cancel
          </s-button>
        </s-modal>

        {/* CRON override */}
        <s-modal
          ref={overrideModalRef}
          id="cdo-cron-override-modal"
          heading={overrideTarget?.currentOverride ? "Clear CRON Override" : "Override to CRON"}
          accessibilityLabel="Set CRON override"
        >
          <s-stack direction="block" gap="base">
            <s-paragraph tone="subdued">
              {overrideTarget?.currentOverride
                ? `Clearing the override will return ${overrideTarget?.name || "this practitioner"} to the check payout queue. Future CRON runs will skip them and they must be processed manually.`
                : `Enabling the override will include ${overrideTarget?.name || "this practitioner"} in the next automated payout CRON run as ACH (banking must be valid). Their check preference is not changed — only the next CRON batch is affected.`}
            </s-paragraph>
            <s-text-area
              label="Admin note (optional)"
              placeholder="Reason for override..."
              value={overrideNote}
              onInput={(e) => setOverrideNote(e.target.value)}
              onChange={(e) => setOverrideNote(e.target.value)}
            />
          </s-stack>
          <s-button
            slot="primary-action"
            variant="primary"
            {...(overrideTarget?.currentOverride ? { tone: "critical" } : {})}
            {...(overrideFetcher.state !== "idle" ? { loading: true } : {})}
            onClick={() => {
              overrideFetcher.submit(
                {
                  _action: "set-cron-override",
                  practitionerId: overrideTarget.practitionerId,
                  override: String(!overrideTarget.currentOverride),
                  note: overrideNote.trim(),
                },
                { method: "POST" },
              );
            }}
          >
            {overrideTarget?.currentOverride ? "Clear Override" : "Enable Override"}
          </s-button>
          <s-button slot="secondary-actions" onClick={() => overrideModalRef.current?.hideOverlay?.()}>
            Cancel
          </s-button>
        </s-modal>

      </s-stack>
    </s-page>
  );
}
