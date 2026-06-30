/* eslint-disable react/prop-types */
import { useEffect, useRef } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getPractitionerProfile,
  listPractitionerCodes,
  getSettings,
  getPractitionerHold,
  pausePractitionerPayouts,
  resumePractitionerPayouts,
} from "../services/cdo/cdo.service";
import { formatPercent, formatDate } from "../utils/format";

// Settings tab — practitioner-scoped configuration. Today this is a
// read-only surface that summarises the values driving this
// practitioner's economics. Mutations route through the Details tab
// (referral-code CRUD) or the program-level Settings page
// (`/app/cdo-program/settings`) which manages cdo_settings defaults.
//
// As per-practitioner overrides land in future iterations (e.g.
// payout schedule overrides, manual status switches, custom payout
// methods), they'll be wired here. The shape is ready for them — see
// the inline comments next to each section.

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);
  const [profile, codes, settings, hold] = await Promise.all([
    getPractitionerProfile(params.id),
    listPractitionerCodes(params.id),
    getSettings(),
    getPractitionerHold(params.id),
  ]);
  if (!profile) {
    throw new Response("Practitioner not found", { status: 404 });
  }
  return { profile, codes, settings, hold };
};

// Pause / resume ALL future payouts for this practitioner. The automated
// payout pipeline excludes a held practitioner's commissions from accrual
// approval + batching until resumed.
export const action = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const actor =
    session?.onlineAccessInfo?.associated_user?.email || session?.shop || "admin";
  const shop = session?.shop || null;
  const formData = await request.formData();
  const op = String(formData.get("_action") || "").trim();

  try {
    switch (op) {
      case "pause-practitioner": {
        await pausePractitionerPayouts(params.id, {
          actor,
          shop,
          note: formData.get("note") || "",
        });
        return { status: "success", op, message: "All payouts paused for this practitioner." };
      }
      case "resume-practitioner": {
        await resumePractitionerPayouts(params.id, { actor });
        return { status: "success", op, message: "Payouts resumed for this practitioner." };
      }
      default:
        return { status: "error", op, message: `Unknown action: ${op}` };
    }
  } catch (e) {
    console.error(`[cdo-program/customers/settings] action ${op} failed:`, e?.message || e);
    return { status: "error", op, message: e?.message || "Action failed" };
  }
};

