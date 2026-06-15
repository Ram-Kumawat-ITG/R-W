// Retail QuickBooks Online configuration — the QBO company used for RETAIL
// CUSTOMER ORDER INVOICES (accounts-receivable / "money in").
//
// App-level OAuth credentials are SHARED across QBO companies and read from the
// bare QBO_* env vars; company-specific config (realm, token, item/account ids,
// toggles) is read from QBO_RETAIL_*. The CDO commission-payout client
// (services/qbo/* — Bills/payouts) targets this SAME company, so the two share
// the realm's OAuth token. Independent from the wholesale workspace's QBO
// integration (different repo folder).
//
// Token state lives in the cdo_qbo_tokens collection, keyed by `realmId`
// (unique). See retailQbo.apis.js.
//
// SERVER-ONLY: reads process.env at module init. Import only from
// services / webhook routes / loaders — never from a route's render path.

import { readEnv, readBool } from "../../utils/env.utils";
import { QBO_BASE_URLS, QBO_APP_URLS, QBO_OAUTH_TOKEN_URL } from "../qbo/qbo.constants";

// Clamp to a known environment (don't throw at import — a missing/garbled
// config must not crash app boot; the feature degrades gracefully and
// surfaces the misconfig per-order instead).
const rawEnv = readEnv("QBO_ENVIRONMENT", { fallback: "sandbox" });
const environment = QBO_BASE_URLS[rawEnv] ? rawEnv : "sandbox";

export const retailQboConfig = {
  // Shared app credentials (QBO_*).
  clientId: readEnv("QBO_CLIENT_ID"),
  clientSecret: readEnv("QBO_CLIENT_SECRET"),
  environment,
  apiBaseUrl: readEnv("QBO_API_BASE_URL", { fallback: QBO_BASE_URLS[environment] }),
  appBaseUrl: readEnv("QBO_APP_BASE_URL", { fallback: QBO_APP_URLS[environment] }),
  oauthTokenUrl: readEnv("QBO_OAUTH_TOKEN_URL", { fallback: QBO_OAUTH_TOKEN_URL }),
  minorVersion: readEnv("QBO_MINOR_VERSION", { fallback: "73" }),

  // Company-specific config (QBO_RETAIL_*).
  realmId: readEnv("QBO_RETAIL_REALM_ID"),
  // Seed refresh token on first run; after that cdo_qbo_tokens (keyed by this
  // realmId) is the source of truth — see retailQbo.apis.js.
  bootstrapRefreshToken: readEnv("QBO_RETAIL_REFRESH_TOKEN"),

  // Invoice line posting. Per the locked decision, every product line posts
  // to ONE generic Sales item. If a QBO Item id is set we use it verbatim
  // (both QBO_RETAIL_ITEM_ID and QBO_RETAIL_DEFAULT_ITEM_ID are accepted);
  // otherwise the service auto-resolves (or creates) a Service item named
  // QBO_RETAIL_ITEM_NAME (default "Retail Sales"), deriving the income account
  // from an existing item or QBO_RETAIL_INCOME_ACCOUNT_ID.
  salesItemId: readEnv("QBO_RETAIL_ITEM_ID") || readEnv("QBO_RETAIL_DEFAULT_ITEM_ID"),
  salesItemName: readEnv("QBO_RETAIL_ITEM_NAME", { fallback: "Retail Sales" }),
  incomeAccountId: readEnv("QBO_RETAIL_INCOME_ACCOUNT_ID"),

  // Customer-facing email behavior — QBO is the delivery channel. Both default
  // ON per the retail spec; set the env to "false"/"0" to disable.
  //   sendInvoiceOnCreate — email the invoice to the customer right after it's
  //     created (and retry the email on a later order event if it failed).
  //   notifyOnShip — re-send the invoice (now carrying carrier + tracking +
  //     URL + shipment status in its memo) when tracking changes, as the
  //     shipment notification. Deduped on the tracking string.
  sendInvoiceOnCreate: readBool("QBO_RETAIL_SEND_INVOICE", true),
  notifyOnShip: readBool("QBO_RETAIL_NOTIFY_ON_SHIP", true),

  // Payment recording — when the Shopify order is PAID, create a QBO Payment
  // applied to the invoice so QBO shows it Paid (default ON). Optional
  // QBO_RETAIL_DEPOSIT_ACCOUNT_ID routes the payment to a specific account
  // (Bank / Undeposited Funds); omit to let QBO use its default.
  recordPaymentOnPaid: readBool("QBO_RETAIL_RECORD_PAYMENT", true),
  depositAccountId: readEnv("QBO_RETAIL_DEPOSIT_ACCOUNT_ID"),
};

// True when the four credentials needed to talk to the retail realm are set.
// Used by the orchestrator to no-op gracefully when retail QBO isn't wired up
// (so a dev without these env vars can still run the rest of the app).
export function isRetailQboConfigured() {
  return Boolean(
    retailQboConfig.clientId &&
      retailQboConfig.clientSecret &&
      retailQboConfig.realmId &&
      retailQboConfig.bootstrapRefreshToken,
  );
}

export function assertRetailQboConfigured() {
  const missing = ["clientId", "clientSecret", "realmId", "bootstrapRefreshToken"].filter(
    (k) => !retailQboConfig[k],
  );
  if (missing.length) {
    const map = {
      clientId: "QBO_CLIENT_ID",
      clientSecret: "QBO_CLIENT_SECRET",
      realmId: "QBO_RETAIL_REALM_ID",
      bootstrapRefreshToken: "QBO_RETAIL_REFRESH_TOKEN",
    };
    throw new Error(
      `Retail QBO not configured. Missing: ${missing.map((k) => map[k]).join(", ")}`,
    );
  }
}
