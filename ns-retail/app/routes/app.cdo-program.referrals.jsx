import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { listReferrals } from "../services/cdo/cdo.service";
import DataTable from "../components/cdo/DataTable";
import StatusBadge from "../components/cdo/StatusBadge";
import { MigratedBadge, MIGRATED_FILTER } from "../components/cdo/MigratedBadge";
import { formatDate } from "../utils/format";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const rows = await listReferrals();
  return { rows };
};

const COLUMNS = [
  { key: "practitionerName", header: "Practitioner" },
  { key: "referredName", header: "Referred" },
  { key: "referralCode", header: "Code" },
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
  {
    key: "referredAt",
    header: "Referred",
    render: (r) => formatDate(r.referredAt),
  },
  {
    key: "convertedAt",
    header: "Converted",
    render: (r) => formatDate(r.convertedAt),
  },
];

export default function CdoReferrals() {
  const { rows } = useLoaderData();
  return (
    <DataTable
      columns={COLUMNS}
      rows={rows}
      filters={[MIGRATED_FILTER]}
      searchKeys={["practitionerName", "referredName", "referralCode", "status"]}
      searchPlaceholder="Search by practitioner, referred contact, or code"
      description="Prospects referred by practitioners, tracked from first touch through conversion."
      emptyHeading="No referrals yet"
      emptyBody="Referrals will appear here as practitioners share their referral links."
    />
  );
}
