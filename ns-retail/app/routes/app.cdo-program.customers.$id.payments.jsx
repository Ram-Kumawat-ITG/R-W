/* eslint-disable react/prop-types */
import { useEffect, useRef } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
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

// Payments tab — commission payouts for this practitioner. Sourced from
// cdo_payouts with a KPI strip on top. Approve / reject / execute submit
// to the SHARED payout action, re-exported here from the Payouts tab so
// this leaf route can serve the fetcher's POST (single source of truth
// for the payout state machine — see app.cdo-program.payouts.jsx).
export { action } from "./app.cdo-program.payouts.jsx";

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);
  const [rows, kpis, settings] = await Promise.all([
    listPractitionerPayouts(params.id),
    getPractitionerKpis(params.id),
    getSettings(),
  ]);
  return { rows, kpis, settings };
};

const period = (r) =>
  r.periodStart || r.periodEnd
    ? `${formatDate(r.periodStart)} – ${formatDate(r.periodEnd)}`
    : "—";

export default function CdoCustomerPayments() {
  const { rows, kpis, settings } = useLoaderData();
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const handledRef = useRef(null);

  const busy = fetcher.state === "submitting" || fetcher.state === "loading";
  const pendingId = busy ? fetcher.formData?.get("payoutId") : null;
  const pendingOp = busy ? fetcher.formData?.get("_action") : null;

  useEffect(() => {
    if (!fetcher.data || fetcher.state !== "idle") return;
    if (handledRef.current === fetcher.data) return;
    handledRef.current = fetcher.data;
    if (fetcher.data.status === "success") {
      shopify?.toast?.show(fetcher.data.message || "Done");
    } else {
      shopify?.toast?.show(fetcher.data.message || "Action failed", { isError: true });
    }
  }, [fetcher.data, fetcher.state, shopify]);

  const submit = (payload, { confirmText } = {}) => {
    if (confirmText && !confirm(confirmText)) return;
    fetcher.submit(payload, { method: "POST" });
  };
  const rowBusy = (r, op) => busy && pendingId === r.id && pendingOp === op;

  const columns = [
    { key: "amount", header: "Amount", render: (r) => formatCurrency(r.amount, r.currency) },
    { key: "commissionCount", header: "Commissions", render: (r) => r.commissionCount ?? 0 },
    { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "period", header: "Period", render: period },
    {
      key: "qbo",
      header: "QBO",
      render: (r) =>
        r.qboBillUrl ? (
          <s-link href={r.qboBillUrl} target="_blank">
            Bill {r.qboBillId}
          </s-link>
        ) : (
          "—"
        ),
    },
    {
      key: "actions",
      header: "Actions",
      render: (r) => (
        <s-stack direction="inline" gap="small-200">
          {(r.status === "awaiting_approval" || r.status === "draft") && (
            <>
              <s-button
                variant="primary"
                {...(rowBusy(r, "approve") ? { loading: true } : {})}
                onClick={() => submit({ _action: "approve", payoutId: r.id })}
              >
                Approve
              </s-button>
              <s-button
                variant="tertiary"
                tone="critical"
                {...(rowBusy(r, "reject") ? { loading: true } : {})}
                onClick={() =>
                  submit(
                    { _action: "reject", payoutId: r.id },
                    { confirmText: "Reject this payout? Its commissions return to the pool." },
                  )
                }
              >
                Reject
              </s-button>
            </>
          )}
          {(r.status === "approved" || r.status === "failed") && (
            <s-button
              variant="primary"
              {...(rowBusy(r, "execute") ? { loading: true } : {})}
              onClick={() =>
                submit(
                  { _action: "execute", payoutId: r.id },
                  {
                    confirmText:
                      r.status === "failed"
                        ? "Retry executing this payout in QuickBooks?"
                        : "Execute payout? This posts a Bill + BillPayment to QuickBooks.",
                  },
                )
              }
            >
              {r.status === "failed" ? "Retry" : "Execute"}
            </s-button>
          )}
          {r.status === "failed" && r.lastError ? (
            <s-text tone="critical">{r.lastError}</s-text>
          ) : null}
        </s-stack>
      ),
    },
  ];

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
        columns={columns}
        rows={rows}
        searchKeys={["method", "status", "reference"]}
        searchPlaceholder="Search by method, status, or reference"
        description="Commission payout history. Approve a batch to post a Vendor Bill + BillPayment to QuickBooks. Refunds + adjustments appear in the Transactions tab."
        emptyHeading="No payouts yet"
        emptyBody="Payouts appear here once a batch is generated from approved commissions (see the Payouts tab)."
      />
    </s-stack>
  );
}
