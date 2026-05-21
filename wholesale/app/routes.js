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
  route("/api/update-profile",   "api/update-profile.js"),
  route("/api/admin/customers", "api/admin/customers.js"),
  route("/api/admin/customers/:id", "api/admin/customer.js"),
  route("/api/admin/customers/:id/decline", "api/admin/decline.js"),
  route("/api/admin/customers/:id/review", "api/admin/review.js"),
  route("/api/admin/customers/:id/unreview", "api/admin/unreview.js"),
  route("/api/admin/orders/:id/retry-payment", "api/admin/retry-payment.js"),
  route("/api/admin/orders/:id/mark-cheque-paid", "api/admin/mark-cheque-paid.js"),
  route("/api/admin/orders/:id/charge-card", "api/admin/charge-card.js"),
  route("/api/admin/orders/:id/qbo-invoice-pdf", "api/admin/qbo-invoice-pdf.js"),
];
