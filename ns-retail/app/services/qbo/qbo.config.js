// CDO commission-payout QuickBooks Online configuration (Bills / BillPayments
// — the accounts-payable "money out" side).
//
// App-level OAuth credentials are SHARED across QBO companies and read from the
// bare QBO_* env vars; the company this client posts to (realm, token, posting
// accounts) is read from QBO_RETAIL_* — i.e. the payout Bills post to the same
// QBO company as the retail A/R invoices (services/retailQbo/*). Independent
// from the wholesale workspace's QBO integration.
//
// `assertQboConfigured()` fails fast with a clear error at call sites that
// need credentials, instead of letting Intuit reject with a generic 401.

import { readEnv } from "../../utils/env.utils";
import { QBO_BASE_URLS, QBO_OAUTH_TOKEN_URL, QBO_APP_URLS } from "./qbo.constants";

const qboEnvironment = readEnv("QBO_ENVIRONMENT", { fallback: "sandbox" });
if (!QBO_BASE_URLS[qboEnvironment]) {
  throw new Error(
    `QBO_ENVIRONMENT must be 'sandbox' or 'production', got: ${qboEnvironment}`,
  );
}

export const qboConfig = {
  clientId: readEnv("QBO_CLIENT_ID"),
  clientSecret: readEnv("QBO_CLIENT_SECRET"),
  realmId: readEnv("QBO_RETAIL_REALM_ID"),
  // Seed refresh token from env on first run. After that, Mongo
  // (cdo_qbo_tokens) is the source of truth — see qbo.apis.js.
  bootstrapRefreshToken: readEnv("QBO_RETAIL_REFRESH_TOKEN"),
  environment: qboEnvironment,
  apiBaseUrl: readEnv("QBO_API_BASE_URL", { fallback: QBO_BASE_URLS[qboEnvironment] }),
  appBaseUrl: readEnv("QBO_APP_BASE_URL", { fallback: QBO_APP_URLS[qboEnvironment] }),
  oauthTokenUrl: readEnv("QBO_OAUTH_TOKEN_URL", { fallback: QBO_OAUTH_TOKEN_URL }),
  minorVersion: readEnv("QBO_MINOR_VERSION", { fallback: "73" }),

  // Accounts the payout postings reference. Bills expense to the
  // commission account; bill payments draw from the bank/clearing
  // account. AP account is optional (QBO defaults the company's A/P).
  commissionExpenseAccountId: readEnv("QBO_RETAIL_COMMISSION_EXPENSE_ACCOUNT_ID"),
  paymentAccountId: readEnv("QBO_RETAIL_PAYMENT_ACCOUNT_ID"),
  apAccountId: readEnv("QBO_RETAIL_AP_ACCOUNT_ID"),
};

export function assertQboConfigured() {
  const missing = ["clientId", "clientSecret", "realmId", "bootstrapRefreshToken"].filter(
    (k) => !qboConfig[k],
  );
  if (missing.length) {
    const envNames = missing.map((k) => {
      // Map config key → env var name for a friendlier message.
      const map = {
        clientId: "QBO_CLIENT_ID",
        clientSecret: "QBO_CLIENT_SECRET",
        realmId: "QBO_RETAIL_REALM_ID",
        bootstrapRefreshToken: "QBO_RETAIL_REFRESH_TOKEN",
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
  if (!qboConfig.commissionExpenseAccountId) missing.push("QBO_RETAIL_COMMISSION_EXPENSE_ACCOUNT_ID");
  if (!qboConfig.paymentAccountId) missing.push("QBO_RETAIL_PAYMENT_ACCOUNT_ID");
  if (missing.length) {
    throw new Error(`CDO QBO posting accounts not configured. Missing: ${missing.join(", ")}`);
  }
}
