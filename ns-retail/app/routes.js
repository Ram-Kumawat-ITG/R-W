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
  // Internal cross-repo endpoint: wholesale proxies vendor bill PDF requests here.
  route("/api/cdo/bill-pdf", "api/cdo/bill-pdf.js"),
  route("/api/cdo/checkout-validate-code", "api/cdo/checkout-validate-code.js"),
  // On-demand Processing Fee variant provisioning. POST { price }
  // returns { gid } for a variant at that exact cent-precise price,
  // creating it (and LRU-evicting an old one if the product is at
  // capacity) as needed. Called from the checkout extension via
  // FullPageApi.getFeeVariant().
  route("/api/cdo/fee-variant", "api/cdo/fee-variant.js"),
  // Apply a validated referral code to the cart and immediately tag the
  // Shopify customer. Called from the checkout UI extension when the buyer
  // applies a code. Tags the customer so the code becomes the default for
  // future orders.
  route("/api/cdo/checkout-apply-code", "api/cdo/checkout-apply-code.js"),
  // Looks up a logged-in customer's `code:*` tag via Shopify Admin GraphQL
  // (checkout extensions can't read customer.tags directly — known Shopify
  // limitation). Called from the checkout UI extension on mount.
  route(
    "/api/cdo/checkout-find-by-customer-id",
    "api/cdo/checkout-find-by-customer-id.js",
  ),
  // Admin API to update a customer's referral code after signup.
  // Validates the new code, builds a fresh snapshot, updates cdo_applications.
  route("/api/cdo/update-customer-referral", "api/cdo/update-customer-referral.js"),
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
  // Client Portal — Theme App Extension backend (/api/client-portal/*).
  // Any logged-in retail customer is authorized (no approval gate, unlike
  // the practitioner portal above). Auth via App Proxy +
  // logged_in_customer_id (see app/api/client-portal/_guard.js).
  route("/api/client-portal/me", "api/client-portal/me.js"),
  route("/api/client-portal/dashboard", "api/client-portal/dashboard.js"),
  route("/api/client-portal/orders", "api/client-portal/orders.js"),
  route("/api/client-portal/order", "api/client-portal/order.js"),
  route("/api/client-portal/invoice-pdf", "api/client-portal/invoice-pdf.js"),
  route("/api/client-portal/payments", "api/client-portal/payments.js"),
  route("/api/client-portal/cdo", "api/client-portal/cdo.js"),
  route("/api/client-portal/profile", "api/client-portal/profile.js"),
  // Shopify Carrier Service callback — receives the cart origin + destination
  // + items at checkout, fetches live rates from USPS + UPS (or falls back
  // to STATIC_CARRIER_RATES placeholder when credentials are unset), and
  // returns rates to Shopify with per-quantity markup.
  // 1:1 with wholesale/app/api/shipping/rates.js — keep them in sync.
  // Each store has its own carrier service registered via the
  // `carrierServiceCreate` Admin GraphQL mutation pointing at this URL.
  route("/api/shipping/rates", "api/shipping/rates.js"),
  // Inbound cross-repo sync: the WHOLESALE app POSTs here when a drop-ship
  // wholesale order is fulfilled / shipped / delivered / cancelled, so we
  // mirror that status (carrier + tracking + delivery) onto the linked retail
  // Shopify order. Shared-secret auth (x-sync-secret = RETAIL_SYNC_SECRET).
  route("/api/sync/wholesale-fulfillment", "api/sync/wholesale-fulfillment.js"),
];
