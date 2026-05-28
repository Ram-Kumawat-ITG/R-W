import { Outlet, useLocation, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";

// NMI admin section — layout shell.
//
// Mirrors the QBO admin section's layout (see app.qbo.jsx). React
// Router 7 flat-routes use dot-paths as URL segments:
//
//   app.nmi.jsx              → /app/nmi (layout)
//   app.nmi._index.jsx       → /app/nmi (redirects to /dashboard)
//   app.nmi.dashboard.jsx    → /app/nmi/dashboard
//   app.nmi.customers.jsx    → /app/nmi/customers
//   app.nmi.payments.jsx     → /app/nmi/payments
//   app.nmi.transactions.jsx → /app/nmi/transactions
//   app.nmi.failed.jsx       → /app/nmi/failed
//   app.nmi.refunds.jsx      → /app/nmi/refunds
//
// Each child route owns its own loader so per-tab NMI API calls stay
// isolated — a failure on Refunds doesn't block Dashboard. Tab
// navigation is driven by the URL pathname (not React state) so deep
// links + browser back/forward behave as expected.

const TABS = [
  { id: "dashboard", label: "Dashboard", path: "/app/nmi/dashboard" },
  { id: "customers", label: "Customers", path: "/app/nmi/customers" },
  { id: "payments", label: "Payments", path: "/app/nmi/payments" },
  { id: "transactions", label: "Transactions", path: "/app/nmi/transactions" },
  { id: "failed", label: "Failed payments", path: "/app/nmi/failed" },
  { id: "refunds", label: "Refunds", path: "/app/nmi/refunds" },
];

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export default function NmiLayout() {
  const location = useLocation();
  const navigate = useNavigate();

  const segments = location.pathname.split("/").filter(Boolean);
  const trailing = segments[segments.length - 1];
  const activeId = TABS.find((t) => t.id === trailing)?.id || "dashboard";

  return (
    <s-page inlineSize="large" heading="NMI">
      <s-section padding="none">
        <s-box padding="base">
          {/* Chip-based tab bar — same idiom as the QBO section + the
              order list's filter chips. Polaris web components don't
              ship a dedicated `s-tabs` element. */}
          <s-stack direction="inline" gap="small-200" wrap>
            {TABS.map((t) => (
              <s-clickable-chip
                key={t.id}
                color={activeId === t.id ? "strong" : "base"}
                accessibilityLabel={`Open ${t.label} tab`}
                onClick={() => navigate(t.path)}
              >
                {t.label}
              </s-clickable-chip>
            ))}
          </s-stack>
        </s-box>
      </s-section>

      <s-box paddingBlockStart="large-200" />

      <Outlet />
    </s-page>
  );
}
