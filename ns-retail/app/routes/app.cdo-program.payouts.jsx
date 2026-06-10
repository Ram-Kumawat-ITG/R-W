/* eslint-disable react/prop-types */
import { useEffect, useRef } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  listPayouts,
  accrueCommissionsForOrders,
  buildPayoutBatch,
  approvePayout,
  rejectPayout,
  executeApprovedPayout,
  checkPayoutSettlement,
} from "../services/cdo/cdo.service";
import DataTable from "../components/cdo/DataTable";
import StatusBadge from "../components/cdo/StatusBadge";
import { formatCurrency, formatDate } from "../utils/format";

// CDO commission payouts — approve-then-auto-execute. Eligible approved
// commissions are aggregated into payout batches (awaiting_approval); an
// admin approves, then execution posts a Vendor Bill + BillPayment to the
// CDO QuickBooks account and settles the commissions. All mutations
// submit to this route's action via a shared fetcher.

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const rows = await listPayouts();
  return { rows };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const actor =
    session?.onlineAccessInfo?.associated_user?.email || session?.shop || "admin";

  const formData = await request.formData();
  const op = String(formData.get("_action") || "").trim();
  const payoutId = formData.get("payoutId");

  try {
    switch (op) {
      case "generate-batch": {
        const periodEndRaw = formData.get("periodEnd");
        const periodEnd = periodEndRaw ? new Date(periodEndRaw) : new Date();
        // 1) Calculate commissions from attributed orders, then 2) batch
        // the eligible (approved, unpaid, above-minimum) ones for approval.
        const accrual = await accrueCommissionsForOrders();
        const { created, skipped } = await buildPayoutBatch({ periodEnd, actor });
        return {
          status: "success",
          op,
          message: `Accrued ${accrual.createdCount} new commission(s); created ${created.length} payout(s); skipped ${skipped.length}.`,
        };
      }
      case "approve": {
        const p = await approvePayout(payoutId, actor);
        return { status: "success", op, message: `Approved payout ${p.reference || ""}`.trim() };
      }
      case "reject": {
        const p = await rejectPayout(payoutId, actor, formData.get("reason") || "");
        return { status: "success", op, message: `Rejected payout ${p.reference || ""}`.trim() };
      }
      case "execute": {
        const p = await executeApprovedPayout(payoutId, { actor });
        if (p.status === "awaiting_settlement") {
          return {
            status: "success",
            op,
            message: `Transfer initiated (${p.providerTransferId}) — awaiting settlement (1–3 business days). QBO Bill ${p.qboBillId}.`,
          };
        }
        if (p.status === "paid") {
          return {
            status: "success",
            op,
            message: `Payout settled — QBO Bill ${p.qboBillId}, payment ${p.qboBillPaymentId}`,
          };
        }
        return {
          status: "error",
          op,
          message: `Payout ${p.status}${p.lastError ? `: ${p.lastError}` : ""}`,
        };
      }
      case "check-settlement": {
        const res = await checkPayoutSettlement(payoutId, { actor, source: "admin" });
        const message =
          res.status === "paid"
            ? "Transfer settled — payout marked paid."
            : res.status === "failed"
              ? "Transfer returned/failed — payout marked failed (retry once banking is fixed)."
              : "Still settling — funds not yet confirmed. Check back later.";
        return { status: res.status === "failed" ? "error" : "success", op, message };
      }
      default:
        return { status: "error", op, message: `Unknown action: ${op}` };
    }
  } catch (e) {
    console.error(`[cdo-program/payouts] action ${op} failed:`, e?.message || e);
    return { status: "error", op, message: e?.message || "Action failed" };
  }
};

const period = (r) =>
  r.periodStart || r.periodEnd
    ? `${formatDate(r.periodStart)} – ${formatDate(r.periodEnd)}`
    : "—";

export default function CdoPayouts() {
  const { rows } = useLoaderData();
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const handledRef = useRef(null);

  const busy = fetcher.state === "submitting" || fetcher.state === "loading";
  const pendingId = busy ? fetcher.formData?.get("payoutId") : null;
  const pendingOp = busy ? fetcher.formData?.get("_action") : null;

  // Surface action results as toasts once per response.
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

  const onGenerate = () =>
    submit(
      { _action: "generate-batch" },
      {
        confirmText:
          "Generate payout batch from all eligible approved commissions (up to today)?",
      },
    );

  const rowBusy = (r, op) => busy && pendingId === r.id && pendingOp === op;

  const columns = [
    { key: "practitionerName", header: "Practitioner" },
    {
      key: "amount",
      header: "Amount",
      render: (r) => formatCurrency(r.amount, r.currency),
    },
    {
      key: "commissionCount",
      header: "Commissions",
      render: (r) => r.commissionCount ?? 0,
    },
    { key: "period", header: "Period", render: period },
    {
      key: "status",
      header: "Status",
      render: (r) => <StatusBadge status={r.status} />,
    },
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
                    { confirmText: `Reject payout for ${r.practitionerName}? Its commissions are released back to the pool.` },
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
                        ? `Retry payout for ${r.practitionerName}? This initiates a NEW bank transfer for ${formatCurrency(r.amount, r.currency)}.`
                        : `Execute payout for ${r.practitionerName}? This records the QBO Bill and initiates a real bank transfer of ${formatCurrency(r.amount, r.currency)} to their account on file.`,
                  },
                )
              }
            >
              {r.status === "failed" ? "Retry" : "Execute"}
            </s-button>
          )}
          {r.status === "awaiting_settlement" && (
            <s-button
              variant="secondary"
              {...(rowBusy(r, "check-settlement") ? { loading: true } : {})}
              onClick={() => submit({ _action: "check-settlement", payoutId: r.id })}
            >
              Sync settlement
            </s-button>
          )}
          {r.status === "failed" && (r.returnReason || r.lastError) ? (
            <s-text tone="critical">{r.returnReason || r.lastError}</s-text>
          ) : null}
        </s-stack>
      ),
    },
  ];

  return (
    <s-stack direction="block" gap="base">
      <s-section padding="base">
        <s-stack
          direction="inline"
          gap="base"
          alignItems="center"
          justifyContent="space-between"
        >
          <s-paragraph tone="subdued">
            Aggregate eligible approved commissions into payout batches. Approve,
            then Execute to record the QBO Vendor Bill and initiate a real bank
            transfer to the practitioner&rsquo;s account on file. The payout stays
            in <strong>Awaiting settlement</strong> until funds confirm (1–3
            business days); a returned transfer flips it to Failed for retry.
            Payouts below the program minimum are skipped.
          </s-paragraph>
          <s-button
            variant="primary"
            {...(busy && pendingOp === "generate-batch" ? { loading: true } : {})}
            onClick={onGenerate}
          >
            Generate payout batch
          </s-button>
        </s-stack>
      </s-section>

      <DataTable
        columns={columns}
        rows={rows}
        searchKeys={["practitionerName", "method", "status", "reference"]}
        searchPlaceholder="Search by practitioner, method, or status"
        emptyHeading="No payouts yet"
        emptyBody="Generate a payout batch to aggregate eligible commissions for approval."
      />
    </s-stack>
  );
}
