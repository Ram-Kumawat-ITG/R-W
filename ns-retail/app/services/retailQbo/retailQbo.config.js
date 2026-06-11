// Retail QuickBooks Online configuration — the SEPARATE QBO company used
// only for RETAIL CUSTOMER ORDER INVOICES (accounts-receivable / "money in").
//
// Fully independent from:
//   - the CDO payouts QBO account (services/qbo/* — CDO_QBO_* — Bills/payouts)
//   - the wholesale workspace's QBO integration (different repo folder)
//
// Reads CDO_QBO_Retail_* env vars (note the mixed-case `Retail` the operator
// used). For resilience we also accept the all-caps CDO_QBO_RETAIL_* spelling.
//
// Token state for this realm lives in the SAME cdo_qbo_tokens collection as
// the CDO realm — that model is keyed by `realmId` (unique), so the two
// realms coexist without colliding. See retailQbo.apis.js.
//
// SERVER-ONLY: reads process.env at module init. Import only from
// services / webhook routes / loaders — never from a route's render path.

import { readEnv, readBool } from "../../utils/env.utils";
import { QBO_BASE_URLS, QBO_APP_URLS, QBO_OAUTH_TOKEN_URL } from "../qbo/qbo.constants";

// Read CDO_QBO_Retail_<KEY>, falling back to the all-caps CDO_QBO_RETAIL_<KEY>
// spelling, then to `fallback`. Keeps us robust to either env-var casing.
function readRetail(key, fallback) {
  const exact = readEnv(`CDO_QBO_Retail_${key}`);
  if (exact !== undefined && exact !== "") return exact;
  return readEnv(`CDO_QBO_RETAIL_${key}`, { fallback });
}

// Clamp to a known environment (don't throw at import — a missing/garbled
// retail config must not crash app boot; the feature degrades gracefully and
// surfaces the misconfig per-order instead).
const rawEnv = readRetail("ENVIRONMENT", "sandbox");
const environment = QBO_BASE_URLS[rawEnv] ? rawEnv : "sandbox";

export const retailQboConfig = {
  clientId: readRetail("CLIENT_ID"),
  clientSecret: readRetail("CLIENT_SECRET"),
  realmId: readRetail("REALM_ID"),
  // Seed refresh token on first run; after that cdo_qbo_tokens (keyed by this
  // realmId) is the source of truth — see retailQbo.apis.js.
  bootstrapRefreshToken: readRetail("REFRESH_TOKEN"),
  environment,
  apiBaseUrl: readRetail("API_BASE_URL", QBO_BASE_URLS[environment]),
  appBaseUrl: readRetail("APP_BASE_URL", QBO_APP_URLS[environment]),
  oauthTokenUrl: readRetail("OAUTH_TOKEN_URL", QBO_OAUTH_TOKEN_URL),
  minorVersion: readRetail("MINOR_VERSION", "73"),

  // Invoice line posting. Per the locked decision, every product line posts
  // to ONE generic Sales item. If a QBO Item id is set we use it verbatim
  // (both CDO_QBO_Retail_ITEM_ID and CDO_QBO_Retail_DEFAULT_ITEM_ID are
  // accepted); otherwise the service auto-resolves (or creates) a Service item
  // named CDO_QBO_Retail_ITEM_NAME (default "Retail Sales"), deriving the
  // income account from an existing item or CDO_QBO_Retail_INCOME_ACCOUNT_ID.
  salesItemId: readRetail("ITEM_ID") || readRetail("DEFAULT_ITEM_ID"),
  salesItemName: readRetail("ITEM_NAME", "Retail Sales"),
  incomeAccountId: readRetail("INCOME_ACCOUNT_ID"),

  // Customer-facing email behavior — QBO is the delivery channel. Both default
  // ON per the retail spec; set the env to "false"/"0" to disable.
  //   sendInvoiceOnCreate — email the invoice to the customer right after it's
  //     created (and retry the email on a later order event if it failed).
  //   notifyOnShip — re-send the invoice (now carrying carrier + tracking +
  //     URL + shipment status in its memo) when tracking changes, as the
  //     shipment notification. Deduped on the tracking string.
  sendInvoiceOnCreate: readBool("CDO_QBO_Retail_SEND_INVOICE", true),
  notifyOnShip: readBool("CDO_QBO_Retail_NOTIFY_ON_SHIP", true),
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
      clientId: "CDO_QBO_Retail_CLIENT_ID",
      clientSecret: "CDO_QBO_Retail_CLIENT_SECRET",
      realmId: "CDO_QBO_Retail_REALM_ID",
      bootstrapRefreshToken: "CDO_QBO_Retail_REFRESH_TOKEN",
    };
    throw new Error(
      `Retail QBO not configured. Missing: ${missing.map((k) => map[k]).join(", ")}`,
    );
  }
}
