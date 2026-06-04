import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  // ── Sync the app's current URL to a shop metafield ──────────────────
  // The checkout UI extension needs to know where to send fetch() calls
  // (to /api/cdo/checkout-validate-code etc.), but Shopify doesn't give
  // checkout extensions the app URL directly. Workaround: on every
  // admin app load, write the current URL to a shop metafield in the
  // $app:cdo namespace. The extension subscribes to that metafield via
  // shopify.extension.toml and reads it at runtime.
  //
  // - Idempotent (metafieldsSet upserts on the unique ownerId/namespace/key)
  // - Best-effort — errors are logged but never block the admin response
  // - URL is re-synced on every admin page load so dev tunnel changes
  //   propagate the next time the admin opens the app
  syncAppUrlMetafield(admin, request).catch((err) => {
    console.warn(
      "[app.jsx] failed to sync app URL metafield:",
      err?.message || err,
    );
  });

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

async function syncAppUrlMetafield(admin, request) {
  const appUrl =
    // eslint-disable-next-line no-undef
    process.env.SHOPIFY_APP_URL || new URL(request.url).origin;
  if (!appUrl) return;

  // metafieldsSet needs the owner's GID. For shop metafields it's the
  // shop's own GID — query once per request (it's a tiny call).
  const shopRes = await admin.graphql(`query GetShopId { shop { id } }`);
  const shopData = await shopRes.json();
  const shopId = shopData?.data?.shop?.id;
  if (!shopId) return;

  const upsertRes = await admin.graphql(
    `mutation SyncAppUrl($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key value }
        userErrors { field message code }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: shopId,
            // $app namespace is reserved for THIS app — no scope conflict.
            // The :cdo segment groups our app's metafields.
            namespace: "$app:cdo",
            key: "app_url",
            type: "single_line_text_field",
            value: appUrl,
          },
        ],
      },
    },
  );
  const upsertData = await upsertRes.json();
  const errs = upsertData?.data?.metafieldsSet?.userErrors || [];
  if (errs.length) {
    console.warn("[app.jsx] metafieldsSet userErrors:", errs);
  }
}

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app" rel="home">Home</s-link>
        <s-link href="/app/orders">Orders</s-link>
        <s-link href="/app/cdo-program">CDO Program</s-link>
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
