import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { MongoDBSessionStorage } from "@shopify/shopify-app-session-storage-mongodb";

// MongoDB session storage — replaces the legacy Prisma + SQLite setup.
// Sessions live alongside the CDO collections in the SAME MongoDB cluster
// shared with the wholesale workspace. Sessions are scoped by `shop`, so
// having wholesale + ns-retail in the same DB is fine — different shop
// domains never collide.
if (!process.env.MONGODB_URI) {
  throw new Error(
    "Please define the MONGODB_URI environment variable in ns-retail/.env",
  );
}

const mongoUrl = new URL(process.env.MONGODB_URI);
const dbName = process.env.DATABASE_NAME || mongoUrl.pathname.substring(1) || "natural-solutions";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new MongoDBSessionStorage(mongoUrl, dbName),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
