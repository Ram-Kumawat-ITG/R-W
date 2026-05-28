import { redirect } from "react-router";
import { authenticate } from "../shopify.server";

// /app/qbo lands here and immediately bounces to the Dashboard tab.
//
// Why not just route the layout to dashboard directly? The flat-routes
// layout file (`app.qbo.jsx`) renders for ALL `/app/qbo/*` children,
// including the deep tabs. A child must render at `/app/qbo` for the
// layout's <Outlet /> to fill — this index is that child, and the
// cleanest behavior is "open the dashboard".
//
// Uses the `redirect` returned from `authenticate.admin` so the embedded
// app navigation stays inside the iframe (a plain react-router `redirect`
// would target the outer window).
export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return redirect("/app/qbo/dashboard");
};

export default function QboIndex() {
  // Never rendered — the loader redirects. Kept as a safety net.
  return null;
}
