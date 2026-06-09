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
  // Immediate Payment — public, non-embedded self-pay page. The durable
  // /pay/:token link + QR are baked into the QBO invoice; the page renders
  // an NMI Collect.js card form and charges the exact outstanding balance.
  // No Shopify auth — secured by the opaque token + server-side amount
  // derivation; card data is tokenized by NMI and never hits our server.
  route("/pay/:token", "api/pay/pay.jsx"),
  // Practitioner Portal moved to the ns-retail app (extension + /api/portal/*
  // backend now live there — it owns the cdo_* collections). See ns-retail.
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
  route("/api/admin/orders/:id/send-invoice", "api/admin/send-invoice.js"),
  route("/api/admin/orders/:id/refresh-pay-link", "api/admin/refresh-pay-link.js"),
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
