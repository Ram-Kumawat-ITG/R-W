import { Outlet } from "react-router";
import { authenticate } from "../shopify.server";
import SettingsTabs from "../components/cdo/SettingsTabs";

// CDO Program → Settings layout. Renders the settings sub-tab bar once; each
// settings tab is a child route rendered into the Outlet:
//   /settings            → Global Configuration  (settings._index)
//   /settings/commission → Commission Configuration (settings.commission)
// Child loaders fetch their own data, so this layout loader only authenticates.

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export default function CdoSettingsLayout() {
  return (
    <s-stack direction="block" gap="base">
      <SettingsTabs />
      <Outlet />
    </s-stack>
  );
}
