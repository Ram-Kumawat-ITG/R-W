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

import { readEnv, readBool, readNumber } from "../../utils/env.utils";
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

  // ── Proactive Shopify → Retail-QBO product (Products & Services) sync ──
  // When ON, the retail store's products/create + products/update webhooks
  // create/update a QBO Item per variant in the RETAIL realm and maintain the
  // retail_qbo_product_maps mapping. Only ever syncs the RETAIL Shopify store.
  // Kill-switch: QBO_RETAIL_PRODUCT_SYNC_ENABLED=false. Defaults ON. NEVER
  // deletes/deactivates QBO items (retention).
  productSyncEnabled: readBool("QBO_RETAIL_PRODUCT_SYNC_ENABLED", true),
  // Create the QBO Items as `Inventory` type (TrackQtyOnHand + QtyOnHand +
  // InvStartDate) instead of `Service`, so QBO tracks stock. Requires QBO
  // Plus/Advanced + an Inventory-Asset account + a COGS account. Both accounts
  // auto-resolve from the retail realm's Chart of Accounts when the ids are
  // unset. If tracking is on but the accounts can't be resolved (or the plan
  // tier is too low), item creation GRACEFULLY falls back to Service type so
  // invoicing/sync never breaks.
  inventoryTrackingEnabled: readBool("QBO_RETAIL_INVENTORY_TRACKING_ENABLED", true),
  inventoryAssetAccountId: readEnv("QBO_RETAIL_INVENTORY_ASSET_ACCOUNT_ID", { fallback: null }),
  inventoryCogsAccountId: readEnv("QBO_RETAIL_INVENTORY_COGS_ACCOUNT_ID", { fallback: null }),
  // QBO requires an Inventory item's income account to be Detail Type
  // 'Sales of Product Income' (a generic Service-fee income account is
  // rejected). Auto-resolved from the Chart of Accounts when unset.
  productIncomeAccountId: readEnv("QBO_RETAIL_PRODUCT_INCOME_ACCOUNT_ID", { fallback: null }),

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

  // ── Vendor Bill (A/P "money out") — dropship cost owed to the wholesale
  //    supplier. In addition to the customer invoice (A/R), each PAID dropship
  //    order records an UNPAID QBO Bill in this same retail company against the
  //    "Natural Solution Wholesale" vendor, mirroring the wholesale invoice for
  //    the same order. Default ON; set QBO_RETAIL_CREATE_VENDOR_BILL=false to
  //    disable without touching the invoice flow.
  createVendorBill: readBool("QBO_RETAIL_CREATE_VENDOR_BILL", true),
  // The QBO Vendor the dropship bills post to. Prefer an explicit id; the
  // existing QBO_RETAIL_ADMIN_VENDOR alias ("all patient bills are recorded as
  // bills from this vendor") is accepted as a fallback. When NO id is set, the
  // service find-or-creates the vendor by name/email below.
  dropshipVendorId:
    readEnv("QBO_RETAIL_DROPSHIP_VENDOR_ID") || readEnv("QBO_RETAIL_ADMIN_VENDOR"),
  dropshipVendorName: readEnv("QBO_RETAIL_DROPSHIP_VENDOR_NAME", {
    fallback: "Natural Solution Wholesale",
  }),
  dropshipVendorEmail: readEnv("QBO_RETAIL_DROPSHIP_VENDOR_EMAIL", {
    fallback: "dropship@naturalsolutionsphc.com",
  }),
  // Expense / COGS account each bill line posts to. When unset, the service
  // auto-resolves a "Cost of Goods Sold" account (else any Expense account).
  dropshipExpenseAccountId: readEnv("QBO_RETAIL_DROPSHIP_EXPENSE_ACCOUNT_ID"),
  // Optional explicit A/P account for the bill (QBO defaults the company's A/P
  // when omitted). Reuses the same QBO_RETAIL_AP_ACCOUNT_ID as the payout Bills.
  apAccountId: readEnv("QBO_RETAIL_AP_ACCOUNT_ID"),

  // ── Bill reconciliation (mark the vendor bill PAID once the wholesale
  //    dropship invoice is paid) ──
  // When ON (default), the reconciler records a Retail QBO BillPayment that
  // fully applies to the vendor bill, drawn from this bank/clearing account
  // (QBO_RETAIL_PAYMENT_ACCOUNT_ID — same account the payout BillPayments use).
  // Required for the BillPayment; if unset the reconcile errors with a clear
  // reason rather than posting a malformed payment.
  reconcileVendorBill: readBool("QBO_RETAIL_RECONCILE_VENDOR_BILL", true),
  paymentAccountId: readEnv("QBO_RETAIL_PAYMENT_ACCOUNT_ID"),
  // The wholesale dropship order/invoice prices each line at this fraction of
  // the retail BASE price (½ today — see wholesale dropship.service
  // buildDropshipLineItems). The bill mirrors that, so keep the two in sync.
  wholesalePriceFactor: readNumber("QBO_RETAIL_WHOLESALE_PRICE_FACTOR", 0.5),
  // Mirror the wholesale invoice's shipping line (retail shipping at full cost,
  // per the wholesale draft order) onto the bill. Default ON.
  billIncludesShipping: readBool("QBO_RETAIL_BILL_INCLUDE_SHIPPING", true),
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
