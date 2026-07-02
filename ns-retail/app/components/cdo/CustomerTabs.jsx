import { useLocation, useNavigate } from "react-router";

export function buildCustomerTabs(practitionerId) {
  const base = `/app/cdo-program/customers/${practitionerId}`;
  return [
    { label: "Details",      path: base,                    segment: "" },
    { label: "Commissions",  path: `${base}/commissions`,   segment: "commissions" },
    { label: "Customers",    path: `${base}/downline`,       segment: "downline" },
    { label: "Network",      path: `${base}/network`,        segment: "network" },
    { label: "Sales",        path: `${base}/sales`,          segment: "sales" },
    { label: "Payments",     path: `${base}/payments`,       segment: "payments" },
    { label: "Transactions", path: `${base}/transactions`,   segment: "transactions" },
    { label: "Settings",     path: `${base}/settings`,       segment: "settings" },
  ];
}

function activeTabIdFromPath(pathname, practitionerId) {
  const clean = pathname.replace(/\/$/, "");
  const root = `/app/cdo-program/customers/${practitionerId}`;
  if (clean === root) return "";
  const suffix = clean.startsWith(`${root}/`) ? clean.slice(root.length + 1) : "";
  return suffix.split("/")[0] || "";
}

const TAB_BAR_STYLE = {
  display: "flex",
  gap: "0",
  overflowX: "auto",
  overflowY: "hidden",
  borderBottom: "1px solid #e1e3e5",
  marginBottom: "16px",
  msOverflowStyle: "none",
  scrollbarWidth: "none",
};

const TAB_STYLE = (active) => ({
  padding: "10px 16px",
  border: "none",
  borderBottom: active ? "2px solid #303030" : "2px solid transparent",
  background: "transparent",
  cursor: active ? "default" : "pointer",
  color: active ? "#303030" : "#6d7175",
  fontWeight: active ? "600" : "400",
  fontSize: "14px",
  lineHeight: "20px",
  whiteSpace: "nowrap",
  marginBottom: "-1px",
  outline: "none",
  transition: "color 0.15s ease, border-color 0.15s ease",
  flexShrink: 0,
});

// eslint-disable-next-line react/prop-types
export default function CustomerTabs({ practitionerId }) {
  const location = useLocation();
  const navigate = useNavigate();
  const tabs = buildCustomerTabs(practitionerId);
  const activeSegment = activeTabIdFromPath(location.pathname, practitionerId);

  return (
    <div style={TAB_BAR_STYLE}>
      {tabs.map((tab) => {
        const active = tab.segment === activeSegment;
        return (
          <button
            key={tab.path}
            style={TAB_STYLE(active)}
            onClick={() => { if (!active) navigate(tab.path); }}
            onMouseEnter={(e) => {
              if (!active) e.currentTarget.style.color = "#303030";
            }}
            onMouseLeave={(e) => {
              if (!active) e.currentTarget.style.color = "#6d7175";
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
