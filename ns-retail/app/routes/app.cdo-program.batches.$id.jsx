/* eslint-disable react/prop-types */
import { useEffect, useRef } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getPayoutBatch, reprocessBatch } from "../services/cdo/cdo.service";
import DataTable from "../components/cdo/DataTable";
import StatusBadge from "../components/cdo/StatusBadge";
import { formatCurrency, formatDate } from "../utils/format";

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);
  const batch = await getPayoutBatch(params.id);
  if (!batch) throw new Response("Batch not found", { status: 404 });
  return { batch };
};

// Reprocess the batch's failed payouts (spawns a fresh manual_reprocess
// batch; idempotent — never double-pays).
export const action = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const actor =
    session?.onlineAccessInfo?.associated_user?.email || session?.shop || "admin";
  const formData = await request.formData();
  const op = String(formData.get("_action") || "").trim();
  try {
    if (op === "reprocess") {
      const res = await reprocessBatch(params.id, { actor });
      return {
        status: "success",
        op,
        message: res.reprocessed
          ? `Reprocessed ${res.reprocessed} commission(s): ${res.paid} paid, ${res.failed} failed (batch ${res.reference}).`
          : res.message || "Nothing to reprocess.",
      };
    }
    return { status: "error", op, message: `Unknown action: ${op}` };
  } catch (e) {
    console.error(`[cdo-program/batches] action ${op} failed:`, e?.message || e);
    return { status: "error", op, message: e?.message || "Action failed" };
  }
};

export default function CdoPayoutBatchDetail() {
  const { batch } = useLoaderData();
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const handledRef = useRef(null);
  const busy = fetcher.state === "submitting" || fetcher.state === "loading";

  useEffect(() => {
    if (!fetcher.data || fetcher.state !== "idle") return;
    if (handledRef.current === fetcher.data) return;
    handledRef.current = fetcher.data;
    shopify?.toast?.show(fetcher.data.message || "Done", {
      isError: fetcher.data.status !== "success",
    });
  }, [fetcher.data, fetcher.state, shopify]);

  const reprocess = () => {
    if (!confirm("Reprocess all failed payouts in this batch? Already-paid commissions are never re-charged.")) return;
    fetcher.submit({ _action: "reprocess" }, { method: "POST" });
  };

  const practitionerColumns = [
    { key: "practitionerName", header: "Practitioner" },
    { key: "commissionCount", header: "Commissions", render: (r) => r.commissionCount },
    { key: "totalAmount", header: "Total payout", render: (r) => formatCurrency(r.totalAmount, "USD") },
    { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "txnRef", header: "Txn ref", render: (r) => r.txnRef || "—" },
    {
      key: "qboBill",
      header: "Vendor bill",
      render: (r) =>
        r.qboBillUrl ? (
          <s-link href={r.qboBillUrl} target="_blank">
            Bill {r.qboBillId}
          </s-link>
        ) : (
          "—"
        ),
    },
  ];

  // Per-practitioner payout audit trail (cdo_payouts.remarks), flattened.
  const auditRows = (batch.practitionerPayouts || [])
    .flatMap((p) =>
      (p.remarks || []).map((r) => ({ practitioner: p.practitionerName, ...r })),
    )
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  const columns = [
    { key: "orderName", header: "Order" },
    { key: "practitionerEmail", header: "Practitioner", render: (r) => r.practitionerEmail || r.practitionerId || "—" },
    { key: "amount", header: "Amount", render: (r) => formatCurrency(r.amount, "USD") },
    { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "attempt", header: "Attempt", render: (r) => r.attempt || 0 },
    { key: "txnRef", header: "Txn ref", render: (r) => r.txnRef || "—" },
    { key: "payoutDate", header: "Payout date", render: (r) => (r.payoutDate ? formatDate(r.payoutDate) : "—") },
    { key: "failureReason", header: "Failure reason", render: (r) => r.failureReason || "—" },
  ];

  const Row = ({ label, value }) => (
    <s-stack direction="block" gap="none">
      <s-text tone="subdued">{label}</s-text>
      <s-text>{value}</s-text>
    </s-stack>
  );

  return (
    <s-stack direction="block" gap="base">
      <s-section heading={`Batch ${batch.reference}`}>
        {batch.error ? <s-banner tone="critical">Batch error: {batch.error}</s-banner> : null}
        <s-stack direction="inline" gap="large" alignItems="start" justifyContent="space-between">
          <s-stack direction="inline" gap="large">
            <Row label="Status" value={<StatusBadge status={batch.status} />} />
            <Row label="Trigger" value={batch.mode === "manual_reprocess" ? "Reprocess" : "CRON"} />
            <Row label="Executed" value={formatDate(batch.executionTime)} />
            <Row label="Completed" value={batch.completedAt ? formatDate(batch.completedAt) : "—"} />
          </s-stack>
          {batch.failedCount > 0 ? (
            <s-button variant="primary" {...(busy ? { loading: true } : {})} onClick={reprocess}>
              Reprocess failed ({batch.failedCount})
            </s-button>
          ) : null}
        </s-stack>
        <s-stack direction="inline" gap="large" paddingBlockStart="base">
          <Row label="Commissions" value={batch.totalCommissions} />
          <Row label="Total amount" value={formatCurrency(batch.totalAmount, "USD")} />
          <Row label="Paid" value={batch.successCount} />
          <Row label="Failed" value={batch.failedCount} />
          <Row label="Skipped" value={batch.skippedCount} />
          <Row label="Processing" value={batch.processingCount} />
        </s-stack>
      </s-section>

      <s-heading>Practitioner payouts</s-heading>
      <DataTable
        columns={practitionerColumns}
        rows={batch.practitionerPayouts}
        description="One aggregated payout per practitioner — the total of all their commissions in this cycle (not one payout per commission)."
        emptyHeading="No practitioner payouts in this batch"
        emptyBody="No practitioner cleared the minimum payout this run (commissions roll to the next cycle)."
      />

      <s-heading>Commission detail</s-heading>
      <DataTable
        columns={columns}
        rows={batch.items}
        searchKeys={["orderName", "practitionerEmail", "status"]}
        searchPlaceholder="Search items by order, practitioner, or status"
        emptyHeading="No commissions in this batch"
        emptyBody="This batch processed no commissions."
      />

      {auditRows.length > 0 ? (
        <>
          <s-heading>Payout audit log</s-heading>
          <s-section padding="none">
            <s-table>
              <s-table-header-row>
                <s-table-header>When</s-table-header>
                <s-table-header>Practitioner</s-table-header>
                <s-table-header>Event</s-table-header>
                <s-table-header>Detail</s-table-header>
                <s-table-header>Actor</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {auditRows.map((r, i) => (
                  <s-table-row key={i}>
                    <s-table-cell>{r.createdAt ? formatDate(r.createdAt) : "—"}</s-table-cell>
                    <s-table-cell>{r.practitioner}</s-table-cell>
                    <s-table-cell>{r.kind}</s-table-cell>
                    <s-table-cell>{r.message}</s-table-cell>
                    <s-table-cell>{`${r.actor}${r.source ? ` (${r.source})` : ""}`}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-section>
        </>
      ) : null}
    </s-stack>
  );
}
