import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { listOrders } from "../services/cdo/cdo.service";
import DataTable from "../components/cdo/DataTable";
import StatusBadge from "../components/cdo/StatusBadge";
import { MigratedBadge, MIGRATED_FILTER } from "../components/cdo/MigratedBadge";
import { formatCurrency, formatDate } from "../utils/format";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const rows = await listOrders();
  return { rows };
};

const COLUMNS = [
  { key: "orderName", header: "Order" },
  { key: "practitionerName", header: "Practitioner" },
  { key: "customerName", header: "Customer" },
  {
    key: "amount",
    header: "Amount",
    render: (r) => formatCurrency(r.amount, r.currency),
  },
  {
    key: "commissionAmount",
    header: "Commission",
    render: (r) => formatCurrency(r.commissionAmount, r.currency),
  },
  {
    key: "status",
    header: "Status",
    render: (r) => (
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <StatusBadge status={r.status} />
        <MigratedBadge migrated={r.migrated} />
      </s-stack>
    ),
  },
  { key: "placedAt", header: "Date", render: (r) => formatDate(r.placedAt) },
];

export default function CdoOrders() {
  const { rows } = useLoaderData();
  return (
    <DataTable
      columns={COLUMNS}
      rows={rows}
      filters={[MIGRATED_FILTER]}
      searchKeys={["orderName", "practitionerName", "customerName", "status"]}
      searchPlaceholder="Search by order, practitioner, or customer"
      description="Shopify orders attributed to CDO practitioners through referral tracking."
      emptyHeading="No CDO orders yet"
      emptyBody="Orders attributed to a practitioner will appear here once referral tracking records them."
    />
  );
}
