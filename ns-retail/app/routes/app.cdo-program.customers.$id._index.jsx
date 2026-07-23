/* eslint-disable react/prop-types */
// This file defines a `CreateCodeModal` sub-component plus a small `DetailRow`
// helper, each with props referenced inside their JSX. The project doesn't
// ship PropTypes anywhere — adding them just to satisfy the linter would be
// more boilerplate than signal. File-scope disable is consistent with how the
// wholesale workspace handles similar internal components.

import { forwardRef, useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getPractitionerProfile,
  listPractitionerCodes,
  getPractitionerKpis,
  listPractitionerPayouts,
  getSettings,
} from "../services/cdo/cdo.service";
import MetricCard from "../components/cdo/MetricCard";
import StatusBadge from "../components/cdo/StatusBadge";
import { MigratedBadge } from "../components/cdo/MigratedBadge";
import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatNumber,
  formatPercent,
} from "../utils/format";

// Details tab — the practitioner overview that the user sees by default
// when opening a CDO Customer. Shows:
//   1. Statistics grid (orders, revenue, commissions, payouts, referrals,
//      conversion rate) — driven by getPractitionerKpis().
//   2. Referral codes section — the practitioner's owned codes with a
//      Pause/Resume action (+ Copy). Pause/Resume submits to the parent
//      layout's action handler, which deactivates/reactivates the backing
//      Shopify discount and auto-revalidates this loader on settle. Code
//      create / edit / delete / set-primary were removed — codes are now
//      created by practitioners in the Practitioner Portal.
//   3. Profile reference card — name, email, status, customer id,
//      country, joined date.
//
// Date-range filter chips at the top of the page mirror the design
// reference. They scope the KPIs (NOT the code list — codes are
// catalogue items, not time-bound).

const DATE_FILTERS = [
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "90d", label: "Last 90 days", days: 90 },
  { id: "ytd", label: "Year to date" },
  { id: "all", label: "All time" },
];

function resolveDateRange(rangeId) {
  if (!rangeId || rangeId === "all") return { dateFrom: null, dateTo: null };
  if (rangeId === "ytd") {
    return {
      dateFrom: new Date(new Date().getFullYear(), 0, 1),
      dateTo: null,
    };
  }
  const opt = DATE_FILTERS.find((f) => f.id === rangeId);
  if (!opt?.days) return { dateFrom: null, dateTo: null };
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - opt.days);
  return { dateFrom, dateTo: null };
}

// The referral-code mutations on this tab submit via `fetcher.submit(...,
// { method: "POST" })` with NO explicit action, so React Router targets the
// leaf route for this URL — which is THIS index route, not the parent layout.
// The CRUD action implementation lives on the layout ($id.jsx) as the single
// source of truth; we re-export it here so the leaf route can actually serve
// the submission. After it settles, RR auto-revalidates both this loader and
// the layout loader, so the code list refreshes without manual orchestration.
export { action } from "./app.cdo-program.customers.$id.jsx";

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const range = url.searchParams.get("range") || "30d";

  const profile = await getPractitionerProfile(params.id);
  if (!profile) {
    throw new Response("Practitioner not found", { status: 404 });
  }

  const [codes, kpis, payouts, settings] = await Promise.all([
    listPractitionerCodes(params.id),
    getPractitionerKpis(params.id, resolveDateRange(range)),
    listPractitionerPayouts(params.id),
    getSettings(),
  ]);

  return { profile, codes, kpis, payouts, settings, range };
};

