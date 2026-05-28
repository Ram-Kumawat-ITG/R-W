import { authenticate } from "../shopify.server";

// /app/nmi → /app/nmi/dashboard.
//
// CRITICAL: use the `redirect` returned by `authenticate.admin()` — NOT
// react-router's plain `redirect`. Inside the embedded Shopify admin
// iframe, a plain `Location:`-header redirect is intercepted by
// App Bridge and bounces the user back to the app's home page (the
// "Apps > <app-name>" landing) instead of following the redirect.
// `authenticate.admin().redirect` renders an App Bridge HTML response
// that performs the navigation properly within the iframe.
//
// See node_modules/@shopify/shopify-app-react-router/src/server/
// authenticate/admin/helpers/redirect.ts for the detection logic.
export const loader = async ({ request }) => {
  const { redirect } = await authenticate.admin(request);
  return redirect("/app/nmi/dashboard");
};

export default function NmiIndex() {
  return null;
}
