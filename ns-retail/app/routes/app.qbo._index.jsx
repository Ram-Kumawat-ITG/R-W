import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { redirect } = await authenticate.admin(request);
  return redirect("/app/qbo/dashboard");
};

export default function QboIndex() {
  return null;
}
