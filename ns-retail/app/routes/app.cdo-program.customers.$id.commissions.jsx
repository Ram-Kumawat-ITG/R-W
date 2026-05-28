import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { listPractitionerCommissions } from "../services/cdo/cdo.service";
import DataTable from "../components/cdo/DataTable";
import StatusBadge from "../components/cdo/StatusBadge";
import { formatCurrency, formatDate, formatPercent } from "../utils/format";

// Commissions tab — every commission row attributed to this
// practitioner. Powered by the existing DataTable for client-side
// search + pagination so the layout stays consistent with the program-
// level Commissions tab.

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);
  const rows = await listPractitionerCommissions(params.id);
  return { rows };
};

const COLUMNS = [
  { key: "orderName", header: "Order" },
  {
    key: "amount",
    header: "Amount",
    render: (r) => formatCurrency(r.amount, r.currency),
  },
  {
    key: "rate",
    header: "Rate",
    render: (r) => formatPercent(r.rate),
  },
  {
    key: "status",
    header: "Status",
    render: (r) => <StatusBadge status={r.status} />,
  },
  {
    key: "earnedAt",
    header: "Earned",
    render: (r) => formatDate(r.earnedAt),
  },
];

export default function CdoCustomerCommissions() {
  const { rows } = useLoaderData();
  return (
    <DataTable
      columns={COLUMNS}
      rows={rows}
      searchKeys={["orderName", "status"]}
      searchPlaceholder="Search by order or status"
      description="Commission ledger for this practitioner — one row per attributed order, ordered by earn date."
      emptyHeading="No commissions yet"
      emptyBody="Commissions appear here once orders are attributed to this practitioner."
    />
  );
}
