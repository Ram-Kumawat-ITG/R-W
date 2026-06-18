import { useLocation, useNavigate } from "react-router";
import { CDO_BASE } from "./CdoTabs";

// Sub-tab bar for the CDO Program → Settings section. Mirrors CdoTabs but for
// the settings sub-routes. Extensible: add a `{ label, path }` entry here plus
// a matching child route and the tab appears automatically.

const SETTINGS_BASE = `${CDO_BASE}/settings`;

export const SETTINGS_TABS = [
  { label: "Commission Configuration", path: `${SETTINGS_BASE}/commission` },
];

function isActive(pathname, tabPath) {
  const clean = pathname.replace(/\/$/, "");
  return clean === tabPath || clean.startsWith(`${tabPath}/`);
}

export default function SettingsTabs() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <s-box paddingBlockEnd="base">
      <s-stack direction="inline" gap="small-200" alignItems="center">
        {SETTINGS_TABS.map((tab) => {
          const active = isActive(location.pathname, tab.path);
          return (
            <s-button
              key={tab.path}
              variant={active ? "primary" : "tertiary"}
              onClick={() => {
                if (!active) navigate(tab.path);
              }}
            >
              {tab.label}
            </s-button>
          );
        })}
      </s-stack>
    </s-box>
  );
}