export default function CdoCustomerSettings() {
  const { profile, codes, settings, hold } = useLoaderData();
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const handledRef = useRef(null);
  const primary = codes.find((c) => c.isPrimary && c.status === "active");
  const effectiveCommission =
    primary?.commissionRate != null
      ? primary.commissionRate
      : settings.defaultCommissionRate;

  const busy = fetcher.state === "submitting" || fetcher.state === "loading";

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

  const togglePayouts = () =>
    fetcher.submit(
      { _action: hold.paused ? "resume-practitioner" : "pause-practitioner" },
      { method: "POST" },
    );

  return (
    <s-stack direction="block" gap="base">
      <s-section heading="Payout automation">
        <s-stack direction="block" gap="tight">
          {hold.paused ? (
            <s-banner tone="warning">
              All payouts for {profile.name || "this practitioner"} are paused. The
              automated payout run skips their commissions until resumed
              {hold.pausedBy ? ` (paused by ${hold.pausedBy}` : ""}
              {hold.pausedBy && hold.pausedAt ? ` on ${formatDate(hold.pausedAt)})` : hold.pausedBy ? ")" : ""}.
            </s-banner>
          ) : null}
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            <s-stack direction="block" gap="none">
              <s-text tone="subdued">Automated payouts</s-text>
              <s-stack direction="inline" gap="small-200" alignItems="center">
                {hold.paused ? (
                  <s-badge tone="warning">Paused</s-badge>
                ) : (
                  <s-badge tone="success">Active</s-badge>
                )}
              </s-stack>
              <s-text tone="subdued">
                Pause holds every one of this practitioner&apos;s commissions out of the
                automated payout run. Already-paid or batched payouts are unaffected.
              </s-text>
            </s-stack>
            <s-button
              variant={hold.paused ? "primary" : "tertiary"}
              tone={hold.paused ? undefined : "critical"}
              {...(busy ? { loading: true } : {})}
              onClick={togglePayouts}
            >
              {hold.paused ? "Resume payouts" : "Pause all payouts"}
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Referral settings">
        <s-stack direction="block" gap="tight">
          <Row
            label="Active codes"
            value={`${codes.filter((c) => c.status === "active").length} of ${codes.length}`}
            hint="Manage codes from the Details tab — create, edit, archive, set primary."
          />
          <Row
            label="Primary code"
            value={primary ? primary.code : "Not set"}
            hint={
              primary
                ? `Patient discount ${formatPercent(primary.discountPercent)} · Practitioner commission ${formatPercent(effectiveCommission)}`
                : "Set a primary from the Details tab so storefront links resolve."
            }
          />
        </s-stack>
      </s-section>

      {/* All ACTIVE codes side-by-side (bug 8). A practitioner can run several
          tiers at once (e.g. 10% / 20% / 35%), so surfacing them together here
          lets an admin spot competing offers and consolidate. Labels are
          explicit (bug 6): the patient's discount vs the practitioner's earning
          rate are easy to confuse when both are stored as a fraction. */}
      <s-section heading="Active referral codes">
        <s-stack direction="block" gap="tight">
          <s-paragraph tone="subdued">
            Every code this practitioner currently has ACTIVE. Manage (create /
            archive / set primary) from the Details tab.
          </s-paragraph>
          {codes.filter((c) => c.status === "active").length === 0 ? (
            <s-paragraph tone="subdued">No active codes.</s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>Code</s-table-header>
                <s-table-header>Patient discount %</s-table-header>
                <s-table-header>Practitioner commission %</s-table-header>
                <s-table-header>Primary</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {codes
                  .filter((c) => c.status === "active")
                  .map((c) => (
                    <s-table-row key={c.id || c.code}>
                      <s-table-cell>{c.code}</s-table-cell>
                      <s-table-cell>{formatPercent(c.discountPercent)}</s-table-cell>
                      <s-table-cell>
                        {formatPercent(
                          c.commissionRate != null
                            ? c.commissionRate
                            : settings.defaultCommissionRate,
                        )}
                        {c.commissionRate == null ? " (default)" : ""}
                      </s-table-cell>
                      <s-table-cell>
                        {c.isPrimary ? <s-badge tone="info">Primary</s-badge> : "—"}
                      </s-table-cell>
                    </s-table-row>
                  ))}
              </s-table-body>
            </s-table>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Commission settings">
        <s-stack direction="block" gap="tight">
          <Row
            label="Effective practitioner commission rate"
            value={formatPercent(effectiveCommission)}
            hint={
              primary?.commissionRate != null
                ? "Override on the primary code."
                : "Inherited from the program default. Override per-code in the Details tab."
            }
          />
          <Row
            label="Program default"
            value={formatPercent(settings.defaultCommissionRate)}
            hint="Configured in /app/cdo-program/settings. Edit there to change for every practitioner."
          />
          <Row
            label="Auto-approve commissions"
            value={settings.autoApproveCommissions ? "Yes" : "No"}
            hint="Program-level switch — applies to every practitioner."
          />
        </s-stack>
      </s-section>

      <s-section heading="Payout preferences">
        <s-stack direction="block" gap="tight">
          <Row
            label="Schedule"
            value={settings.payoutSchedule}
            hint="Program default — per-practitioner override is on the roadmap."
          />
          <Row
            label="Minimum payout"
            value={`${settings.minimumPayoutAmount} ${settings.currency}`}
            hint="Commissions accumulate until this threshold."
          />
          <Row
            label="Cookie window"
            value={`${settings.cookieWindowDays} days`}
            hint="Referrals expire after this window without a conversion."
          />
        </s-stack>
      </s-section>

      <s-section heading="Practitioner status">
        <s-stack direction="block" gap="tight">
          <Row
            label="Status"
            value={profile.status || "approved"}
            hint="Sourced from wholesale_applications. Use the wholesale workspace's admin to revoke approval."
          />
          <Row
            label="Tax resells items"
            value="Yes"
            hint="Required for CDO eligibility (`tax.itemsToResell = yes`)."
          />
        </s-stack>
      </s-section>
    </s-stack>
  );
}

// eslint-disable-next-line react/prop-types
function Row({ label, value, hint }) {
  return (
    <s-stack direction="block" gap="none">
      <s-text tone="subdued">{label}</s-text>
      <s-text>{value}</s-text>
      {hint && <s-text tone="subdued">{hint}</s-text>}
    </s-stack>
  );
}