export default function CdoCustomerDetails() {
  const { profile, codes, kpis, payouts, settings, range } = useLoaderData();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();
  const codeFetcher = useFetcher();

  const [showCreateModal, setShowCreateModal] = useState(false);
  const createModalRef = useRef(null);
  const handledResultRef = useRef(null);

  // Surface action results as toasts. The parent layout's action
  // returns `{ status, op, message }` — settle once per response so
  // RR's auto-revalidation doesn't replay the toast on every render.
  useEffect(() => {
    if (!codeFetcher.data) return;
    if (codeFetcher.state !== "idle") return;
    if (handledResultRef.current === codeFetcher.data) return;
    handledResultRef.current = codeFetcher.data;

    const d = codeFetcher.data;
    if (d.status === "success") {
      shopify?.toast?.show(d.message || "Saved");
      // Close the create modal — the change has landed.
      createModalRef.current?.hideOverlay?.();
      setShowCreateModal(false);
    } else {
      shopify?.toast?.show(d.message || "Action failed", { isError: true });
    }
  }, [codeFetcher.data, codeFetcher.state, shopify]);

  const setRange = (id) => {
    const params = new URLSearchParams(window.location.search);
    if (id === "30d") params.delete("range");
    else params.set("range", id);
    const next = `?${params.toString()}`;
    // History push so back-button reverts the range, mirroring the
    // existing CDO list filters.
    window.history.pushState({}, "", next);
    revalidator.revalidate();
  };

  // The "primary" code drives the storefront link. We surface its
  // value in the Profile card and use it as the source for the
  // "Copy referral link" button. Falls back to the first active code
  // when no primary is set, mirroring getPrimaryCode in cdo.service.js.
  const primaryCode =
    codes.find((c) => c.isPrimary && c.status === "active") ||
    codes.find((c) => c.status === "active") ||
    null;
  const referralLink = primaryCode
    ? `https://nsdirectorder.com/${encodeURIComponent(primaryCode.code.toLowerCase())}`
    : null;


  const onCopyReferralLink = async () => {
    if (!referralLink) return;
    try {
      await navigator.clipboard.writeText(referralLink);
      shopify?.toast?.show("Referral link copied");
    } catch {
      shopify?.toast?.show("Could not copy link", { isError: true });
    }
  };

  const onCopyCode = async (codeRow) => {
    try {
      await navigator.clipboard.writeText(codeRow.code);
      shopify?.toast?.show(`Copied ${codeRow.code}`);
    } catch {
      shopify?.toast?.show("Could not copy", { isError: true });
    }
  };

  const onOpenCreate = () => {
    setShowCreateModal(true);
    createModalRef.current?.showOverlay?.();
  };

  // Pause / resume. Pausing deactivates the backing Shopify discount (the code
  // stops applying on the storefront) AND flips the DB status; resuming
  // reactivates it. The layout action owns the Shopify toggle.
  const onToggleStatus = (codeRow) => {
    const nextStatus = codeRow.status === "active" ? "paused" : "active";
    codeFetcher.submit(
      { _action: "set-code-status", codeId: codeRow.id, status: nextStatus },
      { method: "POST" },
    );
  };

  const mutating =
    codeFetcher.state === "submitting" || codeFetcher.state === "loading";

  return (
    <>
      <s-section heading="Statistics">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200" wrap>
            {DATE_FILTERS.map((f) => (
              <s-clickable-chip
                key={f.id}
                color={range === f.id ? "strong" : "base"}
                accessibilityLabel={`Filter statistics: ${f.label}`}
                onClick={() => setRange(f.id)}
              >
                {f.label}
              </s-clickable-chip>
            ))}
          </s-stack>

          <s-grid gap="base" gridTemplateColumns="repeat(4, minmax(0, 1fr))">
            <MetricCard
              label="Total orders"
              value={formatNumber(kpis.totalOrders)}
            />
            <MetricCard
              label="Revenue"
              value={formatCurrency(kpis.totalRevenue, settings.currency)}
            />
            <MetricCard
              label="Commissions"
              value={formatCurrency(kpis.totalCommissions, settings.currency)}
              tone="success"
            />
            <MetricCard
              label="Referred patients"
              value={formatNumber(kpis.totalReferrals)}
              sublabel={`${formatNumber(kpis.convertedReferrals)} converted`}
            />
          </s-grid>
        </s-stack>
      </s-section>

      <s-section heading="Commission & payout summary">
        <s-grid gap="base" gridTemplateColumns="repeat(4, minmax(0, 1fr))">
          <MetricCard
            label="Commission earned"
            value={formatCurrency(kpis.totalCommissionEarned, settings.currency)}
            sublabel="Lifetime, excl. reversed"
          />
          <MetricCard
            label="Commission paid"
            value={formatCurrency(kpis.totalCommissionPaid, settings.currency)}
            tone="success"
          />
          <MetricCard
            label="Pending commissions"
            value={formatCurrency(kpis.pendingCommissions, settings.currency)}
            tone={kpis.pendingCommissions > 0 ? "critical" : undefined}
            sublabel="Earned, not yet paid"
          />
          <MetricCard
            label="Upcoming payout"
            value={formatCurrency(kpis.upcomingPayoutAmount, settings.currency)}
            sublabel={
              kpis.upcomingPayoutAmount > 0
                ? `Est. ${formatDate(kpis.nextPayoutDate)}`
                : kpis.lastPayoutDate
                  ? `Last paid ${formatDate(kpis.lastPayoutDate)}`
                  : `Below ${formatCurrency(kpis.minimumPayoutAmount, settings.currency)} minimum`
            }
          />
        </s-grid>
      </s-section>

      <s-section heading={`Payout history (${payouts.length})`}>
        {payouts.length === 0 ? (
          <s-paragraph tone="subdued">
            No payouts yet. Payouts appear here once this practitioner&apos;s commissions clear
            the minimum and a payout cycle runs.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Reference</s-table-header>
              <s-table-header>Amount</s-table-header>
              <s-table-header>Commissions</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Period end</s-table-header>
              <s-table-header>Paid</s-table-header>
              <s-table-header>QBO bill</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {payouts.map((p) => (
                <s-table-row key={p.id}>
                  <s-table-cell>{p.reference || "—"}</s-table-cell>
                  <s-table-cell>{formatCurrency(p.amount, p.currency)}</s-table-cell>
                  <s-table-cell>{formatNumber(p.commissionCount)}</s-table-cell>
                  <s-table-cell>
                    <StatusBadge status={p.status} />
                  </s-table-cell>
                  <s-table-cell>{p.periodEnd ? formatDate(p.periodEnd) : "—"}</s-table-cell>
                  <s-table-cell>{p.paidAt ? formatDate(p.paidAt) : "—"}</s-table-cell>
                  <s-table-cell>
                    {p.qboBillUrl ? (
                      <s-link href={p.qboBillUrl} target="_blank">
                        Bill {p.qboBillId}
                      </s-link>
                    ) : (
                      "—"
                    )}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Profile">
        <s-grid
          gap="base"
          gridTemplateColumns="repeat(2, minmax(0, 1fr))"
        >
          <DetailRow label="Practitioner name" value={profile.name || "—"} />
          <DetailRow label="Email" value={profile.email || "—"} />
          <DetailRow label="Phone" value={profile.phone || "—"} />
          <DetailRow label="Business name" value={profile.businessName || "—"} />
          <DetailRow label="Customer ID" value={profile.customerId || "—"} />
          <DetailRow label="Country" value={profile.country || "—"} />
          <DetailRow
            label="Registered"
            value={formatDateTime(profile.submittedAt)}
          />
          <DetailRow
            label="Primary discount"
            value={
              primaryCode
                ? formatPercent(primaryCode.discountPercent)
                : "—"
            }
            hint={primaryCode ? `From code ${primaryCode.code}` : "No primary code"}
          />
          <DetailRow
            label="Referral link"
            value={referralLink || "—"}
            actions={
              referralLink
                ? [
                    {
                      label: "Copy",
                      onClick: onCopyReferralLink,
                    },
                  ]
                : null
            }
          />
        </s-grid>
      </s-section>

      <s-section heading={`Referral codes (${codes.length})`}>
        <s-stack direction="block" gap="base">
          <s-stack
            direction="inline"
            gap="base"
            alignItems="center"
            justifyContent="space-between"
          >
            <s-paragraph tone="subdued">
              Pausing a code deactivates its discount on the storefront and stops
              new attributions; resuming re-enables it. Historical commissions
              stay locked at the rate captured at attribution time.
            </s-paragraph>
            <s-button
              variant="primary"
              onClick={onOpenCreate}
              {...(mutating ? { loading: true } : {})}
            >
              Add referral code
            </s-button>
          </s-stack>

          {codes.length === 0 ? (
            <s-box padding="large-500">
              <s-stack
                direction="block"
                gap="base"
                alignItems="center"
                justifyContent="center"
              >
                <s-heading>No referral codes yet</s-heading>
                <s-paragraph tone="subdued">
                  Add a code to give this practitioner a shareable link, or let
                  them create their own from the Practitioner Portal.
                </s-paragraph>
                <s-button variant="primary" onClick={onOpenCreate}>
                  Add referral code
                </s-button>
              </s-stack>
            </s-box>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>Code</s-table-header>
                <s-table-header>Discount</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header>Created</s-table-header>
                <s-table-header>Referral link</s-table-header>
                <s-table-header>Actions</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {codes.map((c) => (
                  <s-table-row key={c.id}>
                    <s-table-cell>
                      <s-stack direction="block" gap="none">
                        <s-text>{c.code}</s-text>
                        {c.note && <s-text tone="subdued">{c.note}</s-text>}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      {formatPercent(c.discountPercent)}
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small-200" alignItems="center">
                        <s-badge
                          tone={
                            c.status === "active"
                              ? "success"
                              : c.status === "paused"
                                ? "warning"
                                : "neutral"
                          }
                        >
                          {c.status}
                        </s-badge>
                        <MigratedBadge migrated={c.migrated} />
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{formatDateTime(c.createdAt)}</s-table-cell>
                    <s-table-cell>
                      {c.referralUrl ? (
                        <s-link href={c.referralUrl} target="_blank">
                          {c.referralUrl}
                        </s-link>
                      ) : (
                        <s-text tone="subdued">Not generated yet</s-text>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small-200">
                        <s-button
                          variant="tertiary"
                          onClick={() => onCopyCode(c)}
                        >
                          Copy
                        </s-button>
                        {/* Pause (active) / Resume (paused). Archived codes
                            can't be toggled. Shows a loading state while a
                            mutation is in flight. */}
                        {c.status !== "archived" && (
                          <s-button
                            variant="tertiary"
                            onClick={() => onToggleStatus(c)}
                            {...(mutating ? { loading: true } : {})}
                          >
                            {c.status === "active" ? "Pause" : "Resume"}
                          </s-button>
                        )}
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-stack>
      </s-section>

      <CreateCodeModal
        ref={createModalRef}
        open={showCreateModal}
        onClose={() => {
          createModalRef.current?.hideOverlay?.();
          setShowCreateModal(false);
        }}
        fetcher={codeFetcher}
      />
    </>
  );
}

// eslint-disable-next-line react/prop-types
function DetailRow({ label, value, hint, actions }) {
  return (
    <s-stack direction="block" gap="none">
      <s-text tone="subdued">{label}</s-text>
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-text>{value || "—"}</s-text>
        {actions?.map((a, i) => (
          <s-button key={i} variant="tertiary" onClick={a.onClick}>
            {a.label}
          </s-button>
        ))}
      </s-stack>
      {hint && <s-text tone="subdued">{hint}</s-text>}
    </s-stack>
  );
}

// Admin "Add referral code" modal. Code is required; Discount % is optional
// (blank = a 0% / attribution-only code with no storefront discount; a discount
// creates the backing Shopify discount on the retail store). There is NO
// commission field — commission is configured per product VENDOR (Settings →
// Commission Configuration), never per practitioner.
// eslint-disable-next-line react/display-name
const CreateCodeModal = forwardRef(function CreateCodeModal(
  { open, onClose, fetcher },
  ref,
) {
  const [code, setCode] = useState("");
  const [discountPercent, setDiscountPercent] = useState("20");

  // Reset on open so a previous draft doesn't leak into the next create.
  useEffect(() => {
    if (open) {
      setCode("");
      setDiscountPercent("");
    }
  }, [open]);

  const submit = () => {
    fetcher.submit(
      {
        _action: "create-code",
        code,
        // Optional — send "" when blank so the action's parseFractionField
        // resolves it to null (discount → 0%, attribution only).
        discountPercent: discountPercent === "" ? "" : String(discountPercent),
      },
      { method: "POST" },
    );
  };

  const submitting =
    fetcher.state === "submitting" || fetcher.state === "loading";

  return (
    <s-modal
      ref={ref}
      id="cdo-create-code-modal"
      heading="Add referral code"
      accessibilityLabel="Create referral code"
    >
      <s-stack direction="block" gap="base">
        <s-text-field
          label="Code"
          placeholder="e.g. WELCOME20"
          value={code}
          required
          onChange={(e) => setCode(e.currentTarget.value)}
          details="3–40 characters · letters, digits, hyphens · auto-uppercased"
        />
        <s-text-field
          label="Discount %"
          type="number"
          min="0"
          max="100"
          step="0.01"
          value={discountPercent}
          onChange={(e) => setDiscountPercent(e.currentTarget.value)}
          details="Optional. Customer-facing discount at checkout — creates a matching Shopify discount. Blank = no discount (attribution only)."
        />
      </s-stack>
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={submit}
        {...(submitting ? { loading: true } : {})}
      >
        Create code
      </s-button>
      <s-button slot="secondary-actions" onClick={onClose}>
        Cancel
      </s-button>
    </s-modal>
  );
});
