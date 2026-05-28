import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getPractitionerProfile,
  listPractitionerCodes,
  getSettings,
} from "../services/cdo/cdo.service";
import { formatPercent } from "../utils/format";

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
  const [profile, codes, settings] = await Promise.all([
    getPractitionerProfile(params.id),
    listPractitionerCodes(params.id),
    getSettings(),
  ]);
  if (!profile) {
    throw new Response("Practitioner not found", { status: 404 });
  }
  return { profile, codes, settings };
};

export default function CdoCustomerSettings() {
  const { profile, codes, settings } = useLoaderData();
  const primary = codes.find((c) => c.isPrimary && c.status === "active");
  const effectiveCommission =
    primary?.commissionRate != null
      ? primary.commissionRate
      : settings.defaultCommissionRate;

  return (
    <s-stack direction="block" gap="base">
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
                ? `Discount ${formatPercent(primary.discountPercent)} · commission ${formatPercent(effectiveCommission)}`
                : "Set a primary from the Details tab so storefront links resolve."
            }
          />
        </s-stack>
      </s-section>

      <s-section heading="Commission settings">
        <s-stack direction="block" gap="tight">
          <Row
            label="Effective commission rate"
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
