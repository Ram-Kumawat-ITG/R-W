import { route } from "@react-router/dev/routes";
import { flatRoutes } from "@react-router/fs-routes";

const fsRoutes = await flatRoutes();

// One-time visibility on boot so we can confirm webhook routes are in
// the tree without having to dig through the build output. Only logs
// the routes most likely to matter for QBO/NMI/Shopify integration.
const webhookRoutes = fsRoutes
  .map((r) => r.path)
  .filter((p) => typeof p === "string" && (p.includes("webhooks") || p.includes("api/")));
if (webhookRoutes.length) {
  console.log("[routes] webhook + api routes registered:");
  for (const p of webhookRoutes) console.log(`  - /${p}`);
} else {
  console.log("[routes] no webhook routes found — check app/routes/*.jsx");
} 

export default [
  ...fsRoutes,
  route("/api/registration-form", "api/registration-form.js"),
  route("/api/auth/check-email", "api/auth/check-email.js"),
  route("/api/update-profile",   "api/update-profile.js"),
  // Practitioner Portal moved to the ns-retail app (extension + /api/portal/*
  // backend now live there — it owns the cdo_* collections). See ns-retail.
  //
  // EXCEPTION: profile-update lives HERE in wholesale because it edits the
  // WholesaleApplication (wholesale's own collection). The profile-update
  // Customer Account UI extension at extensions/profile-update/ calls
  // /api/portal/profile (fetch + update via `action` field in the body).
  route("/api/portal/profile", "api/portal/profile.js"),
  // Practitioner Portal (Theme App Extension, wholesale storefront) —
  // migrated back from ns-retail. Auth via App Proxy's logged_in_customer_id
  // (NOT the session-token JWT profile-update above); ns-retail still OWNS
  // and WRITES cdo_orders/cdo_commissions/cdo_payouts/cdo_referrals — these
  // routes read them via the wholesale-side mirrors in app/models/.
  route("/api/portal/me", "api/portal/me.js"),
  route("/api/portal/summary", "api/portal/summary.js"),
  route("/api/portal/revenue", "api/portal/revenue.js"),
  route("/api/portal/customers", "api/portal/customers.js"),
  route("/api/portal/patient-code", "api/portal/patient-code.js"),
  route("/api/portal/commissions", "api/portal/commissions.js"),
  route("/api/portal/payouts", "api/portal/payouts.js"),
  route("/api/portal/referrals", "api/portal/referrals.js"),
  // Shopify Carrier Service callback — receives the cart origin + destination
  // + items at checkout, fetches live rates from EasyPost, applies the
  // wholesale quantity-based markup, and returns rates to Shopify.
  // Registered with Shopify via the `carrierServiceCreate` GraphQL mutation
  // (one-time per store; the callbackUrl must point HERE).
  route("/api/shipping/rates", "api/shipping/rates.js"),
  // On-demand Processing Fee variant provisioning. POST { price }
  // returns { gid } for a variant at that exact cent-precise price,
  // creating it (and LRU-evicting an old one if the product is at
  // capacity) as needed. Called from the checkout-ui extension via
  // FullPageApi.getFeeVariant(). Mirrors
  // ns-retail/app/api/cdo/fee-variant.js.
  route("/api/cdo/fee-variant", "api/cdo/fee-variant.js"),
  route("/api/admin/customers", "api/admin/customers.js"),
  route("/api/admin/customers/:id", "api/admin/customer.js"),
  route("/api/admin/customers/:id/decline", "api/admin/decline.js"),
  route("/api/admin/customers/:id/block", "api/admin/block.js"),
  route("/api/admin/customers/:id/payment-method", "api/admin/payment-method.js"),
  route("/api/admin/orders/:id/retry-payment", "api/admin/retry-payment.js"),
  route("/api/admin/orders/:id/sync-ach-status", "api/admin/sync-ach-status.js"),
  route("/api/admin/orders/:id/mark-cheque-paid", "api/admin/mark-cheque-paid.js"),
  route("/api/admin/orders/:id/charge-card", "api/admin/charge-card.js"),
  route("/api/admin/orders/:id/preview-payment", "api/admin/preview-payment.js"),
  route("/api/admin/orders/:id/qbo-invoice-pdf", "api/admin/qbo-invoice-pdf.js"),
  route("/api/admin/orders/:id/qbo-bill-pdf", "api/admin/qbo-bill-pdf.js"),
  route("/api/admin/orders/:id/send-invoice", "api/admin/send-invoice.js"),
  route("/api/admin/orders/:id/pause-auto-charge", "api/admin/pause-auto-charge.js"),
  route("/api/admin/orders/:id/resume-auto-charge", "api/admin/resume-auto-charge.js"),
  route("/api/admin/orders/:id/pause-reminders", "api/admin/pause-reminders.js"),
  route("/api/admin/orders/:id/resume-reminders", "api/admin/resume-reminders.js"),
  // Global (not per-invoice) — pause/resume the process-pending-payments
  // CRON's two email notifications (customer "Payment Failed" + admin
  // "Batch Processing Summary"). Charge processing is unaffected.
  route("/api/admin/cron-notifications/pause", "api/admin/pause-cron-notifications.js"),
  route("/api/admin/cron-notifications/resume", "api/admin/resume-cron-notifications.js"),
  route("/api/admin/admin-order-batch", "api/admin/admin-order-batch.js"),
  route("/api/sync/retail-order", "api/sync/retail-order.js"),
  route("/api/sync/retail-inventory-update", "api/sync/retail-inventory-update.js"),
  route("/api/admin/sync/backfill", "api/admin/sync-backfill.js"),
  route("/api/admin/sync/inventory-snapshot", "api/admin/sync-inventory-snapshot.js"),
  route("/api/admin/backfill-customer-tags", "api/admin/backfill-customer-tags.js"),

];
