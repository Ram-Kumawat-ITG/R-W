import { useLocation, useNavigate } from "react-router";

// Sub-tab bar for a single practitioner's detail page. Mirrors the
// chip-style nav used by the top-level CDO Program tabs (CdoTabs) so
// the navigation idiom stays consistent — but lives one level deeper:
// each tab is a sub-route of `/app/cdo-program/customers/:id/*`.
//
// The Details tab lives at the layout's _index (no trailing segment),
// so its match condition is "pathname ends at the practitioner id" —
// any other trailing segment lights the corresponding tab instead.

export function buildCustomerTabs(practitionerId) {
  const base = `/app/cdo-program/customers/${practitionerId}`;
  return [
    { label: "Details", path: base, segment: "" },
    { label: "Commissions", path: `${base}/commissions`, segment: "commissions" },
    // "Customers" = the practitioner's downline / referred shoppers.
    // The route segment is `downline` so it doesn't collide with the
    // parent /customers route or read ambiguously.
    { label: "Customers", path: `${base}/downline`, segment: "downline" },
    { label: "Network", path: `${base}/network`, segment: "network" },
    { label: "Sales", path: `${base}/sales`, segment: "sales" },
    { label: "Payments", path: `${base}/payments`, segment: "payments" },
    { label: "Transactions", path: `${base}/transactions`, segment: "transactions" },
    { label: "Settings", path: `${base}/settings`, segment: "settings" },
  ];
}

function activeTabIdFromPath(pathname, practitionerId) {
  const clean = pathname.replace(/\/$/, "");
  const root = `/app/cdo-program/customers/${practitionerId}`;
  if (clean === root) return "";
  const suffix = clean.startsWith(`${root}/`) ? clean.slice(root.length + 1) : "";
  // Use only the FIRST segment after the id so future child routes
  // (e.g. /commissions/:commissionId) keep the right tab highlighted.
  return suffix.split("/")[0] || "";
}

// eslint-disable-next-line react/prop-types
export default function CustomerTabs({ practitionerId }) {
  const location = useLocation();
  const navigate = useNavigate();
  const tabs = buildCustomerTabs(practitionerId);
  const activeSegment = activeTabIdFromPath(location.pathname, practitionerId);

  return (
    <s-box paddingBlockEnd="base">
      <s-stack direction="inline" gap="small-200" alignItems="center" wrap>
        {tabs.map((tab) => {
          const active = tab.segment === activeSegment;
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
