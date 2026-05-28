import { authenticate } from "../shopify.server";

// /app/qbo lands here and immediately bounces to the Dashboard tab.
//
// Why not just route the layout to dashboard directly? The flat-routes
// layout file (`app.qbo.jsx`) renders for ALL `/app/qbo/*` children,
// including the deep tabs. A child must render at `/app/qbo` for the
// layout's <Outlet /> to fill — this index is that child, and the
// cleanest behavior is "open the dashboard".
//
// CRITICAL: use the `redirect` returned by `authenticate.admin()` — NOT
// react-router's plain `redirect`. Inside the embedded Shopify admin
// iframe, a plain `Location:`-header redirect is intercepted by
// App Bridge and bounces the user back to the app's home page instead
// of following the redirect. `authenticate.admin().redirect` renders an
// App Bridge HTML response that performs the navigation properly
// within the iframe.
//
// See node_modules/@shopify/shopify-app-react-router/src/server/
// authenticate/admin/helpers/redirect.ts for the detection logic.
export const loader = async ({ request }) => {
  const { redirect } = await authenticate.admin(request);
  return redirect("/app/qbo/dashboard");
};

export default function QboIndex() {
  // Never rendered — the loader redirects. Kept as a safety net.
  return null;
}
