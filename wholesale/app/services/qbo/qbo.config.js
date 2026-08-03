// QuickBooks Online configuration.
// App-level OAuth credentials are shared and read from the bare QBO_* env vars
// (QBO_ENVIRONMENT / QBO_CLIENT_ID / QBO_CLIENT_SECRET / QBO_MINOR_VERSION);
// the wholesale company this client posts to (realm, token, item/account ids)
// is read from QBO_WHOLESALE_*. Validates `QBO_ENVIRONMENT` against the known
// hosts. Use `assertQboConfigured()` at call sites that need credentials
// to fail fast with a clear error instead of letting Intuit reject the
// request with a generic 401.

import { readEnv, readBool, readInt } from '../../utils/env.utils'
import { QBO_BASE_URLS, QBO_OAUTH_TOKEN_URL } from './qbo.constants'

const qboEnvironment = readEnv('QBO_ENVIRONMENT', { fallback: 'sandbox' })
if (!QBO_BASE_URLS[qboEnvironment]) {
  throw new Error(`QBO_ENVIRONMENT must be 'sandbox' or 'production', got: ${qboEnvironment}`)
}

export const qboConfig = {
  clientId: readEnv('QBO_CLIENT_ID'),
  clientSecret: readEnv('QBO_CLIENT_SECRET'),
  realmId: readEnv('QBO_WHOLESALE_REALM_ID'),
  // Seed refresh token from env on first run. After that, Mongo is the
  // source of truth — see qboToken.server model.
  bootstrapRefreshToken: readEnv('QBO_WHOLESALE_REFRESH_TOKEN'),
  environment: qboEnvironment,
  apiBaseUrl: readEnv('QBO_API_BASE_URL', { fallback: QBO_BASE_URLS[qboEnvironment] }),
  oauthTokenUrl: readEnv('QBO_OAUTH_TOKEN_URL', { fallback: QBO_OAUTH_TOKEN_URL }),
  minorVersion: readEnv('QBO_MINOR_VERSION', { fallback: '73' }),
  // Fallback QBO Item every invoice line references when it has no per-product
  // Item (shipping / discount / processing-fee lines, and product lines whose
  // SKU couldn't resolve). OPTIONAL — when unset the service find-or-creates a
  // Service item named `defaultItemName` and reuses it (see
  // qbo.service.resolveDefaultItemId), so no item id needs to pre-exist in QBO.
  // Previously defaulted to the literal id '1' (an implicit "QBO seeds item 1"
  // assumption); that assumption is gone.
  defaultItemId: readEnv('QBO_WHOLESALE_DEFAULT_ITEM_ID', { fallback: null }),
  // Name of the auto-created fallback item (only used when defaultItemId is unset
  // AND the QBO company has no existing Service item to adopt).
  defaultItemName: readEnv('QBO_WHOLESALE_DEFAULT_ITEM_NAME', { fallback: 'Wholesale Sales' }),
  // Income account for auto-created per-product Items (SKU column support).
  // Optional — normally we derive the income account from the default item
  // (QBO_WHOLESALE_DEFAULT_ITEM_ID); this is only the fallback when that item
  // exposes no IncomeAccountRef. See qbo.service.findOrCreateItemBySku.
  incomeAccountId: readEnv('QBO_WHOLESALE_INCOME_ACCOUNT_ID', { fallback: null }),
  // Sales-tax code applied at the transaction level (TxnTaxDetail.TxnTaxCodeRef)
  // so the tax the customer paid in Shopify renders as QBO's summary "Tax" row.
  // For a manual-sales-tax QBO company this must be a taxable TaxCode id (e.g. a
  // tax group). When unset, the service auto-resolves the company's default from
  // Preferences.TaxPrefs.TaxGroupCodeRef. Only used when the order carries tax.
  taxCodeId: readEnv('QBO_WHOLESALE_TAX_CODE_ID', { fallback: null }),
  // Proactive Shopify → QBO product (Products & Services) sync. When on,
  // products/create + products/update webhooks (and the admin backfill)
  // create/update a QBO Item per variant BEFORE any invoice needs it, and
  // maintain the qbo_product_maps mapping. Kill-switch: set
  // QBO_PRODUCT_SYNC_ENABLED=false to disable. Defaults ON — proactive item
  // creation is the SAME write the invoice path already does on-demand
  // (findOrCreateItemBySku), just earlier, so enabling it introduces no new
  // class of QBO write. NEVER deletes/deactivates QBO items.
  productSyncEnabled: readBool('QBO_PRODUCT_SYNC_ENABLED', true),
  // Create QBO Items as `Inventory` type (TrackQtyOnHand + QtyOnHand +
  // InvStartDate) instead of `Service`, so QBO tracks stock quantities.
  // Requires QBO Plus/Advanced. Inventory Items also need an Inventory-Asset
  // account and a COGS/expense account in addition to the income account;
  // both are auto-resolved from the Chart of Accounts when the ids below are
  // unset, but pinning them is recommended for determinism. If tracking is on
  // but the accounts can't be resolved, item creation GRACEFULLY falls back
  // to Service type so invoicing/sync never breaks.
  inventoryTrackingEnabled: readBool('QBO_INVENTORY_TRACKING_ENABLED', true),
  inventoryAssetAccountId: readEnv('QBO_INVENTORY_ASSET_ACCOUNT_ID', { fallback: null }),
  inventoryCogsAccountId: readEnv('QBO_INVENTORY_COGS_ACCOUNT_ID', { fallback: null }),
  // Offset account for InventoryAdjustment posts (used to reconcile QtyOnHand
  // after an item is created — QBO can't PATCH QtyOnHand on a plain item
  // update). Auto-resolved when unset (prefers an "Inventory Shrinkage" /
  // adjustment account, else the COGS account).
  inventoryAdjustmentAccountId: readEnv('QBO_INVENTORY_ADJUSTMENT_ACCOUNT_ID', { fallback: null }),
  // Inventory START DATE (QBO's Item.InvStartDate — the "as of" date from which
  // QBO tracks that item's quantity). QBO REJECTS any transaction dated BEFORE
  // an inventory item's start date with "Transaction date is prior to start
  // date for inventory item", so the start date must never land after a date we
  // might invoice on. Setting it to "today" is unsafe on two counts:
  //   1. TIMEZONE — we compute dates in UTC, but QBO stamps an invoice's
  //      TxnDate in the COMPANY's timezone. For a US company the QBO date is
  //      still yesterday for the first hours of our UTC day, so an item created
  //      in that window got a start date one day AFTER the invoice it was
  //      created for → every such order failed to invoice.
  //   2. BACK-DATED transactions — replayed / pending-approval orders (and the
  //      retail sibling, which stamps TxnDate from the order date) are invoiced
  //      with an earlier date than the item's creation.
  // So the start date is back-dated by this many days (floor 1). Set an explicit
  // QBO_INVENTORY_START_DATE (YYYY-MM-DD) to pin one fixed date instead.
  inventoryStartDate: readEnv('QBO_INVENTORY_START_DATE', { fallback: null }),
  inventoryStartBackdateDays: Math.max(1, readInt('QBO_INVENTORY_START_BACKDATE_DAYS', 30)),

  // ── Outbound-request pacing (see qbo.apis.js) ──────────────────────────
  // Composite pages (e.g. the QBO dashboard) fan out ~15 queries with
  // Promise.all, each of which retries up to httpRetryAttempts times. That
  // burst — 15 simultaneous TLS handshakes to one host, repeated — is what a
  // rate limiter or abuse filter reacts to, and it is the likely cause of
  // Intuit connectivity that works briefly and then stops.
  //
  // maxConcurrent  — queue requests beyond this many in flight at once.
  // requestTimeoutMs — bound each attempt. Without it a dropped connection
  //   hangs for the OS-level TCP timeout (~2 min), which is why a failing
  //   dashboard load took 12s+ per metric.
  // breaker*       — after N consecutive TRANSPORT failures (connection never
  //   established — not HTTP errors, which are real answers) fail fast for a
  //   cooldown instead of hammering a host that is clearly unreachable. One
  //   trial request is allowed through after the cooldown to test recovery.
  maxConcurrent: Math.max(1, readInt('QBO_MAX_CONCURRENT_REQUESTS', 3)),
  requestTimeoutMs: Math.max(1000, readInt('QBO_REQUEST_TIMEOUT_MS', 20000)),
  breakerThreshold: Math.max(1, readInt('QBO_BREAKER_THRESHOLD', 8)),
  breakerCooldownMs: Math.max(1000, readInt('QBO_BREAKER_COOLDOWN_MS', 60000)),
}

export function assertQboConfigured() {
  const missing = ['clientId', 'clientSecret', 'realmId', 'bootstrapRefreshToken']
    .filter((k) => !qboConfig[k])
  if (missing.length) {
    // config key → env var name (non-uniform: app-level creds use the bare
    // QBO_ prefix, company-level values use QBO_WHOLESALE_).
    const envNames = {
      clientId: 'QBO_CLIENT_ID',
      clientSecret: 'QBO_CLIENT_SECRET',
      realmId: 'QBO_WHOLESALE_REALM_ID',
      bootstrapRefreshToken: 'QBO_WHOLESALE_REFRESH_TOKEN',
    }
    throw new Error(`QBO not configured. Missing: ${missing.map((k) => envNames[k]).join(', ')}`)
  }
}
