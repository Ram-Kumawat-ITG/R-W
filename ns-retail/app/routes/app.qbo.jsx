import { Outlet, useLocation, useNavigate } from "react-router";

const QBO_BASE = "/app/qbo";

const TABS = [
  { label: "Dashboard", path: `${QBO_BASE}/dashboard` },
  { label: "Customers", path: `${QBO_BASE}/customers` },
  { label: "Transactions", path: `${QBO_BASE}/transactions` },
  { label: "Invoices", path: `${QBO_BASE}/invoices` },
  { label: "Bills", path: `${QBO_BASE}/bills` },
];

function isActive(pathname, tabPath) {
  const clean = pathname.replace(/\/$/, "");
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

export default function QboLayout() {
  const location = useLocation();
  const navigate = useNavigate();

  // Default to Dashboard when on /app/qbo exactly
  const activeTab =
    TABS.find((t) => isActive(location.pathname, t.path)) ?? TABS[0];

  return (
    <s-page inlineSize="large" heading="QuickBooks Online">
      <div style={TAB_BAR_STYLE}>
        {TABS.map((tab) => {
          const active = tab === activeTab;
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
      <Outlet />
    </s-page>
  );
}
