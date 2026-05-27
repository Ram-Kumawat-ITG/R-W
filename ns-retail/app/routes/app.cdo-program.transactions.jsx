import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { listTransactions } from "../services/cdo/cdo.service";
import DataTable from "../components/cdo/DataTable";
import { formatCurrency, formatDateTime } from "../utils/format";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const rows = await listTransactions();
  return { rows };
};

const TYPE_TONE = {
  commission: "success",
  payout: "info",
  adjustment: "warning",
  reversal: "critical",
};

const COLUMNS = [
  { key: "occurredAt", header: "Date", render: (r) => formatDateTime(r.occurredAt) },
  { key: "practitionerName", header: "Practitioner" },
  {
    key: "type",
    header: "Type",
    render: (r) => (
      <s-badge tone={TYPE_TONE[r.type] || "neutral"}>{r.type}</s-badge>
    ),
  },
  {
    key: "amount",
    header: "Amount",
    render: (r) => formatCurrency(r.amount, r.currency),
  },
  {
    key: "balanceAfter",
    header: "Balance",
    render: (r) =>
      r.balanceAfter == null ? "—" : formatCurrency(r.balanceAfter, r.currency),
  },
  { key: "description", header: "Description" },
];

export default function CdoTransactions() {
  const { rows } = useLoaderData();
  return (
    <DataTable
      columns={COLUMNS}
      rows={rows}
      searchKeys={["practitionerName", "type", "description"]}
      searchPlaceholder="Search by practitioner, type, or description"
      description="Append-only ledger of commission credits, payouts, adjustments, and reversals."
      emptyHeading="No transactions yet"
      emptyBody="Ledger entries will appear here as commissions accrue and payouts are issued."
    />
  );
}
