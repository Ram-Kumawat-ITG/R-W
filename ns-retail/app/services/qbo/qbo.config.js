// CDO QuickBooks Online configuration.
//
// This is the CDO Program's OWN QBO account — fully independent from the
// wholesale workspace's QBO integration. It reads CDO_QBO_* env vars
// (note the prefix) so the two realms can be configured + rotated
// separately and never collide.
//
// `assertQboConfigured()` fails fast with a clear error at call sites that
// need credentials, instead of letting Intuit reject with a generic 401.

import { readEnv } from "../../utils/env.utils";
import { QBO_BASE_URLS, QBO_OAUTH_TOKEN_URL, QBO_APP_URLS } from "./qbo.constants";

const qboEnvironment = readEnv("CDO_QBO_ENVIRONMENT", { fallback: "sandbox" });
if (!QBO_BASE_URLS[qboEnvironment]) {
  throw new Error(
    `CDO_QBO_ENVIRONMENT must be 'sandbox' or 'production', got: ${qboEnvironment}`,
  );
}

export const qboConfig = {
  clientId: readEnv("CDO_QBO_CLIENT_ID"),
  clientSecret: readEnv("CDO_QBO_CLIENT_SECRET"),
  realmId: readEnv("CDO_QBO_REALM_ID"),
  // Seed refresh token from env on first run. After that, Mongo
  // (cdo_qbo_tokens) is the source of truth — see qbo.apis.js.
  bootstrapRefreshToken: readEnv("CDO_QBO_REFRESH_TOKEN"),
  environment: qboEnvironment,
  apiBaseUrl: readEnv("CDO_QBO_API_BASE_URL", { fallback: QBO_BASE_URLS[qboEnvironment] }),
  appBaseUrl: readEnv("CDO_QBO_APP_BASE_URL", { fallback: QBO_APP_URLS[qboEnvironment] }),
  oauthTokenUrl: readEnv("CDO_QBO_OAUTH_TOKEN_URL", { fallback: QBO_OAUTH_TOKEN_URL }),
  minorVersion: readEnv("CDO_QBO_MINOR_VERSION", { fallback: "73" }),

  // Accounts the payout postings reference. Bills expense to the
  // commission account; bill payments draw from the bank/clearing
  // account. AP account is optional (QBO defaults the company's A/P).
  commissionExpenseAccountId: readEnv("CDO_QBO_COMMISSION_EXPENSE_ACCOUNT_ID"),
  paymentAccountId: readEnv("CDO_QBO_PAYMENT_ACCOUNT_ID"),
  apAccountId: readEnv("CDO_QBO_AP_ACCOUNT_ID"),
};

export function assertQboConfigured() {
  const missing = ["clientId", "clientSecret", "realmId", "bootstrapRefreshToken"].filter(
    (k) => !qboConfig[k],
  );
  if (missing.length) {
    const envNames = missing.map((k) => {
      // Map config key → env var name for a friendlier message.
      const map = {
        clientId: "CDO_QBO_CLIENT_ID",
        clientSecret: "CDO_QBO_CLIENT_SECRET",
        realmId: "CDO_QBO_REALM_ID",
        bootstrapRefreshToken: "CDO_QBO_REFRESH_TOKEN",
      };
      return map[k];
    });
    throw new Error(`CDO QBO not configured. Missing: ${envNames.join(", ")}`);
  }
}

// Asserted lazily by the payout-execution path (not at module load) so
// the commission/accrual flows can run without payout-posting accounts.
export function assertPostingAccountsConfigured() {
  const missing = [];
  if (!qboConfig.commissionExpenseAccountId) missing.push("CDO_QBO_COMMISSION_EXPENSE_ACCOUNT_ID");
  if (!qboConfig.paymentAccountId) missing.push("CDO_QBO_PAYMENT_ACCOUNT_ID");
  if (missing.length) {
    throw new Error(`CDO QBO posting accounts not configured. Missing: ${missing.join(", ")}`);
  }
}
