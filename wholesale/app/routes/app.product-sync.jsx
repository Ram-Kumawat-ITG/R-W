/* eslint-disable react/prop-types */
// Product sync — retail price controls.
//
// Exists because Shopify sends NO webhook when only a VARIANT metafield changes:
// editing a wholesale variant's "Retail price" (`custom.retail_price`) produces
// no products/update, so the webhook-driven sync never hears about it. The
// reconcile CRON is the automatic safety net; this page is the manual "do it
// now" so a merchant doesn't have to wait for the next tick.
//
// Two actions, both hitting POST /api/admin/sync/retail-prices:
//   Check for changes — dry run: reports drift, writes nothing.
//   Sync prices now   — applies: writes ONLY price / compare_at_price on the
//                       variants that are actually out of sync.

import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { syncConfig, isSyncEnabled } from "../services/sync/sync.config";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  // Loader-only import of the server config — react-router strips it from the
  // client bundle, so the plain values below are all that reach the browser.
  return {
    retailSyncConfigured: isSyncEnabled(),
    retailShop: syncConfig.retailShop || null,
    reconcileEnabled: Boolean(syncConfig.retailPriceReconcileEnabled),
    reconcileSchedule:
      syncConfig.retailPriceReconcileInterval ||
      syncConfig.retailPriceReconcileCron ||
      null,
    reconcileMode: syncConfig.retailPriceReconcileInterval ? "interval" : "cron",
  };
};

const money = (v) => (v === null || v === undefined || v === "" ? "—" : `$${Number(v).toFixed(2)}`);

function SummaryStats({ summary }) {
  return (
    <s-stack direction="inline" gap="large" wrap>
      <s-text tone="subdued">Products scanned: {summary.productsScanned}</s-text>
      <s-text tone="subdued">Variants checked: {summary.variantsChecked}</s-text>
      <s-text tone={summary.variantsDrifted > 0 ? "caution" : "subdued"}>
        Out of sync: {summary.variantsDrifted}
      </s-text>
      {!summary.dryRun && (
        <s-text tone={summary.variantsUpdated > 0 ? "success" : "subdued"}>
          Updated: {summary.variantsUpdated}
        </s-text>
      )}
      {summary.variantsSkipped > 0 && (
        <s-text tone="subdued">Skipped (not mapped): {summary.variantsSkipped}</s-text>
      )}
      {summary.errors > 0 && <s-text tone="critical">Errors: {summary.errors}</s-text>}
    </s-stack>
  );
}

function ChangesTable({ changes, truncated }) {
  if (!changes || changes.length === 0) return null;
  return (
    <s-stack direction="block" gap="small-200">
      <s-table>
        <s-table-header-row>
          <s-table-header>Product</s-table-header>
          <s-table-header>SKU</s-table-header>
          <s-table-header>Retail price</s-table-header>
          <s-table-header>Compare-at</s-table-header>
          <s-table-header>Status</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {changes.map((c, i) => (
            <s-table-row key={`${c.retailVariantId}-${i}`}>
              <s-table-cell>{c.productTitle || `#${c.wholesaleProductId}`}</s-table-cell>
              <s-table-cell>{c.sku || "—"}</s-table-cell>
              <s-table-cell>
                {money(c.fromPrice)} → {money(c.toPrice)}
              </s-table-cell>
              <s-table-cell>
                {money(c.fromCompareAt)} → {money(c.toCompareAt)}
              </s-table-cell>
              <s-table-cell>
                {c.applied ? (
                  <s-badge tone="success">Synced</s-badge>
                ) : (
                  <s-badge tone="warning">Pending</s-badge>
                )}
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
      {truncated && (
        <s-text tone="subdued">
          Only the first {changes.length} rows are listed — the counts above are complete.
        </s-text>
      )}
    </s-stack>
  );
}

export default function ProductSync() {
  const {
    retailSyncConfigured,
    retailShop,
    reconcileEnabled,
    reconcileSchedule,
    reconcileMode,
  } = useLoaderData();
  const fetcher = useFetcher();

  const running = fetcher.state !== "idle";
  const payload = fetcher.data;
  const summary = payload?.status === "success" ? payload.result : null;
  const errorMessage = payload && payload.status !== "success" ? payload.message : null;

  function run(dryRun) {
    fetcher.submit(
      { dryRun },
      {
        method: "post",
        action: "/api/admin/sync/retail-prices",
        encType: "application/json",
      },
    );
  }

  return (
    <s-page heading="Product sync">
      <s-section heading="Retail prices">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Retail prices come from the <s-text fontWeight="bold">Retail price</s-text> and{" "}
            <s-text fontWeight="bold">Retail compare-at price</s-text> metafields on each
            wholesale <s-text fontWeight="bold">variant</s-text>. Shopify does not send a
            webhook when only a variant metafield changes, so an edit to those fields alone
            cannot be pushed the moment you save it — it is picked up by the reconcile check
            instead. Use the buttons below to run that check immediately.
          </s-paragraph>

          {!retailSyncConfigured && (
            <s-banner tone="critical" heading="Retail sync is not configured">
              <s-paragraph>
                Set RETAIL_SHOP_DOMAIN and RETAIL_ADMIN_ACCESS_TOKEN before syncing prices.
              </s-paragraph>
            </s-banner>
          )}

          {retailSyncConfigured && (
            <s-banner tone={reconcileEnabled ? "info" : "warning"}>
              <s-paragraph>
                {reconcileEnabled
                  ? `Automatic check is ON — runs ${
                      reconcileMode === "interval"
                        ? `every ${reconcileSchedule}`
                        : `on schedule "${reconcileSchedule}"`
                    } against ${retailShop}. Only prices that differ are written.`
                  : `Automatic check is OFF (RETAIL_PRICE_RECONCILE_ENABLED=false) — retail prices only update when you run it here.`}
              </s-paragraph>
            </s-banner>
          )}

          <s-stack direction="inline" gap="base">
            <s-button
              variant="primary"
              onClick={() => run(false)}
              disabled={running || !retailSyncConfigured}
              loading={running ? "true" : undefined}
            >
              Sync prices now
            </s-button>
            <s-button
              onClick={() => run(true)}
              disabled={running || !retailSyncConfigured}
            >
              Check for changes
            </s-button>
          </s-stack>

          {running && (
            <s-text tone="subdued">
              Reading every wholesale variant’s retail-price metafields and comparing them with
              the retail store — this can take a moment on a large catalog.
            </s-text>
          )}

          {errorMessage && (
            <s-banner tone="critical" heading="Sync failed">
              <s-paragraph>{errorMessage}</s-paragraph>
            </s-banner>
          )}

          {summary && (
            <s-stack direction="block" gap="base">
              <s-banner
                tone={
                  summary.errors > 0
                    ? "warning"
                    : summary.dryRun
                      ? "info"
                      : "success"
                }
                heading={summary.dryRun ? "Check complete" : "Sync complete"}
              >
                <s-paragraph>{payload.message}</s-paragraph>
              </s-banner>
              <SummaryStats summary={summary} />
              <ChangesTable changes={summary.changes} truncated={summary.changesTruncated} />
              {summary.dryRun && summary.variantsDrifted > 0 && (
                <s-text tone="subdued">
                  Nothing was written. Click “Sync prices now” to apply these changes.
                </s-text>
              )}
            </s-stack>
          )}

          <s-text tone="subdued">
            A variant with no Retail price metafield is left alone — the retail store keeps its
            current price. Only price and compare-at are written; titles, images and other
            fields continue to sync automatically when you edit the product.
          </s-text>
        </s-stack>
      </s-section>
    </s-page>
  );
}
