import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  listPractitionerPayouts,
  getPractitionerKpis,
  getSettings,
} from "../services/cdo/cdo.service";
import DataTable from "../components/cdo/DataTable";
import StatusBadge from "../components/cdo/StatusBadge";
import MetricCard from "../components/cdo/MetricCard";
import { formatCurrency, formatDate } from "../utils/format";

// Payments tab — commission payouts paid (or scheduled) to this
// practitioner. Sourced from cdo_payouts. Includes a small KPI strip
// at the top so the totals are at-a-glance without leaving the page.

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);
  const [rows, kpis, settings] = await Promise.all([
    listPractitionerPayouts(params.id),
    getPractitionerKpis(params.id),
    getSettings(),
  ]);
  return { rows, kpis, settings };
};

const COLUMNS = [
  {
    key: "amount",
    header: "Amount",
    render: (r) => formatCurrency(r.amount, r.currency),
  },
  { key: "method", header: "Method" },
  {
    key: "status",
    header: "Status",
    render: (r) => <StatusBadge status={r.status} />,
  },
  {
    key: "periodStart",
    header: "Period",
    render: (r) =>
      r.periodStart || r.periodEnd
        ? `${formatDate(r.periodStart)} – ${formatDate(r.periodEnd)}`
        : "—",
  },
  { key: "reference", header: "Reference" },
  {
    key: "paidAt",
    header: "Paid",
    render: (r) => formatDate(r.paidAt),
  },
];

export default function CdoCustomerPayments() {
  const { rows, kpis, settings } = useLoaderData();
  return (
    <s-stack direction="block" gap="base">
      <s-grid gap="base" gridTemplateColumns="repeat(3, minmax(0, 1fr))">
        <MetricCard
          label="Pending payout"
          value={formatCurrency(kpis.pendingPayout, settings.currency)}
        />
        <MetricCard
          label="Paid to date"
          value={formatCurrency(kpis.paidPayout, settings.currency)}
          tone="success"
        />
        <MetricCard
          label="Total commissions"
          value={formatCurrency(kpis.totalCommissions, settings.currency)}
        />
      </s-grid>
      <DataTable
        columns={COLUMNS}
        rows={rows}
        searchKeys={["method", "status", "reference"]}
        searchPlaceholder="Search by method, status, or reference"
        description="Commission payout history. Refunds + adjustments appear in the Transactions tab."
        emptyHeading="No payouts yet"
        emptyBody="Payouts appear here once approved commissions are released for payment."
      />
    </s-stack>
  );
}
