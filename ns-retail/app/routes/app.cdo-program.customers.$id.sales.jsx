import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { listPractitionerOrders } from "../services/cdo/cdo.service";
import DataTable from "../components/cdo/DataTable";
import StatusBadge from "../components/cdo/StatusBadge";
import { formatCurrency, formatDate } from "../utils/format";

// Sales tab — every Shopify order attributed to this practitioner via
// a code in their owned set. Sourced from cdo_orders.

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);
  const rows = await listPractitionerOrders(params.id);
  return { rows };
};

const COLUMNS = [
  { key: "orderName", header: "Order" },
  { key: "customerName", header: "Customer" },
  {
    key: "amount",
    header: "Order total",
    render: (r) => formatCurrency(r.amount, r.currency),
  },
  {
    key: "commissionAmount",
    header: "Commission",
    render: (r) => formatCurrency(r.commissionAmount, r.currency),
  },
  {
    key: "referralCode",
    header: "Code",
    render: (r) => r.referralCode || "—",
  },
  {
    key: "status",
    header: "Status",
    render: (r) => <StatusBadge status={r.status} />,
  },
  {
    key: "placedAt",
    header: "Placed",
    render: (r) => formatDate(r.placedAt),
  },
];

export default function CdoCustomerSales() {
  const { rows } = useLoaderData();
  return (
    <DataTable
      columns={COLUMNS}
      rows={rows}
      searchKeys={["orderName", "customerName", "referralCode", "status"]}
      searchPlaceholder="Search by order, customer, or code"
      description="Shopify orders attributed to this practitioner via one of their referral codes."
      emptyHeading="No attributed sales yet"
      emptyBody="Sales appear here once shoppers complete checkout using one of this practitioner's codes."
    />
  );
}
