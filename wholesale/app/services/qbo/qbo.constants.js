// QuickBooks Online API constants — values that don't come from the
// environment and are unlikely to change between deployments.

export const QBO_BASE_URLS = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
  production: 'https://quickbooks.api.intuit.com',
}

// Web-app hosts (not the API) — used to build deep links the admin UI
// embeds so operators can jump straight to a QBO record. Intuit routes
// the user to whichever realm they're signed into, so we don't need to
// encode the realmId in the URL.
export const QBO_APP_URLS = {
  sandbox: 'https://app.sandbox.qbo.intuit.com',
  production: 'https://app.qbo.intuit.com',
}

export const QBO_OAUTH_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'

// Refresh the access token if it's within this many ms of expiring.
// Intuit access tokens last 60 min; we refresh ~1 min before expiry to
// avoid a 401 on the very next request.
export const ACCESS_TOKEN_SAFETY_MS = 60 * 1000
