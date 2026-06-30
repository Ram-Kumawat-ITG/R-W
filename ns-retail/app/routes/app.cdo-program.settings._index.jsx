import { authenticate } from "../shopify.server";

// Settings index. The Global Configuration tab was removed, so /settings has no
// content of its own — redirect to the (only) settings tab, Commission
// Configuration. Use the App Bridge redirect from authenticate.admin (NOT
// react-router's plain redirect, which App Bridge bounces to the app home).
export const loader = async ({ request }) => {
  const { redirect } = await authenticate.admin(request);
  return redirect("/app/cdo-program/settings/commission");
};
