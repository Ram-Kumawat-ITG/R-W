import { useLocation, useNavigate } from "react-router";

export const CDO_BASE = "/app/cdo-program";

export const CDO_TABS = [
  { label: "Dashboard", path: CDO_BASE },
  { label: "CDO Practitioners", path: `${CDO_BASE}/customers` },
  { label: "Orders", path: `${CDO_BASE}/orders` },
  { label: "Commissions", path: `${CDO_BASE}/commissions` },
  { label: "CRON Run History", path: `${CDO_BASE}/batches` },
  { label: "Check Payouts", path: `${CDO_BASE}/check-payouts` },
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

export default function CdoTabs() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <div style={TAB_BAR_STYLE}>
      {CDO_TABS.map((tab) => {
        const active = isActive(location.pathname, tab.path);
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
