import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { listPractitionerTransactions } from "../services/cdo/cdo.service";
import DataTable from "../components/cdo/DataTable";
import { formatCurrency, formatDateTime } from "../utils/format";

// Transactions tab — append-only ledger of every commission /
// adjustment / refund / payout event for this practitioner. Sourced
// from cdo_transactions. This is the source of truth for "what was
// the running balance at any point in time".

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);
  const rows = await listPractitionerTransactions(params.id);
  return { rows };
};

const COLUMNS = [
  { key: "type", header: "Type" },
  {
    key: "amount",
    header: "Amount",
    render: (r) => formatCurrency(r.amount, r.currency),
  },
  {
    key: "balanceAfter",
    header: "Balance after",
    render: (r) =>
      r.balanceAfter != null
        ? formatCurrency(r.balanceAfter, r.currency)
        : "—",
  },
  { key: "description", header: "Description" },
  {
    key: "occurredAt",
    header: "When",
    render: (r) => formatDateTime(r.occurredAt),
  },
];

export default function CdoCustomerTransactions() {
  const { rows } = useLoaderData();
  return (
    <DataTable
      columns={COLUMNS}
      rows={rows}
      searchKeys={["type", "description"]}
      searchPlaceholder="Search by type or description"
      description="Append-only commission ledger — every credit, adjustment, refund, and payout for this practitioner."
      emptyHeading="No transactions yet"
      emptyBody="Ledger entries are written automatically as commissions earn, payouts pay, and adjustments occur."
    />
  );
}
