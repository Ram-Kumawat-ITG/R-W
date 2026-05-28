import { Outlet, useLocation, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";

// QBO admin section — layout shell.
//
// React Router 7 flat-routes uses dot-paths as URL segments. This file
// is the LAYOUT for everything under `/app/qbo/*`:
//
//   app.qbo.jsx               → /app/qbo (layout)
//   app.qbo._index.jsx        → /app/qbo (default child — redirects to /dashboard)
//   app.qbo.dashboard.jsx     → /app/qbo/dashboard
//   app.qbo.customers.jsx     → /app/qbo/customers
//   app.qbo.transactions.jsx  → /app/qbo/transactions
//   app.qbo.invoices.jsx      → /app/qbo/invoices
//
// Each child route owns its own loader so per-tab QBO API calls stay
// isolated — a failure on the Customers tab does not block the
// Dashboard. The auth check is also re-done in every child loader (cheap
// because @shopify/shopify-app-react-router caches per-request); we
// also do it here so a direct visit to /app/qbo before any child
// resolves still triggers the OAuth flow.
//
// Tab navigation uses URL pathname matching (NOT React state) so
// browser back/forward + deep links work. Active-state styling switches
// based on the trailing pathname segment.

const TABS = [
  { id: "dashboard", label: "Dashboard", path: "/app/qbo/dashboard" },
  { id: "customers", label: "Customers", path: "/app/qbo/customers" },
  { id: "transactions", label: "Transactions", path: "/app/qbo/transactions" },
  { id: "invoices", label: "Invoices", path: "/app/qbo/invoices" },
];

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export default function QboLayout() {
  const location = useLocation();
  const navigate = useNavigate();

  // Active tab — match the LAST non-empty path segment so deep links
  // like /app/qbo/customers/<id> (future) still light the right tab.
  const segments = location.pathname.split("/").filter(Boolean);
  const trailing = segments[segments.length - 1];
  const activeId =
    TABS.find((t) => t.id === trailing)?.id || "dashboard";

  return (
    <s-page inlineSize="large" heading="QuickBooks">
      <s-section padding="none">
        <s-box padding="base">
          {/* Tab bar — chip-based pattern reused from the Orders list's
              filter chips. No native `s-tabs` element exists in the
              Polaris web-component set, and chip styling is already
              the project's idiom for grouped navigation. */}
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
