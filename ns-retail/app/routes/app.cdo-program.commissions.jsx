/* eslint-disable react/prop-types */
import { useEffect, useRef } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  listCommissions,
  pauseCommission,
  resumeCommission,
} from "../services/cdo/cdo.service";
import DataTable from "../components/cdo/DataTable";
import StatusBadge from "../components/cdo/StatusBadge";
import { MigratedBadge, MIGRATED_FILTER } from "../components/cdo/MigratedBadge";
import { formatCurrency, formatPercent, formatDate } from "../utils/format";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const rows = await listCommissions();
  return { rows };
};

// Pause/resume an individual commission so the automated payout pipeline
// holds it out of (or returns it to) eligibility.
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const actor =
    session?.onlineAccessInfo?.associated_user?.email || session?.shop || "admin";
  const formData = await request.formData();
  const op = String(formData.get("_action") || "").trim();
  const commissionId = formData.get("commissionId");

  try {
    switch (op) {
      case "pause-commission": {
        await pauseCommission(commissionId, { actor, note: formData.get("note") || "" });
        return { status: "success", op, message: "Commission paused — held from payout." };
      }
      case "resume-commission": {
        await resumeCommission(commissionId, { actor });
        return { status: "success", op, message: "Commission resumed — eligible for payout." };
      }
      default:
        return { status: "error", op, message: `Unknown action: ${op}` };
    }
  } catch (e) {
    console.error(`[cdo-program/commissions] action ${op} failed:`, e?.message || e);
    return { status: "error", op, message: e?.message || "Action failed" };
  }
};

export default function CdoCommissions() {
  const { rows } = useLoaderData();
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const handledRef = useRef(null);

  const busy = fetcher.state === "submitting" || fetcher.state === "loading";
  const pendingId = busy ? fetcher.formData?.get("commissionId") : null;

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

  const submit = (payload) => fetcher.submit(payload, { method: "POST" });

  const columns = [
    { key: "practitionerName", header: "Practitioner" },
    { key: "orderName", header: "Order" },
    {
      key: "amount",
      header: "Amount",
      render: (r) => formatCurrency(r.amount, r.currency),
    },
    { key: "rate", header: "Rate", render: (r) => formatPercent(r.rate) },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <StatusBadge status={r.status} />
          {r.paused ? <s-badge tone="warning">Paused</s-badge> : null}
          <MigratedBadge migrated={r.migrated} />
        </s-stack>
      ),
    },
    { key: "earnedAt", header: "Earned", render: (r) => formatDate(r.earnedAt) },
    {
      key: "payout",
      header: "Payout",
      render: (r) => {
        // Paid/reversed — show QBO bill link or payout reference.
        if (r.status === "paid" || r.status === "reversed") {
          if (r.qboBillUrl) {
            return (
              <s-link href={r.qboBillUrl} target="_blank">
                Bill {r.qboBillId}
              </s-link>
            );
          }
          if (r.payoutReference) {
            return <s-text tone="subdued">{r.payoutReference}</s-text>;
          }
          if (r.payoutId) {
            return <s-badge tone="success">Paid</s-badge>;
          }
          return "—";
        }
        // Pending/approved — Pause / Resume controls.
        const rowBusy = busy && pendingId === r.id;
        return r.paused ? (
          <s-button
            variant="tertiary"
            {...(rowBusy ? { loading: true } : {})}
            onClick={() => submit({ _action: "resume-commission", commissionId: r.id })}
          >
            Resume
          </s-button>
        ) : (
          <s-button
            variant="tertiary"
            tone="critical"
            {...(rowBusy ? { loading: true } : {})}
            onClick={() => submit({ _action: "pause-commission", commissionId: r.id })}
          >
            Pause
          </s-button>
        );
      },
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      filters={[MIGRATED_FILTER]}
      searchKeys={["practitionerName", "orderName", "status"]}
      searchPlaceholder="Search by practitioner or order"
      description="Commission history accrued by practitioners on attributed orders. Pause holds a commission out of the automated payout run; resume returns it."
      emptyHeading="No commissions yet"
      emptyBody="Commission records will appear here as practitioners earn on attributed orders."
    />
  );
}
