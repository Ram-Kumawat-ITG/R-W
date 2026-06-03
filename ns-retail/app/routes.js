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
  route("/api/signup-form", "api/signup-form.js"),
];
