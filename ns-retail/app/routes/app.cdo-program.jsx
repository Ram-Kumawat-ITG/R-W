import { Outlet, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import CdoTabs from "../components/cdo/CdoTabs";

// CDO Program portal shell. Renders the page frame + tab bar once; each
// tab is a child route rendered into the Outlet. Child loaders fetch the
// data for their tab, so this layout loader only authenticates.

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export default function CdoProgramLayout() {
  return (
    <s-page inlineSize="large" heading="CDO Program">
      <CdoTabs />
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
