import { authenticate } from "../shopify.server";
 
export const loader = async ({ request }) => {
  const { redirect, session } = await authenticate.admin(request);
 
  return redirect("/app/orders");
};
 