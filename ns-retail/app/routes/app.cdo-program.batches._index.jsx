/* eslint-disable react/prop-types */
import { useNavigate, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { listPayoutBatches } from "../services/cdo/cdo.service";
import DataTable from "../components/cdo/DataTable";
import StatusBadge from "../components/cdo/StatusBadge";
import { formatCurrency, formatDate } from "../utils/format";

// Payout Batches — one row per automated CRON run (or manual reprocess) of
// process-commission-payouts. Each row links to a detail page snapshotting
// the commissions that run processed + their per-commission outcome.

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const rows = await listPayoutBatches({ limit: 200 });
  return { rows };
};

export default function CdoPayoutBatches() {
  const { rows } = useLoaderData();
  const navigate = useNavigate();

  const columns = [
    { key: "reference", header: "Batch" },
    {
      key: "mode",
      header: "Trigger",
      render: (r) => (r.mode === "manual_reprocess" ? "Reprocess" : "CRON"),
    },
    {
      key: "executionTime",
      header: "Executed",
      render: (r) => formatDate(r.executionTime),
    },
    { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "totalCommissions", header: "Commissions", render: (r) => r.totalCommissions },
    {
      key: "totalAmount",
      header: "Amount",
      render: (r) => formatCurrency(r.totalAmount, "USD"),
    },
    {
      // Processing = batched into a payout but not yet settled (awaiting admin
      // approval or bank settlement). Surfaced so the breakdown reconciles with
      // the Commissions count instead of showing 0 / 0 / 0 for in-flight runs.
      key: "counts",
      header: "Paid / Failed / Skipped / Processing",
      render: (r) => (
        <s-stack direction="inline" gap="small-200">
          <s-badge tone="success">{r.successCount}</s-badge>
          <s-badge tone={r.failedCount ? "critical" : "neutral"}>{r.failedCount}</s-badge>
          <s-badge tone="neutral">{r.skippedCount}</s-badge>
          <s-badge tone={r.processingCount ? "info" : "neutral"}>{r.processingCount}</s-badge>
        </s-stack>
      ),
    },
    {
      key: "open",
      header: "",
      render: (r) => (
        <s-button variant="tertiary" onClick={() => navigate(`/app/cdo-program/batches/${r.id}`)}>
          View
        </s-button>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      searchKeys={["reference", "status", "mode"]}
      searchPlaceholder="Search by batch reference or status"
      description="Every automated commission-payout run is recorded as a batch. Open a batch to see the commissions it processed, their payout status, attempts, and failure reasons."
      emptyHeading="No payout batches yet"
      emptyBody="The process-commission-payouts CRON records a batch each time it runs."
    />
  );
}
