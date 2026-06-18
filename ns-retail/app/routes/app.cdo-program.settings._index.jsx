/* eslint-disable react/prop-types */
// Internal `SettingRow` helper takes props referenced in JSX; the project
// doesn't ship PropTypes, so the file-scope disable matches the convention
// used by the other CDO route components.
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getSettings } from "../services/cdo/cdo.service";
import { formatCurrency, formatPercent } from "../utils/format";

// Global Configuration — the program-wide CDO settings (index tab of Settings).

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const settings = await getSettings();
  return { settings };
};

function SettingRow({ label, value }) {
  return (
    <s-stack direction="block" gap="none">
      <s-text tone="subdued">{label}</s-text>
      <s-text>{value}</s-text>
    </s-stack>
  );
}

export default function CdoGlobalSettings() {
  const { settings } = useLoaderData();
  return (
    <s-section heading="Global Configuration">
      {!settings.configured ? (
        <s-paragraph tone="subdued">
          No configuration saved yet — showing program defaults. Editable
          settings will be enabled in a later pass.
        </s-paragraph>
      ) : null}
      <s-box padding="base" borderWidth="base" borderRadius="base">
        <s-stack direction="block" gap="base">
          <SettingRow label="Program name" value={settings.programName} />
          <SettingRow
            label="Default commission rate"
            value={formatPercent(settings.defaultCommissionRate)}
          />
          <SettingRow label="Currency" value={settings.currency} />
          <SettingRow label="Payout schedule" value={settings.payoutSchedule} />
          <SettingRow
            label="Minimum payout amount"
            value={formatCurrency(settings.minimumPayoutAmount, settings.currency)}
          />
          <SettingRow
            label="Auto-approve commissions"
            value={settings.autoApproveCommissions ? "Yes" : "No"}
          />
          <SettingRow
            label="Referral cookie window"
            value={`${settings.cookieWindowDays} days`}
          />
        </s-stack>
      </s-box>
    </s-section>
  );
}
