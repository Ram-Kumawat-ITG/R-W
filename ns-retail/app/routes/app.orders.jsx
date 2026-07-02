import { Outlet, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

// Orders module shell — the central view over the entire cdo_orders
// collection (every synced Shopify order, attributed or retail). Child
// routes render the list (_index) and per-order detail ($id).

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export default function OrdersLayout() {
  return (
    <s-page inlineSize="large" heading="Orders">
      <Outlet />
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
