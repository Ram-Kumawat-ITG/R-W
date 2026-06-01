/* eslint-disable react/prop-types */
// This file defines two self-contained modal sub-components
// (`CreateCodeModal`, `EditCodeModal`) plus a small `DetailRow` helper,
// each with multiple props referenced inside their JSX. The project
// doesn't ship PropTypes anywhere — adding them just to satisfy the
// linter would be more boilerplate than signal. File-scope disable
// is consistent with how the wholesale workspace handles similar
// internal components.

import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getPractitionerProfile,
  listPractitionerCodes,
  getPractitionerKpis,
  getSettings,
} from "../services/cdo/cdo.service";
import MetricCard from "../components/cdo/MetricCard";
import {
  formatCurrency,
  formatDateTime,
  formatNumber,
  formatPercent,
} from "../utils/format";

// Details tab — the practitioner overview that the user sees by default
// when opening a CDO Customer. Shows:
//   1. Statistics grid (orders, revenue, commissions, payouts, referrals,
//      conversion rate) — driven by getPractitionerKpis().
//   2. Referral codes section — the practitioner's owned codes with
//      create / edit / delete / set-primary actions. Mutations submit
//      to the parent layout's action handler, which auto-revalidates
//      this loader on settle.
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

  const [codes, kpis, settings] = await Promise.all([
    listPractitionerCodes(params.id),
    getPractitionerKpis(params.id, resolveDateRange(range)),
    getSettings(),
  ]);

  return { profile, codes, kpis, settings, range };
};

