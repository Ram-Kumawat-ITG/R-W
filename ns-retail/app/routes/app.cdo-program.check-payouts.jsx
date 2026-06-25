/* eslint-disable react/prop-types */
import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  listCheckPayouts,
  approvePayout,
  rejectPayout,
  markCheckPayoutPaid,
} from "../services/cdo/cdo.service";
import StatusBadge from "../components/cdo/StatusBadge";
import { formatCurrency, formatDate, formatDateTime } from "../utils/format";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const rows = await listCheckPayouts();
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
      case "approve": {
        const p = await approvePayout(payoutId, actor);
        return {
          status: "success",
          op,
          message: `Check payout approved for ${p.practitionerName || p.practitionerEmail || payoutId}`,
        };
      }
      case "reject": {
        const p = await rejectPayout(payoutId, actor, formData.get("reason") || "");
        return {
          status: "success",
          op,
          message: `Rejected check payout ${p.reference || ""}`.trim(),
        };
      }
      case "mark-check-paid": {
        const checkNumber = String(formData.get("checkNumber") || "").trim();
        const checkDate = String(formData.get("checkDate") || "").trim();
        const notes = String(formData.get("notes") || "").trim();
        if (!checkNumber) return { status: "error", op, message: "Check number is required" };
        if (!checkDate) return { status: "error", op, message: "Check date is required" };
        const p = await markCheckPayoutPaid(payoutId, { checkNumber, checkDate, notes, actor });
        return {
          status: "success",
          op,
          message: `Check #${checkNumber} marked paid — $${(p.amount || 0).toFixed(2)} to ${p.practitionerName || p.practitionerEmail}`,
        };
      }
      default:
        return { status: "error", op, message: `Unknown action: ${op}` };
    }
  } catch (e) {
    console.error(`[cdo-program/check-payouts] action ${op} failed:`, e?.message || e);
    return { status: "error", op, message: e?.message || "Action failed" };
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const period = (r) =>
  r.periodStart || r.periodEnd
    ? `${formatDate(r.periodStart)} – ${formatDate(r.periodEnd)}`
    : "—";

// ── Mark-as-Paid inline form ──────────────────────────────────────────────────

function MarkPaidForm({ payoutId, practitionerName, amount, currency, onCancel, onSubmit, busy }) {
  const [checkNumber, setCheckNumber] = useState("");
  const [checkDate, setCheckDate] = useState("");
  const [notes, setNotes] = useState("");

  const handleSubmit = () => {
    if (!checkNumber.trim()) {
      alert("Check number is required.");
      return;
    }
    if (!checkDate.trim()) {
      alert("Check date is required.");
      return;
    }
    onSubmit({ payoutId, checkNumber, checkDate, notes });
  };

  return (
    <s-box
      padding="base"
      background="bg-surface-secondary"
      border-color="border"
      border-width="base"
      border-radius="base"
    >
      <s-stack direction="block" gap="small-200">
        <s-text variant="headingSm">
          Mark Check as Paid — {practitionerName} ({formatCurrency(amount, currency)})
        </s-text>
        <s-stack direction="inline" gap="base" wrap>
          <s-text-field
            label="Check Number *"
            placeholder="e.g. 1042"
            value={checkNumber}
            onInput={(e) => setCheckNumber(e.target.value)}
            onChange={(e) => setCheckNumber(e.target.value)}
          />
          <s-text-field
            label="Check Date * (YYYY-MM-DD)"
            type="date"
            value={checkDate}
            onInput={(e) => setCheckDate(e.target.value)}
            onChange={(e) => setCheckDate(e.target.value)}
          />
        </s-stack>
        <s-text-field
          label="Notes (optional)"
          placeholder="e.g. Mailed to 123 Main St, sent via USPS"
          value={notes}
          onInput={(e) => setNotes(e.target.value)}
          onChange={(e) => setNotes(e.target.value)}
        />
        <s-stack direction="inline" gap="small-200">
          <s-button
            variant="primary"
            {...(busy ? { loading: true } : {})}
            onClick={handleSubmit}
          >
            Confirm — Mark as Paid
          </s-button>
          <s-button variant="tertiary" onClick={onCancel}>
            Cancel
          </s-button>
        </s-stack>
      </s-stack>
    </s-box>
  );
}

// ── CheckPayoutCard ───────────────────────────────────────────────────────────

function CheckPayoutCard({ row, onApprove, onReject, onMarkPaid, busy, pendingOp }) {
  const [showAudit, setShowAudit] = useState(false);

  const isBusy = (op) =>
    busy && pendingOp?.payoutId === row.id && pendingOp?.op === op;

  const isPending = !["paid", "rejected", "cancelled"].includes(row.status);

  return (
    <s-box
      padding="base"
      background="bg-surface"
      border-color="border"
      border-width="base"
      border-radius="base"
    >
      <s-stack direction="block" gap="small-200">

        {/* Header row: name, email, status badge, action buttons */}
        <s-stack direction="inline" gap="base" wrap alignItems="center">
          <s-box flex="1">
            <s-stack direction="block" gap="none">
              <s-text variant="headingSm">{row.practitionerName}</s-text>
              {row.practitionerEmail !== "—" && (
                <s-text tone="subdued">{row.practitionerEmail}</s-text>
              )}
            </s-stack>
          </s-box>
          <StatusBadge status={row.status} />
          {isPending && (
            <s-stack direction="inline" gap="small-200">
              {(row.status === "awaiting_approval" || row.status === "draft") && (
                <>
                  <s-button
                    variant="primary"
                    {...(isBusy("approve") ? { loading: true } : {})}
                    onClick={() => onApprove(row.id)}
                  >
                    Approve
                  </s-button>
                  <s-button
                    variant="tertiary"
                    tone="critical"
                    {...(isBusy("reject") ? { loading: true } : {})}
                    onClick={() => onReject(row.id, row.practitionerName)}
                  >
                    Reject
                  </s-button>
                </>
              )}
              {row.status === "approved" && (
                <s-button
                  variant="primary"
                  {...(isBusy("mark-check-paid") ? { loading: true } : {})}
                  onClick={() => onMarkPaid(row.id)}
                >
                  Mark as Paid
                </s-button>
              )}
            </s-stack>
          )}
        </s-stack>

        {/* Detail fields */}
        <s-stack direction="inline" gap="large" wrap>
          <s-stack direction="block" gap="none">
            <s-text tone="subdued">Referral Code(s)</s-text>
            <s-text>
              {row.referralCodes.length ? row.referralCodes.join(", ") : "—"}
            </s-text>
          </s-stack>
          <s-stack direction="block" gap="none">
            <s-text tone="subdued">Orders Included</s-text>
            <s-text>{row.commissionCount}</s-text>
          </s-stack>
          <s-stack direction="block" gap="none">
            <s-text tone="subdued">Total Amount Owed</s-text>
            <s-text variant="headingSm">{formatCurrency(row.amount, row.currency)}</s-text>
          </s-stack>
          <s-stack direction="block" gap="none">
            <s-text tone="subdued">Payout Period</s-text>
            <s-text>{period(row)}</s-text>
          </s-stack>
          <s-stack direction="block" gap="none">
            <s-text tone="subdued">Reference</s-text>
            <s-text>{row.reference || "—"}</s-text>
          </s-stack>
        </s-stack>

        {/* Banking error notice (why this is a check payout) */}
        {row.bankingError && (
          <s-box padding="small-200" background="bg-surface-secondary" border-radius="base">
            <s-text tone="critical">No ACH banking: {row.bankingError}</s-text>
          </s-box>
        )}

        {/* Check payment details — shown once marked paid */}
        {row.status === "paid" && row.checkDetails && (
          <s-box padding="small-200" background="bg-surface-secondary" border-radius="base">
            <s-stack direction="inline" gap="large" wrap>
              <s-stack direction="block" gap="none">
                <s-text tone="subdued">Check Number</s-text>
                <s-text variant="headingSm">{row.checkDetails.checkNumber || "—"}</s-text>
              </s-stack>
              <s-stack direction="block" gap="none">
                <s-text tone="subdued">Check Date</s-text>
                <s-text>{formatDate(row.checkDetails.checkDate)}</s-text>
              </s-stack>
              <s-stack direction="block" gap="none">
                <s-text tone="subdued">Processed By</s-text>
                <s-text>{row.checkDetails.issuedBy || "—"}</s-text>
              </s-stack>
              <s-stack direction="block" gap="none">
                <s-text tone="subdued">Processed Date</s-text>
                <s-text>{formatDateTime(row.checkDetails.issuedAt)}</s-text>
              </s-stack>
              {row.checkDetails.notes && (
                <s-stack direction="block" gap="none">
                  <s-text tone="subdued">Notes</s-text>
                  <s-text>{row.checkDetails.notes}</s-text>
                </s-stack>
              )}
            </s-stack>
          </s-box>
        )}

        {/* Audit trail toggle */}
        <s-stack direction="inline" gap="none">
          <s-button variant="plain" onClick={() => setShowAudit((v) => !v)}>
            {showAudit ? "Hide audit trail" : "View audit trail"}
          </s-button>
        </s-stack>

        {showAudit && (
          <s-box padding="small-200" background="bg-surface-secondary" border-radius="base">
            {row.remarks.length === 0 ? (
              <s-text tone="subdued">No audit entries yet.</s-text>
            ) : (
              <s-stack direction="block" gap="small-100">
                {row.remarks
                  .slice()
                  .reverse()
                  .map((rem, i) => (
                    <s-stack
                      key={i}
                      direction="inline"
                      gap="base"
                      wrap
                      alignItems="flex-start"
                    >
                      <s-box min-inline-size="140px">
                        <s-text tone="subdued">{formatDateTime(rem.createdAt)}</s-text>
                      </s-box>
                      <s-box min-inline-size="120px">
                        <s-text tone="subdued">{rem.kind}</s-text>
                      </s-box>
                      <s-box flex="1">
                        <s-text>{rem.message}</s-text>
                      </s-box>
                      {rem.actor && (
                        <s-text tone="subdued">— {rem.actor}</s-text>
                      )}
                    </s-stack>
                  ))}
              </s-stack>
            )}
          </s-box>
        )}

      </s-stack>
    </s-box>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CheckPayouts() {
  const { rows } = useLoaderData();
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const handledRef = useRef(null);

  // ID of the payout currently open in the "Mark as Paid" form
  const [markingId, setMarkingId] = useState(null);

  const busy = fetcher.state === "submitting" || fetcher.state === "loading";
  const pendingPayoutId = busy ? fetcher.formData?.get("payoutId") : null;
  const pendingOp = busy ? fetcher.formData?.get("_action") : null;

  // Toast on action completion
  useEffect(() => {
    if (!fetcher.data || fetcher.state !== "idle") return;
    if (handledRef.current === fetcher.data) return;
    handledRef.current = fetcher.data;
    if (fetcher.data.status === "success") {
      shopify?.toast?.show(fetcher.data.message || "Done");
      if (fetcher.data.op === "mark-check-paid") setMarkingId(null);
    } else {
      shopify?.toast?.show(fetcher.data.message || "Action failed", { isError: true });
    }
  }, [fetcher.data, fetcher.state, shopify]);

  const submit = (payload, { confirmText } = {}) => {
    if (confirmText && !confirm(confirmText)) return;
    fetcher.submit(payload, { method: "POST" });
  };

  const onApprove = (payoutId) => submit({ _action: "approve", payoutId });

  const onReject = (payoutId, name) =>
    submit(
      { _action: "reject", payoutId },
      {
        confirmText: `Reject check payout for ${name}? Commissions will be released back to the pool.`,
      },
    );

  const onMarkPaid = (payoutId) => setMarkingId(payoutId);

  const onMarkPaidSubmit = ({ payoutId, checkNumber, checkDate, notes }) =>
    submit({ _action: "mark-check-paid", payoutId, checkNumber, checkDate, notes });

  const pending = rows.filter(
    (r) => !["paid", "rejected", "cancelled"].includes(r.status),
  );
  const completed = rows.filter((r) =>
    ["paid", "rejected", "cancelled"].includes(r.status),
  );

  const markingRow = markingId ? rows.find((r) => r.id === markingId) : null;

  return (
    <s-stack direction="block" gap="base">

      {/* Explainer */}
      <s-section padding="base">
        <s-paragraph tone="subdued">
          Practitioners without valid ACH banking are automatically queued here
          when a payout batch is generated. Approve the payout, physically issue
          a check, then record the check number and date below. Commissions are
          settled and excluded from future automated ACH batches once marked paid.
        </s-paragraph>
      </s-section>

      {/* Mark-as-Paid form — shown inline above the queue when active */}
      {markingRow && (
        <s-section heading="Mark Check as Paid">
          <MarkPaidForm
            payoutId={markingRow.id}
            practitionerName={markingRow.practitionerName}
            amount={markingRow.amount}
            currency={markingRow.currency}
            onCancel={() => setMarkingId(null)}
            onSubmit={onMarkPaidSubmit}
            busy={
              busy &&
              pendingPayoutId === markingRow.id &&
              pendingOp === "mark-check-paid"
            }
          />
        </s-section>
      )}

      {/* Pending queue */}
      <s-section heading={`Pending Check Payouts (${pending.length})`}>
        {pending.length === 0 ? (
          <s-box padding="base" background="bg-surface-secondary" border-radius="base">
            <s-text tone="subdued">
              No pending check payouts. Check payouts are created automatically
              when a payout batch is generated for practitioners who have no valid
              ACH banking on file.
            </s-text>
          </s-box>
        ) : (
          <s-stack direction="block" gap="small-200">
            {pending.map((r) => (
              <CheckPayoutCard
                key={r.id}
                row={r}
                onApprove={onApprove}
                onReject={onReject}
                onMarkPaid={onMarkPaid}
                busy={busy}
                pendingOp={{ payoutId: pendingPayoutId, op: pendingOp }}
              />
            ))}
          </s-stack>
        )}
      </s-section>

      {/* Completed payouts */}
      {completed.length > 0 && (
        <s-section heading={`Completed Check Payouts (${completed.length})`}>
          <s-stack direction="block" gap="small-200">
            {completed.map((r) => (
              <CheckPayoutCard
                key={r.id}
                row={r}
                onApprove={onApprove}
                onReject={onReject}
                onMarkPaid={onMarkPaid}
                busy={busy}
                pendingOp={{ payoutId: pendingPayoutId, op: pendingOp }}
              />
            ))}
          </s-stack>
        </s-section>
      )}

    </s-stack>
  );
}
