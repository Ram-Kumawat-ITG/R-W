import { useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import { listPractitioners } from "../services/cdo/cdo.service";
import DataTable from "../components/cdo/DataTable";
import { formatDate } from "../utils/format";

// CDO Customers list. Each row links to the practitioner's detail
// page (`/app/cdo-program/customers/:id`) via a dedicated "View"
// button column — explicit-action navigation, no whole-row click,
// matching the project's wholesale Order List pattern.

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const rows = await listPractitioners();
  return { rows };
};

export default function CdoCustomers() {
  const { rows } = useLoaderData();
  const navigate = useNavigate();

  // Columns live INSIDE the component so the `render` for the action
  // column can close over `navigate`. The other columns are static
  // values so this re-declaration per render is cheap.
  const columns = [
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
    {
      key: "payoutsPaused",
      header: "Payouts",
      render: (r) =>
        r.payoutsPaused ? (
          <s-badge tone="warning">Paused</s-badge>
        ) : (
          <s-badge tone="success">Active</s-badge>
        ),
    },
    {
      key: "actions",
      header: "Actions",
      render: (r) => (
        <s-button
          variant="tertiary"
          accessibilityLabel={`View ${r.name || r.email || "practitioner"}`}
          onClick={() => navigate(`/app/cdo-program/customers/${r.id}`)}
        >
          View
        </s-button>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      searchKeys={["name", "email", "phone", "businessName", "customerId"]}
      searchPlaceholder="Search by name, email, phone, business, or customer ID"
      description="Approved practitioners enrolled in the CDO Program (wholesale applicants who resell). Click View to manage referral codes, view commissions, and configure per-practitioner settings."
      emptyHeading="No CDO practitioners yet"
      emptyBody="Approved practitioners who choose to resell products will appear here."
    />
  );
}