export default function CdoCustomerDetails() {
  const { profile, codes, kpis, settings, range } = useLoaderData();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();
  const codeFetcher = useFetcher();

  const [editingCode, setEditingCode] = useState(null); // null | code row
  const [showCreateModal, setShowCreateModal] = useState(false);
  const editModalRef = useRef(null);
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
      // Close any open modal — the change has landed.
      editModalRef.current?.hideOverlay?.();
      createModalRef.current?.hideOverlay?.();
      setEditingCode(null);
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

  // Effective commission rate — primary code's override, else the
  // program default. Shown in the Profile card so admins know what
  // future orders will earn this practitioner.
  const effectiveCommissionRate =
    primaryCode?.commissionRate != null
      ? primaryCode.commissionRate
      : settings.defaultCommissionRate;

  const onCopyReferralLink = async () => {
    if (!referralLink) return;
    try {
      await navigator.clipboard.writeText(referralLink);
      shopify?.toast?.show("Referral link copied");
    } catch {
      shopify?.toast?.show("Could not copy link", { isError: true });
    }
  };

  const onDelete = (codeRow) => {
    if (!confirm(`Delete code "${codeRow.code}"? This cannot be undone.`)) {
      return;
    }
    codeFetcher.submit(
      { _action: "delete-code", codeId: codeRow.id },
      { method: "POST" },
    );
  };

  const onSetPrimary = (codeRow) => {
    codeFetcher.submit(
      { _action: "set-primary-code", codeId: codeRow.id },
      { method: "POST" },
    );
  };

  const onCopyCode = async (codeRow) => {
    try {
      await navigator.clipboard.writeText(codeRow.code);
      shopify?.toast?.show(`Copied ${codeRow.code}`);
    } catch {
      shopify?.toast?.show("Could not copy", { isError: true });
    }
  };

  const onEdit = (codeRow) => {
    setEditingCode(codeRow);
    editModalRef.current?.showOverlay?.();
  };

  const onOpenCreate = () => {
    setShowCreateModal(true);
    createModalRef.current?.showOverlay?.();
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

          <s-grid
            gap="base"
            gridTemplateColumns="repeat(4, minmax(0, 1fr))"
          >
            <MetricCard
              label="Total orders"
              value={formatNumber(kpis.totalOrders)}
            />
            <MetricCard
              label="Revenue"
              value={formatCurrency(kpis.totalRevenue, settings.currency)}
            />
            <MetricCard
              label="Total commissions"
              value={formatCurrency(kpis.totalCommissions, settings.currency)}
              tone="success"
            />
            <MetricCard
              label="Referral customers"
              value={formatNumber(kpis.totalReferrals)}
              sublabel={`${formatNumber(kpis.convertedReferrals)} converted`}
            />
            <MetricCard
              label="Conversion rate"
              value={formatPercent(kpis.conversionRate)}
              sublabel="Converted / total referrals"
            />
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
              label="Active codes"
              value={formatNumber(kpis.activeCodes)}
              sublabel={
                primaryCode
                  ? `Primary: ${primaryCode.code}`
                  : "No primary set"
              }
            />
          </s-grid>
        </s-stack>
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
            label="Effective commission rate"
            value={formatPercent(effectiveCommissionRate)}
            hint={
              primaryCode?.commissionRate != null
                ? "Override on primary code"
                : "Program default (cdo_settings.defaultCommissionRate)"
            }
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
              Codes are normalised to uppercase. Discount + commission edits
              affect ONLY future orders — historical commissions stay locked
              at the rate captured at attribution time.
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
                  Create a code to give this practitioner a shareable link +
                  start earning commissions on attributed orders.
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
                <s-table-header>Commission</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header>Created</s-table-header>
                <s-table-header>Actions</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {codes.map((c) => (
                  <s-table-row key={c.id}>
                    <s-table-cell>
                      <s-stack direction="block" gap="none">
                        <s-stack
                          direction="inline"
                          gap="small-200"
                          alignItems="center"
                        >
                          <s-text>{c.code}</s-text>
                          {c.isPrimary && (
                            <s-badge tone="info">Primary</s-badge>
                          )}
                        </s-stack>
                        {c.note && <s-text tone="subdued">{c.note}</s-text>}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      {formatPercent(c.discountPercent)}
                    </s-table-cell>
                    <s-table-cell>
                      {c.commissionRate != null
                        ? formatPercent(c.commissionRate)
                        : `${formatPercent(settings.defaultCommissionRate)} (default)`}
                    </s-table-cell>
                    <s-table-cell>
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
                    </s-table-cell>
                    <s-table-cell>{formatDateTime(c.createdAt)}</s-table-cell>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small-200">
                        <s-button
                          variant="tertiary"
                          onClick={() => onCopyCode(c)}
                        >
                          Copy
                        </s-button>
                        <s-button
                          variant="tertiary"
                          onClick={() => onEdit(c)}
                        >
                          Edit
                        </s-button>
                        {!c.isPrimary && c.status === "active" && (
                          <s-button
                            variant="tertiary"
                            onClick={() => onSetPrimary(c)}
                          >
                            Set primary
                          </s-button>
                        )}
                        <s-button
                          variant="tertiary"
                          tone="critical"
                          onClick={() => onDelete(c)}
                        >
                          Delete
                        </s-button>
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
        defaultCommissionRate={settings.defaultCommissionRate}
      />
      <EditCodeModal
        ref={editModalRef}
        code={editingCode}
        onClose={() => {
          editModalRef.current?.hideOverlay?.();
          setEditingCode(null);
        }}
        fetcher={codeFetcher}
        defaultCommissionRate={settings.defaultCommissionRate}
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

// Create + Edit modals share most of the form shape; the difference is
// (a) Create has the code field free-form, Edit hands it back disabled
// because admins generally shouldn't rename live codes (storefront
// links would break); and (b) Edit also exposes status switching.
//
// Both submit to the parent layout's action via the same fetcher.

import { forwardRef } from "react";

// eslint-disable-next-line react/display-name
const CreateCodeModal = forwardRef(function CreateCodeModal(
  // eslint-disable-next-line react/prop-types
  { open, onClose, fetcher, defaultCommissionRate },
  ref,
) {
  const [code, setCode] = useState("");
  const [discountPercent, setDiscountPercent] = useState("");
  const [commissionRate, setCommissionRate] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const [note, setNote] = useState("");

  // Reset on open so a previous draft doesn't leak into the next create.
  useEffect(() => {
    if (open) {
      setCode("");
      setDiscountPercent("");
      setCommissionRate("");
      setIsPrimary(false);
      setNote("");
    }
  }, [open]);

  const submit = () => {
    fetcher.submit(
      {
        _action: "create-code",
        code,
        discountPercent: discountPercent === "" ? "" : String(discountPercent),
        commissionRate: commissionRate === "" ? "" : String(commissionRate),
        isPrimary: isPrimary ? "true" : "false",
        note,
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
          placeholder="e.g. WELCOME15"
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
          details="Customer-facing discount at checkout. Leave blank for 0%."
        />
        <s-text-field
          label="Commission %"
          type="number"
          min="0"
          max="100"
          step="0.01"
          value={commissionRate}
          onChange={(e) => setCommissionRate(e.currentTarget.value)}
          details={`Practitioner share. Blank inherits the program default (${(defaultCommissionRate * 100).toFixed(0)}%).`}
        />
        <s-checkbox
          label="Set as primary code"
          details="Replaces this practitioner's existing primary, if any."
          checked={isPrimary}
          onChange={(e) => setIsPrimary(Boolean(e.currentTarget.checked))}
        />
        <s-text-area
          label="Note (optional)"
          value={note}
          rows={2}
          onChange={(e) => setNote(e.currentTarget.value)}
          maxLength={500}
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

// eslint-disable-next-line react/display-name
const EditCodeModal = forwardRef(function EditCodeModal(
  // eslint-disable-next-line react/prop-types
  { code: codeRow, onClose, fetcher, defaultCommissionRate },
  ref,
) {
  const [discountPercent, setDiscountPercent] = useState("");
  const [commissionRate, setCommissionRate] = useState("");
  const [status, setStatus] = useState("active");
  const [note, setNote] = useState("");

  // Sync local state when the row passed in changes (admin clicked
  // Edit on a different row).
  useEffect(() => {
    if (!codeRow) return;
    setDiscountPercent(
      codeRow.discountPercent != null
        ? String((codeRow.discountPercent * 100).toFixed(2)).replace(/\.?0+$/, "") || "0"
        : "",
    );
    setCommissionRate(
      codeRow.commissionRate != null
        ? String((codeRow.commissionRate * 100).toFixed(2)).replace(/\.?0+$/, "") || "0"
        : "",
    );
    setStatus(codeRow.status || "active");
    setNote(codeRow.note || "");
  }, [codeRow]);

  const submit = () => {
    fetcher.submit(
      {
        _action: "update-code",
        codeId: codeRow.id,
        discountPercent: discountPercent === "" ? "0" : String(discountPercent),
        commissionRate: commissionRate === "" ? "" : String(commissionRate),
        status,
        note,
      },
      { method: "POST" },
    );
  };

  const submitting =
    fetcher.state === "submitting" || fetcher.state === "loading";

  return (
    <s-modal
      ref={ref}
      id="cdo-edit-code-modal"
      heading={codeRow ? `Edit code ${codeRow.code}` : "Edit code"}
      accessibilityLabel="Edit referral code"
    >
      {codeRow ? (
        <s-stack direction="block" gap="base">
          <s-paragraph tone="subdued">
            Renaming a code would break existing storefront links. Discount +
            commission changes apply to future orders only.
          </s-paragraph>
          <s-text-field
            label="Code"
            value={codeRow.code}
            disabled
            details="Code names are immutable. Archive + create a new code instead."
          />
          <s-text-field
            label="Discount %"
            type="number"
            min="0"
            max="100"
            step="0.01"
            value={discountPercent}
            onChange={(e) => setDiscountPercent(e.currentTarget.value)}
          />
          <s-text-field
            label="Commission %"
            type="number"
            min="0"
            max="100"
            step="0.01"
            value={commissionRate}
            onChange={(e) => setCommissionRate(e.currentTarget.value)}
            details={`Blank inherits the program default (${(defaultCommissionRate * 100).toFixed(0)}%).`}
          />
          <s-select
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.currentTarget.value)}
          >
            <s-option value="active">Active</s-option>
            <s-option value="paused">Paused</s-option>
            <s-option value="archived">Archived</s-option>
          </s-select>
          <s-text-area
            label="Note"
            value={note}
            rows={2}
            onChange={(e) => setNote(e.currentTarget.value)}
            maxLength={500}
          />
        </s-stack>
      ) : null}
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={submit}
        {...(submitting ? { loading: true } : {})}
      >
        Save changes
      </s-button>
      <s-button slot="secondary-actions" onClick={onClose}>
        Cancel
      </s-button>
    </s-modal>
  );
});
