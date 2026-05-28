import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { listPractitionerReferrals } from "../services/cdo/cdo.service";
import DataTable from "../components/cdo/DataTable";
import StatusBadge from "../components/cdo/StatusBadge";
import { formatDate } from "../utils/format";

// "Customers" tab — referenced as `downline` in the URL to avoid
// colliding with the parent /customers route. Shows every prospect /
// shopper referred by this practitioner, sourced from cdo_referrals.

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);
  const rows = await listPractitionerReferrals(params.id);
  return { rows };
};

const COLUMNS = [
  { key: "referredName", header: "Customer", render: (r) => r.referredName || r.referredEmail || "—" },
  { key: "referredEmail", header: "Email" },
  { key: "referralCode", header: "Code used" },
  {
    key: "status",
    header: "Status",
    render: (r) => <StatusBadge status={r.status} />,
  },
  { key: "referredAt", header: "Referred", render: (r) => formatDate(r.referredAt) },
  { key: "convertedAt", header: "Converted", render: (r) => formatDate(r.convertedAt) },
];

export default function CdoCustomerDownline() {
  const { rows } = useLoaderData();
  return (
    <DataTable
      columns={COLUMNS}
      rows={rows}
      searchKeys={["referredName", "referredEmail", "referralCode", "status"]}
      searchPlaceholder="Search by referred name, email, or code"
      description="Shoppers referred by this practitioner. A referral converts once they place a first order with a valid code."
      emptyHeading="No referred customers yet"
      emptyBody="Once shoppers use this practitioner's code, they'll appear here."
    />
  );
}
