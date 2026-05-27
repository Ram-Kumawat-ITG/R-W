import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { listPractitioners } from "../services/cdo/cdo.service";
import DataTable from "../components/cdo/DataTable";
import { formatDate } from "../utils/format";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const rows = await listPractitioners();
  return { rows };
};

const COLUMNS = [
  { key: "name", header: "Practitioner", render: (r) => r.name || "—" },
  { key: "businessName", header: "Business" },
  { key: "email", header: "Email" },
  { key: "phone", header: "Phone" },
  {
    key: "submittedAt",
    header: "Joined",
    render: (r) => formatDate(r.submittedAt),
  },
  { key: "customerId", header: "Customer ID" },
];

export default function CdoCustomers() {
  const { rows } = useLoaderData();
  return (
    <DataTable
      columns={COLUMNS}
      rows={rows}
      searchKeys={["name", "email", "phone", "businessName", "customerId"]}
      searchPlaceholder="Search by name, email, phone, business, or customer ID"
      description="Approved practitioners enrolled in the CDO Program (wholesale applicants who resell)."
      emptyHeading="No CDO practitioners yet"
      emptyBody="Approved practitioners who choose to resell products will appear here."
    />
  );
}
