// Retail Shopify → Retail QBO product (Products & Services) sync.
//
// For each RETAIL Shopify product lifecycle event this creates/updates one
// QBO Item per variant in the RETAIL realm and maintains the
// retail_qbo_product_maps mapping (Shopify product id + variant id + SKU ↔
// QBO Item id). One-way, retail Shopify → retail QBO, always. Retail QBO is
// only ever synchronized FROM the retail Shopify store — nothing else feeds it.
//
// Retention policy (per requirement): products are NEVER deleted or
// deactivated in QBO — not on Shopify archive, not on Shopify delete.
//
// Reliability: config-gated (retailQboConfig.productSyncEnabled); transport
// transient-retry + QBO requestid idempotency come from retailQbo.apis.js;
// per-variant sync state persists on retail_qbo_product_maps for logging +
// retry via retryFailedRetailQboProductSyncs(); best-effort per variant (one
// failure never blocks the others); never throws (callers are fire-and-forget).

import { upsertRetailQboItem } from "./retailQbo.service";
import { retailQboConfig, isRetailQboConfigured } from "./retailQbo.config";
import RetailQboProductMap from "../../models/retailQboProductMap.server";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("retail.qbo.product_sync");

export function isRetailQboProductSyncEnabled() {
  return Boolean(retailQboConfig.productSyncEnabled) && isRetailQboConfigured();
}

function buildDescription(product, variant) {
  const parts = [product?.title, variant?.title]
    .map((s) => (s ? String(s).trim() : ""))
    .filter(Boolean)
    .filter((p) => p.toLowerCase() !== "default title");
  return parts.join(" — ") || null;
}

async function syncVariant({ shop, product, variant }) {
  const shopifyProductId = String(product.id);
  const shopifyVariantId = String(variant.id);
  const sku = variant?.sku ? String(variant.sku).trim() : "";
  const shopifyPrice = priceOf(variant);

  const baseSet = {
    shopifyProductId,
    shopifyVariantId,
    sku: sku || null,
    productTitle: product?.title ?? null,
    variantTitle: variant?.title ?? null,
    vendor: product?.vendor ?? null,
    shopifyPrice,
    shopifyStatus: product?.status ?? null,
    shopifyDeleted: false,
  };
  if (shop) baseSet.shop = shop;

  if (!sku) {
    log.warn("variant.skip_no_sku", { shopifyProductId, shopifyVariantId });
    await RetailQboProductMap.updateOne(
      { shopifyVariantId },
      { $set: { ...baseSet, syncStatus: "skipped", lastAction: "skipped", lastSyncError: "no SKU" } },
      { upsert: true },
    );
    return { status: "skipped" };
  }

  try {
    const result = await upsertRetailQboItem({
      sku,
      name: product?.title ?? null,
      description: buildDescription(product, variant),
      price: shopifyPrice,
      qtyOnHand: variant?.inventory_quantity ?? 0,
    });
    await RetailQboProductMap.updateOne(
      { shopifyVariantId },
      {
        $set: {
          ...baseSet,
          qboItemId: result.qboItemId,
          qboItemName: result.qboItemName,
          qboSyncToken: result.qboSyncToken,
          syncStatus: "synced",
          lastSyncedAt: new Date(),
          lastSyncError: null,
          lastAction: result.action,
        },
        $inc: { syncAttemptCount: 1 },
      },
      { upsert: true },
    );
    log.info("variant.synced", { shopifyVariantId, sku, qboItemId: result.qboItemId, action: result.action });
    return { status: "synced", action: result.action };
  } catch (err) {
    const message = err?.message || String(err);
    log.error("variant.failed", { shopifyProductId, shopifyVariantId, sku, err: message });
    await RetailQboProductMap.updateOne(
      { shopifyVariantId },
      {
        $set: { ...baseSet, syncStatus: "error", lastSyncError: message, lastAction: "error" },
        $inc: { syncAttemptCount: 1 },
      },
      { upsert: true },
    ).catch((e) => log.error("variant.state_write_failed", { shopifyVariantId, err: e?.message || String(e) }));
    return { status: "error", error: message };
  }
}

