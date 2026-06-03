// QuickBooks Online API constants for the CDO QBO client — values that
// don't come from the environment and rarely change between deployments.

export const QBO_BASE_URLS = {
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
  production: "https://quickbooks.api.intuit.com",
};

// Web-app hosts (not the API) — used to build deep links the admin UI
// embeds so operators can jump straight to a QBO record (vendor / bill /
// bill payment). Intuit routes the user to whichever realm they're signed
// into, so we don't encode the realmId in the URL.
export const QBO_APP_URLS = {
  sandbox: "https://app.sandbox.qbo.intuit.com",
  production: "https://app.qbo.intuit.com",
};

export const QBO_OAUTH_TOKEN_URL =
  "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

// Refresh the access token if it's within this many ms of expiring.
// Intuit access tokens last 60 min; refresh ~1 min early to avoid a 401
// on the very next request.
export const ACCESS_TOKEN_SAFETY_MS = 60 * 1000;
