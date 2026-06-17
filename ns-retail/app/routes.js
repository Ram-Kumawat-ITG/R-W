import { route } from "@react-router/dev/routes";
import { flatRoutes } from "@react-router/fs-routes";

// Ignore any legacy app/routes/api.*.jsx files — those have been
// migrated to app/api/ and registered manually below. Without this,
// flatRoutes would auto-register the same URL paths and React Router
// would error with "duplicate route" at boot.
const fsRoutes = await flatRoutes({
  ignoredRouteFiles: ["**/api.*"],
});

// One-time visibility on boot so we can confirm api routes are in the
// tree without digging through the build output. Mirrors the wholesale
// app's diagnostic logging.
const apiRoutes = fsRoutes
  .map((r) => r.path)
  .filter((p) => typeof p === "string" && (p.includes("webhooks") || p.includes("api/")));
if (apiRoutes.length) {
  console.log("[routes] file-based webhook + api routes registered:");
  for (const p of apiRoutes) console.log(`  - /${p}`);
}

export default [
  ...fsRoutes,
  // Storefront app-proxy endpoints called by the retail signup form.
  // Files live under app/api/ — same convention as wholesale/app/api/.
  // Path strings are relative to the app/ directory.
  route("/api/auth/check-email", "api/auth/check-email.js"),
  route("/api/cdo/validate-code", "api/cdo/validate-code.js"),
  route("/api/cdo/checkout-validate-code", "api/cdo/checkout-validate-code.js"),
  // Looks up a logged-in customer's `code:*` tag via Shopify Admin GraphQL
  // (checkout extensions can't read customer.tags directly — known Shopify
  // limitation). Called from the checkout UI extension on mount.
  route(
    "/api/cdo/checkout-find-by-customer-id",
    "api/cdo/checkout-find-by-customer-id.js",
  ),
  route("/api/signup-form", "api/signup-form.js"),
  // Practitioner Portal — Customer Account UI extension backend (/api/portal/*).
  // Read-only over the cdo_* collections ns-retail owns; auth via the customer
  // session-token JWT (see app/api/portal/_guard.js).
  route("/api/portal/me", "api/portal/me.js"),
  route("/api/portal/summary", "api/portal/summary.js"),
  route("/api/portal/revenue", "api/portal/revenue.js"),
  route("/api/portal/customers", "api/portal/customers.js"),
  route("/api/portal/commissions", "api/portal/commissions.js"),
  route("/api/portal/payouts", "api/portal/payouts.js"),
  route("/api/portal/referrals", "api/portal/referrals.js"),
  route("/api/portal/discounts", "api/portal/discounts.js"),
  // Inbound cross-repo sync: the WHOLESALE app POSTs here when a drop-ship
  // wholesale order is fulfilled / shipped / delivered / cancelled, so we
  // mirror that status (carrier + tracking + delivery) onto the linked retail
  // Shopify order. Shared-secret auth (x-sync-secret = RETAIL_SYNC_SECRET).
  route("/api/sync/wholesale-fulfillment", "api/sync/wholesale-fulfillment.js"),
];