function priceOf(variant) {
  const raw = variant?.price;
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Sync every variant of a retail Shopify product (REST-shaped payload) to the
// retail QBO realm. `event` is 'create' | 'update' | 'backfill'. Never throws.
export async function syncRetailProductToQbo(product, { shop = null, event = "update" } = {}) {
  if (!isRetailQboProductSyncEnabled()) {
    log.info("disabled", { productId: product?.id });
    return { skipped: true, reason: "disabled" };
  }
  if (!product?.id) return { skipped: true, reason: "no_product_id" };

  const variants = product.variants || [];
  const summary = { productId: String(product.id), event, total: variants.length, synced: 0, updated: 0, skipped: 0, errored: 0 };

  for (const variant of variants) {
    const r = await syncVariant({ shop, product, variant });
    if (r.status === "error") summary.errored++;
    else if (r.status === "skipped") summary.skipped++;
    else {
      summary.synced++;
      if (r.action === "updated") summary.updated++;
    }
  }

  log.info("product.done", summary);
  return summary;
}

// Mark the mapping rows for a deleted retail Shopify product as shopify-deleted
// WITHOUT deleting the QBO Item or the mapping row (retention). Never throws.
export async function markRetailQboProductDeleted(shopifyProductId) {
  if (!isRetailQboProductSyncEnabled()) return { skipped: true };
  try {
    const res = await RetailQboProductMap.updateMany(
      { shopifyProductId: String(shopifyProductId) },
      { $set: { shopifyDeleted: true } },
    );
    log.info("product.marked_deleted", {
      shopifyProductId: String(shopifyProductId),
      matched: res?.matchedCount ?? 0,
    });
    return { matched: res?.matchedCount ?? 0 };
  } catch (err) {
    log.error("product.mark_deleted_failed", { shopifyProductId, err: err?.message || String(err) });
    return { error: err?.message || String(err) };
  }
}

// Reconciliation: retry variants left in 'error'/'pending' using the stored
// SKU + snapshot (no Shopify re-fetch). Never throws.
export async function retryFailedRetailQboProductSyncs({ limit = 200 } = {}) {
  if (!isRetailQboProductSyncEnabled()) return { skipped: true, reason: "disabled" };
  const rows = await RetailQboProductMap.find({
    syncStatus: { $in: ["error", "pending"] },
    sku: { $ne: null },
  })
    .limit(limit)
    .lean();
  const summary = { candidates: rows.length, fixed: 0, stillFailing: 0 };
  for (const row of rows) {
    try {
      const result = await upsertRetailQboItem({
        sku: row.sku,
        name: row.productTitle,
        description: [row.productTitle, row.variantTitle]
          .filter((s) => s && s.toLowerCase() !== "default title")
          .join(" — ") || null,
        price: row.shopifyPrice,
      });
      await RetailQboProductMap.updateOne(
        { shopifyVariantId: row.shopifyVariantId },
        {
          $set: {
            qboItemId: result.qboItemId,
            qboItemName: result.qboItemName,
            qboSyncToken: result.qboSyncToken,
            syncStatus: "synced",
            lastSyncedAt: new Date(),
            lastSyncError: null,
            lastAction: result.action,
          },
          $inc: { syncAttemptCount: 1 },
        },
      );
      summary.fixed++;
    } catch (err) {
      summary.stillFailing++;
      await RetailQboProductMap.updateOne(
        { shopifyVariantId: row.shopifyVariantId },
        { $set: { syncStatus: "error", lastSyncError: err?.message || String(err) }, $inc: { syncAttemptCount: 1 } },
      ).catch(() => {});
    }
  }
  log.info("reconcile.done", summary);
  return summary;
}
