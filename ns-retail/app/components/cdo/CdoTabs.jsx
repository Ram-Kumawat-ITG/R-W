import { useLocation, useNavigate } from "react-router";

// Tab bar for the CDO Program portal. Each tab is a sub-route, so the
// active state is derived from the URL and navigation goes through
// react-router (App Bridge intercepts it inside the embedded admin).
//
// The Dashboard lives at the portal root, so it only matches on an exact
// path; every other tab matches on prefix so deep links (e.g. a future
// /orders/:id) keep the right tab highlighted.

export const CDO_BASE = "/app/cdo-program";

export const CDO_TABS = [
  { label: "Dashboard", path: CDO_BASE },
  { label: "CDO Practitioners", path: `${CDO_BASE}/customers` },
  { label: "Orders", path: `${CDO_BASE}/orders` },
  { label: "Commissions", path: `${CDO_BASE}/commissions` },
  { label: "Payouts", path: `${CDO_BASE}/payouts` },
  { label: "Referrals", path: `${CDO_BASE}/referrals` },
  { label: "Transactions", path: `${CDO_BASE}/transactions` },
  { label: "Reports", path: `${CDO_BASE}/reports` },
  { label: "Settings", path: `${CDO_BASE}/settings` },
];

function isActive(pathname, tabPath) {
  const clean = pathname.replace(/\/$/, "");
  if (tabPath === CDO_BASE) return clean === CDO_BASE;
  return clean === tabPath || clean.startsWith(`${tabPath}/`);
}

export default function CdoTabs() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <s-box paddingBlockEnd="base">
      <s-stack direction="inline" gap="small-200" alignItems="center">
        {CDO_TABS.map((tab) => {
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
