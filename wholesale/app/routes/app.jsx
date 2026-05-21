import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { ensureProtectedWebhooks } from "../services/shopify/shopify.service";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  // Idempotent + non-throwing. Registers protected-data webhook topics
  // (orders/create) that cannot be declared in shopify.app.toml until
  // the app is approved in the Partners dashboard.
  await ensureProtectedWebhooks({ admin, shop: session?.shop });

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      {/*
        `rel="home"` marks the root link so Shopify's nav doesn't treat
        every /app/* route as still being on "Home" (prefix matching
        otherwise activates the home item on /app/orders/:id, etc.).
        Recognised by Shopify's app-bridge / nav-menu logic — see
        node_modules/@shopify/shopify-app-react-router/dist/.../redirect.js.
      */}
      <s-app-nav>
        <s-link href="/app" rel="home">Home</s-link>
        <s-link href="/app/customers">Wholesale applications</s-link>
        <s-link href="/app/orders">Orders</s-link>
        <s-link href="/app/additional">Additional page</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
