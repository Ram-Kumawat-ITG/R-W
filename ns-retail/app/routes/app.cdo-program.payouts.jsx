/* eslint-disable react/prop-types */
import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  listPayouts,
  accrueCommissionsForOrders,
  buildPayoutBatch,
  approvePayout,
  rejectPayout,
  executeApprovedPayout,
  checkPayoutSettlement,
} from "../services/cdo/cdo.service";
import DataTable from "../components/cdo/DataTable";
import StatusBadge from "../components/cdo/StatusBadge";
import { formatCurrency, formatDate } from "../utils/format";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const rows = await listPayouts();
  return { rows };
};

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
          return {
            status: "success",
            op,
            message: `Transfer initiated (${p.providerTransferId}) — awaiting settlement (1–3 business days). QBO Bill ${p.qboBillId}.`,
          };
        }
        if (p.status === "paid") {
          return {
            status: "success",
            op,
            message: `Payout settled — QBO Bill ${p.qboBillId}, payment ${p.qboBillPaymentId}`,
          };
        }
        return {
          status: "error",
          op,
          message: `Payout ${p.status}${p.lastError ? `: ${p.lastError}` : ""}`,
        };
      }
      case "check-settlement": {
        const res = await checkPayoutSettlement(payoutId, { actor, source: "admin" });
        const message =
          res.status === "paid"
            ? "Transfer settled — payout marked paid."
            : res.status === "failed"
              ? "Transfer returned/failed — payout marked failed (retry once banking is fixed)."
              : "Still settling — funds not yet confirmed. Check back later.";
        return { status: res.status === "failed" ? "error" : "success", op, message };
      }
      default:
        return { status: "error", op, message: `Unknown action: ${op}` };
    }
  } catch (e) {
    console.error(`[cdo-program/payouts] action ${op} failed:`, e?.message || e);
    return { status: "error", op, message: e?.message || "Action failed" };
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPeriod(r) {
  if (!r.periodStart && !r.periodEnd) return "—";
  if (!r.periodStart) return `Up to ${formatDate(r.periodEnd)}`;
  if (!r.periodEnd) return `From ${formatDate(r.periodStart)}`;
  return `${formatDate(r.periodStart)} – ${formatDate(r.periodEnd)}`;
}

const METHOD_LABEL = { ach: "ACH", check: "Check", manual: "Manual" };
const METHOD_TONE  = { ach: "info", check: "default", manual: "default" };

function MethodBadge({ method }) {
  const m = (method || "manual").toLowerCase();
  return (
    <s-badge tone={METHOD_TONE[m] || "default"}>
      {METHOD_LABEL[m] || method || "—"}
    </s-badge>
  );
}

// Native date picker — s-text-field does not forward type="date".
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

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CdoPayouts() {
  const { rows } = useLoaderData();
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const handledRef = useRef(null);

  const busy = fetcher.state === "submitting" || fetcher.state === "loading";
  const pendingId = busy ? fetcher.formData?.get("payoutId") : null;
  const pendingOp = busy ? fetcher.formData?.get("_action") : null;

  // ── Filter state ────────────────────────────────────────────────────────────
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [methodFilter, setMethodFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  // Pre-filter rows before passing to DataTable (DataTable owns text search).
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (methodFilter !== "all" && r.method !== methodFilter) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (dateFrom || dateTo) {
        // Filter by periodEnd date (the batch cutoff).
        const d = r.periodEnd ? new Date(r.periodEnd) : null;
        if (!d) return false;
        if (dateFrom && d < new Date(dateFrom)) return false;
        if (dateTo && d > new Date(dateTo + "T23:59:59")) return false;
      }
      return true;
    });
  }, [rows, methodFilter, statusFilter, dateFrom, dateTo]);

  const hasActiveFilters = methodFilter !== "all" || statusFilter !== "all" || dateFrom || dateTo;

  const resetFilters = () => {
    setDateFrom("");
    setDateTo("");
    setMethodFilter("all");
    setStatusFilter("all");
  };

  // ── Toast effects ───────────────────────────────────────────────────────────
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

  const submit = (payload, { confirmText } = {}) => {
    if (confirmText && !confirm(confirmText)) return;
    fetcher.submit(payload, { method: "POST" });
  };

  const onGenerate = () =>
    submit(
      { _action: "generate-batch" },
      { confirmText: "Generate payout batch from all eligible approved commissions (up to today)?" },
    );

  const rowBusy = (r, op) => busy && pendingId === r.id && pendingOp === op;

  // ── Columns ─────────────────────────────────────────────────────────────────
  const columns = [
    { key: "practitionerName", header: "Practitioner" },
    {
      key: "amount",
      header: "Amount",
      render: (r) => formatCurrency(r.amount, r.currency),
    },
    {
      key: "commissionCount",
      header: "Commissions",
      render: (r) => r.commissionCount ?? 0,
    },
    {
      key: "method",
      header: "Method",
      render: (r) => <MethodBadge method={r.method} />,
    },
    {
      key: "period",
      header: "Period",
      render: fmtPeriod,
    },
    {
      key: "status",
      header: "Status",
      render: (r) => <StatusBadge status={r.status} />,
    },
    {
      key: "qbo",
      header: "QBO",
      render: (r) =>
        r.qboBillUrl ? (
          <s-link href={r.qboBillUrl} target="_blank">
            Bill {r.qboBillId}
          </s-link>
        ) : (
          "—"
        ),
    },
    {
      key: "actions",
      header: "Actions",
      render: (r) => (
        <s-stack direction="inline" gap="small-200">
          {(r.status === "awaiting_approval" || r.status === "draft") && (
            <>
              <s-button
                variant="primary"
                {...(rowBusy(r, "approve") ? { loading: true } : {})}
                onClick={() => submit({ _action: "approve", payoutId: r.id })}
              >
                Approve
              </s-button>
              <s-button
                variant="tertiary"
                tone="critical"
                {...(rowBusy(r, "reject") ? { loading: true } : {})}
                onClick={() =>
                  submit(
                    { _action: "reject", payoutId: r.id },
                    { confirmText: `Reject payout for ${r.practitionerName}? Its commissions are released back to the pool.` },
                  )
                }
              >
                Reject
              </s-button>
            </>
          )}
          {(r.status === "approved" || r.status === "failed") && (
            <s-button
              variant="primary"
              {...(rowBusy(r, "execute") ? { loading: true } : {})}
              onClick={() =>
                submit(
                  { _action: "execute", payoutId: r.id },
                  {
                    confirmText:
                      r.status === "failed"
                        ? `Retry payout for ${r.practitionerName}? This initiates a NEW bank transfer for ${formatCurrency(r.amount, r.currency)}.`
                        : `Execute payout for ${r.practitionerName}? This records the QBO Bill and initiates a real bank transfer of ${formatCurrency(r.amount, r.currency)} to their account on file.`,
                  },
                )
              }
            >
              {r.status === "failed" ? "Retry" : "Execute"}
            </s-button>
          )}
          {r.status === "awaiting_settlement" && (
            <s-button
              variant="secondary"
              {...(rowBusy(r, "check-settlement") ? { loading: true } : {})}
              onClick={() => submit({ _action: "check-settlement", payoutId: r.id })}
            >
              Sync settlement
            </s-button>
          )}
          {r.status === "failed" && (r.returnReason || r.lastError) ? (
            <s-text tone="critical">{r.returnReason || r.lastError}</s-text>
          ) : null}
        </s-stack>
      ),
    },
  ];

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <s-stack direction="block" gap="base">
      {/* Header section */}
      <s-section padding="base">
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-paragraph tone="subdued">
            Aggregate eligible approved commissions into payout batches. Approve,
            then Execute to record the QBO Vendor Bill and initiate a real bank
            transfer to the practitioner&rsquo;s account on file. The payout stays
            in <strong>Awaiting settlement</strong> until funds confirm (1–3
            business days); a returned transfer flips it to Failed for retry.
            Payouts below the program minimum are skipped.
          </s-paragraph>
          <s-button
            variant="primary"
            {...(busy && pendingOp === "generate-batch" ? { loading: true } : {})}
            onClick={onGenerate}
          >
            Generate payout batch
          </s-button>
        </s-stack>
      </s-section>

      {/* Filters */}
      <s-section heading="Filters">
        <s-stack direction="block" gap="base">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px" }}>
            <DateField
              label="Period from"
              value={dateFrom}
              onChange={setDateFrom}
            />
            <DateField
              label="Period to"
              value={dateTo}
              onChange={setDateTo}
            />
            <s-select
              label="Method"
              value={methodFilter}
              onChange={(e) => setMethodFilter(e?.target?.value ?? "all")}
            >
              <s-option value="all">All methods</s-option>
              <s-option value="ach">ACH</s-option>
              <s-option value="check">Check</s-option>
              <s-option value="manual">Manual</s-option>
            </s-select>
            <s-select
              label="Status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e?.target?.value ?? "all")}
            >
              <s-option value="all">All statuses</s-option>
              <s-option value="draft">Draft</s-option>
              <s-option value="awaiting_approval">Awaiting Approval</s-option>
              <s-option value="approved">Approved</s-option>
              <s-option value="awaiting_settlement">Awaiting Settlement</s-option>
              <s-option value="paid">Paid</s-option>
              <s-option value="failed">Failed</s-option>
              <s-option value="rejected">Rejected</s-option>
              <s-option value="cancelled">Cancelled</s-option>
            </s-select>
          </div>

          {/* Active filter chips + reset */}
          {hasActiveFilters && (
            <s-stack direction="inline" gap="small-200" alignItems="center" wrap>
              {dateFrom && (
                <s-tag onRemove={() => setDateFrom("")}>From: {dateFrom}</s-tag>
              )}
              {dateTo && (
                <s-tag onRemove={() => setDateTo("")}>To: {dateTo}</s-tag>
              )}
              {methodFilter !== "all" && (
                <s-tag onRemove={() => setMethodFilter("all")}>
                  Method: {METHOD_LABEL[methodFilter] || methodFilter}
                </s-tag>
              )}
              {statusFilter !== "all" && (
                <s-tag onRemove={() => setStatusFilter("all")}>
                  Status: {statusFilter.replace(/_/g, " ")}
                </s-tag>
              )}
              <s-button variant="tertiary" onClick={resetFilters}>
                Clear all
              </s-button>
              <s-text tone="subdued">
                {filteredRows.length} of {rows.length} payout{rows.length !== 1 ? "s" : ""}
              </s-text>
            </s-stack>
          )}
        </s-stack>
      </s-section>

      {/* Table */}
      <DataTable
        columns={columns}
        rows={filteredRows}
        searchKeys={["practitionerName", "method", "status", "reference"]}
        searchPlaceholder="Search by practitioner, method, or status"
        emptyHeading="No payouts"
        emptyBody={
          hasActiveFilters
            ? "No payouts match the current filters. Clear filters to see all payouts."
            : "Generate a payout batch to aggregate eligible commissions for approval."
        }
      />
    </s-stack>
  );
}
