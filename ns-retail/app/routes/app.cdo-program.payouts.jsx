import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { listPayouts } from "../services/cdo/cdo.service";
import DataTable from "../components/cdo/DataTable";
import StatusBadge from "../components/cdo/StatusBadge";
import { formatCurrency, formatDate } from "../utils/format";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const rows = await listPayouts();
  return { rows };
};

const period = (r) =>
  r.periodStart || r.periodEnd
    ? `${formatDate(r.periodStart)} – ${formatDate(r.periodEnd)}`
    : "—";

const COLUMNS = [
  { key: "practitionerName", header: "Practitioner" },
  {
    key: "amount",
    header: "Amount",
    render: (r) => formatCurrency(r.amount, r.currency),
  },
  { key: "method", header: "Method" },
  { key: "period", header: "Period", render: period },
  { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} /> },
  { key: "paidAt", header: "Paid", render: (r) => formatDate(r.paidAt) },
];

export default function CdoPayouts() {
  const { rows } = useLoaderData();
  return (
    <DataTable
      columns={COLUMNS}
      rows={rows}
      searchKeys={["practitionerName", "method", "status", "reference"]}
      searchPlaceholder="Search by practitioner, method, or status"
      description="Payout records disbursing accrued commissions to practitioners."
      emptyHeading="No payouts yet"
      emptyBody="Payout records will appear here once disbursements are issued."
    />
  );
}
