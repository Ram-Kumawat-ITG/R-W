import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { listCommissions } from "../services/cdo/cdo.service";
import DataTable from "../components/cdo/DataTable";
import StatusBadge from "../components/cdo/StatusBadge";
import { formatCurrency, formatPercent, formatDate } from "../utils/format";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const rows = await listCommissions();
  return { rows };
};

const COLUMNS = [
  { key: "practitionerName", header: "Practitioner" },
  { key: "orderName", header: "Order" },
  {
    key: "amount",
    header: "Amount",
    render: (r) => formatCurrency(r.amount, r.currency),
  },
  { key: "rate", header: "Rate", render: (r) => formatPercent(r.rate) },
  { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} /> },
  { key: "earnedAt", header: "Earned", render: (r) => formatDate(r.earnedAt) },
];

export default function CdoCommissions() {
  const { rows } = useLoaderData();
  return (
    <DataTable
      columns={COLUMNS}
      rows={rows}
      searchKeys={["practitionerName", "orderName", "status"]}
      searchPlaceholder="Search by practitioner or order"
      description="Commission history accrued by practitioners on attributed orders."
      emptyHeading="No commissions yet"
      emptyBody="Commission records will appear here as practitioners earn on attributed orders."
    />
  );
}
