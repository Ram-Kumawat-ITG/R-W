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
  {
    id: "dashboard",
    label: "Dashboard",
    path: "/app/nmi/dashboard",
    description: "Live snapshot of NMI payment activity for the selected period.",
  },
  {
    id: "customers",
    label: "Customers",
    path: "/app/nmi/customers",
    description: "Every NMI Customer Vault entry (stored card / ACH profiles).",
  },
  {
    id: "payments",
    label: "Payments",
    path: "/app/nmi/payments",
    description: "Sale, capture, and credit transactions.",
  },
  {
    id: "transactions",
    label: "Transactions",
    path: "/app/nmi/transactions",
    description: "Every transaction and its full lifecycle, any condition.",
  },
  {
    id: "failed",
    label: "Failed payments",
    path: "/app/nmi/failed",
    description: "Declined or errored transactions, with retry history.",
  },
  {
    id: "refunds",
    label: "Refunds",
    path: "/app/nmi/refunds",
    description: "One row per refund action, paired with its original sale.",
  },
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
  const activeTab = TABS.find((t) => t.id === trailing) || TABS[0];
  const activeId = activeTab.id;

  return (
    <s-page inlineSize="large" heading="NMI">
      <s-section padding="none">
        <s-box padding="base" paddingBlockEnd="small-300">
          {/* Chip-based tab bar — same idiom as the QBO section + the
              order list's filter chips. Polaris web components don't
              ship a dedicated `s-tabs` element. The active tab uses the
              filled "strong" chip color plus a bold label so it reads
              unambiguously as selected. */}
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
