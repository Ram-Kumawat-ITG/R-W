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
//   app.qbo.products.jsx      → /app/qbo/products
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
  {
    id: "dashboard",
    label: "Dashboard",
    path: "/app/qbo/dashboard",
    description: "Live snapshot of revenue, invoices, and recent activity.",
  },
  {
    id: "customers",
    label: "Customers",
    path: "/app/qbo/customers",
    description: "Every customer synced to QuickBooks Online.",
  },
  {
    id: "transactions",
    label: "Transactions",
    path: "/app/qbo/transactions",
    description: "Payments recorded against QuickBooks invoices.",
  },
  {
    id: "invoices",
    label: "Invoices",
    path: "/app/qbo/invoices",
    description: "Search, filter, and track every QuickBooks invoice.",
  },
  {
    id: "products",
    label: "Products",
    path: "/app/qbo/products",
    description:
      "Best-selling products by revenue and quantity, from QuickBooks' Sales by Product/Service report.",
  },
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
  const activeTab = TABS.find((t) => t.id === trailing) || TABS[0];
  const activeId = activeTab.id;

  return (
    <s-page inlineSize="large" heading="QuickBooks">
      <s-section padding="none">
        <s-box padding="base" paddingBlockEnd="small-300">
          {/* Tab bar — chip-based pattern. This is the one layout that has
              actually rendered correctly as a single horizontal row in
              this admin surface: `s-button-group` rendered nothing at all,
              and hand-rolled `s-clickable`/`s-box` rows collapsed to one
              full-width tab per line. `s-clickable-chip` inside
              `s-stack direction="inline"` is also what the Orders list's
              filter chips already use elsewhere in this app. The active
              tab uses the filled "strong" chip color plus a bold label. */}
          <s-stack direction="inline" gap="small-200" wrap>
            {TABS.map((t) => {
              const isActive = activeId === t.id;
              return (
                <s-clickable-chip
                  key={t.id}
                  color={isActive ? "strong" : "base"}
                  accessibilityLabel={`Open ${t.label} tab`}
                  onClick={() => navigate(t.path)}
                >
                  {isActive ? <strong>{t.label}</strong> : t.label}
                </s-clickable-chip>
              );
            })}
          </s-stack>
        </s-box>
        <s-box padding="base" paddingBlockStart="small-300">
          <s-paragraph tone="subdued">{activeTab.description}</s-paragraph>
        </s-box>
        <s-divider />
      </s-section>

      <s-box paddingBlockStart="large-200" />

      <Outlet />
    </s-page>
  );
}
