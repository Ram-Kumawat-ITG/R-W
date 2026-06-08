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
  // Practitioner Portal (storefront theme app extension, App Proxy)
  route("/api/portal/me", "api/portal/me.js"),
  route("/api/portal/summary", "api/portal/summary.js"),
  route("/api/portal/revenue", "api/portal/revenue.js"),
  route("/api/portal/customers", "api/portal/customers.js"),
  route("/api/portal/commissions", "api/portal/commissions.js"),
  route("/api/portal/payouts", "api/portal/payouts.js"),
  route("/api/portal/referrals", "api/portal/referrals.js"),
  route("/api/portal/discounts", "api/portal/discounts.js"),
  route("/api/admin/customers", "api/admin/customers.js"),
  route("/api/admin/customers/:id", "api/admin/customer.js"),
  route("/api/admin/customers/:id/decline", "api/admin/decline.js"),
  route("/api/admin/customers/:id/payment-method", "api/admin/payment-method.js"),
  route("/api/admin/orders/:id/retry-payment", "api/admin/retry-payment.js"),
  route("/api/admin/orders/:id/sync-ach-status", "api/admin/sync-ach-status.js"),
  route("/api/admin/orders/:id/mark-cheque-paid", "api/admin/mark-cheque-paid.js"),
  route("/api/admin/orders/:id/charge-card", "api/admin/charge-card.js"),
  route("/api/admin/orders/:id/preview-payment", "api/admin/preview-payment.js"),
  route("/api/admin/orders/:id/qbo-invoice-pdf", "api/admin/qbo-invoice-pdf.js"),
  route("/api/admin/orders/:id/send-invoice", "api/admin/send-invoice.js"),
  route("/api/admin/orders/:id/pause-auto-charge", "api/admin/pause-auto-charge.js"),
  route("/api/admin/orders/:id/resume-auto-charge", "api/admin/resume-auto-charge.js"),
  route("/api/admin/orders/:id/pause-reminders", "api/admin/pause-reminders.js"),
  route("/api/admin/orders/:id/resume-reminders", "api/admin/resume-reminders.js"),
  route("/api/sync/retail-order", "api/sync/retail-order.js"),
  route("/api/sync/retail-inventory-update", "api/sync/retail-inventory-update.js"),
  route("/api/admin/sync/backfill", "api/admin/sync-backfill.js"),
  route("/api/admin/sync/inventory-snapshot", "api/admin/sync-inventory-snapshot.js"),
  route("/api/admin/backfill-customer-tags", "api/admin/backfill-customer-tags.js"),
];
