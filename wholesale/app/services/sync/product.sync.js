import IdMap from "./idMap.model";
import { retailClient } from "./retailApi";
import { resolveRetailLocationId } from "./sync.utils";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("sync.product");

// Build the payload for a retail product create/update from the
// wholesale webhook payload (Shopify REST format).
//
// `includePrice` defaults to FALSE — wholesale and retail have different
// pricing tiers (retail = ~2× wholesale), so prices should NOT be synced
// from wholesale to retail. Callers can opt-in with `{ includePrice: true }`
// for the rare case where prices ARE intentionally mirrored.
function buildRetailPayload(p, { includePrice = false } = {}) {
  return {
    product: {
      title: p.title,
      body_html: p.body_html,
      vendor: p.vendor,
      product_type: p.product_type,
      tags: p.tags,
      status: p.status,
      options: p.options?.map((o) => ({ name: o.name, values: o.values })),
      variants: p.variants?.map((v) => ({
        option1: v.option1,
        option2: v.option2,
        option3: v.option3,
        ...(includePrice && {
          price: v.price,
          compare_at_price: v.compare_at_price,
        }),
        sku: v.sku,
        taxable: v.taxable,
        barcode: v.barcode,
        inventory_management: "shopify",
        inventory_policy: v.inventory_policy,
      })),
      images: p.images
        ?.filter((i) => i.src)
        .map((i) => ({ src: i.src, alt: i.alt || null })),
    },
  };
}

// Pair wholesale + retail variant arrays by SKU. Both stores share SKUs
// because the retail variant is created from the wholesale payload, so SKU
// is the only stable cross-store identifier — positional indexing breaks
// the moment either side reorders variants in Shopify admin, after which
// every downstream write (IdMap, inventory snapshot, price snapshot) would
// silently land on the wrong row.
//
// Variants on either side with no SKU, or with no matching SKU on the
// other side, are skipped with a warn log so the sync proceeds for the
// remaining variants instead of corrupting the mapping.
function pairVariantsBySku(wholesaleVariants, retailVariants) {
  const retailBySku = new Map();
  for (const rv of retailVariants || []) {
    if (rv?.sku) retailBySku.set(rv.sku, rv);
  }
  const pairs = [];
  for (const wv of wholesaleVariants || []) {
    if (!wv?.sku) {
      log.warn("variant_pair.wholesale_no_sku", { wholesaleVariantId: wv?.id });
      continue;
    }
    const rv = retailBySku.get(wv.sku);
    if (!rv) {
      log.warn("variant_pair.no_retail_match", {
        wholesaleVariantId: wv.id,
        sku: wv.sku,
      });
      continue;
    }
    pairs.push([wv, rv]);
  }
  return pairs;
}

// Set inventory levels on the retail store for each variant after product creation.
// Uses the wholesale location_id (from the product or null) to resolve the retail location.
async function setRetailInventoryForProduct(
  wholesaleVariants,
  retailVariants,
  wholesaleLocationId,
) {
  const retailLocationId = await resolveRetailLocationId(
    wholesaleLocationId ?? null,
  );
  if (!retailLocationId) {
    log.warn("set_retail_inventory.no_location");
    return;
  }
  for (const [wv, rv] of pairVariantsBySku(wholesaleVariants, retailVariants)) {
    const qty = wv.inventory_quantity ?? 0;
    if (!rv.inventory_item_id) continue;
    try {
      await retailClient.post("inventory_levels/set.json", {
        inventory_item_id: Number(rv.inventory_item_id),
        location_id: Number(retailLocationId),
        available: qty,
      });
      log.info("set_retail_inventory.done", { wholesaleVariantId: wv.id, qty });
    } catch (err) {
      log.warn("set_retail_inventory.failed", {
        wholesaleVariantId: wv.id,
        err,
      });
    }
  }
}

// Parse a Shopify REST variant price string ("9.99") into a Number, or
// null if the field is missing/blank. Shopify always serializes price as
// a string; using Number() gives `0` for "" which would be misleading,
// so empty/null/undefined explicitly maps to null.
function variantPriceToNumber(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Store variant + inventory item mappings after a create or update.
async function upsertVariantMappings(wholesaleVariants, retailVariants) {
  for (const [wv, rv] of pairVariantsBySku(wholesaleVariants, retailVariants)) {
    await IdMap.updateOne(
      { entityType: "productVariant", wholesaleId: String(wv.id) },
      {
        $set: {
          entityType: "productVariant",
          wholesaleId: String(wv.id),
          retailId: String(rv.id),
          wholesaleInventoryItemId: String(wv.inventory_item_id),
          // Price snapshots — captured from BOTH stores' variant payloads
          // at sync time. Schema field docs: services/sync/idMap.model.js.
          wholesalePrice: variantPriceToNumber(wv.price),
          retailPrice: variantPriceToNumber(rv.price),
          wholesaleCompareAtPrice: variantPriceToNumber(wv.compare_at_price),
          retailCompareAtPrice: variantPriceToNumber(rv.compare_at_price),
        },
      },
      { upsert: true },
    );
    const invSet = {
      entityType: "inventoryItem",
      wholesaleId: String(wv.inventory_item_id),
      retailId: String(rv.inventory_item_id),
    };
    // inventory_quantity is present in both webhook payloads and backfill data.
    // Save it as available so the restock-detection delta has a baseline immediately.
    if (wv.inventory_quantity != null) invSet.available = wv.inventory_quantity;
    await IdMap.updateOne(
      {
        entityType: "inventoryItem",
        wholesaleId: String(wv.inventory_item_id),
      },
      { $set: invSet },
      { upsert: true },
    );
  }
}

export async function syncProductCreate(wholesaleProduct) {
  const wholesaleId = String(wholesaleProduct.id);

  const existing = await IdMap.findOne({ entityType: "product", wholesaleId });
  if (existing) {
    log.info("product_create.already_mapped", {
      wholesaleId,
      retailId: existing.retailId,
    });
    return syncProductUpdate(wholesaleProduct);
  }

  const data = await retailClient.post(
    "products.json",
    buildRetailPayload(wholesaleProduct),
  );
  const retailProduct = data?.product;
  if (!retailProduct?.id) {
    throw new Error(
      `syncProductCreate: no retail product id returned for wholesale ${wholesaleId}`,
    );
  }

  await IdMap.create({
    entityType: "product",
    wholesaleId,
    retailId: String(retailProduct.id),
  });
  await upsertVariantMappings(
    wholesaleProduct.variants || [],
    retailProduct.variants || [],
  );
  await setRetailInventoryForProduct(
    wholesaleProduct.variants || [],
    retailProduct.variants || [],
    wholesaleProduct.location_id ?? null,
  );

  log.info("product_create.done", {
    wholesaleId,
    retailId: String(retailProduct.id),
  });
  return retailProduct;
}

export async function syncProductUpdate(wholesaleProduct) {
  const wholesaleId = String(wholesaleProduct.id);

  const mapping = await IdMap.findOne({ entityType: "product", wholesaleId });
  if (!mapping) {
    log.warn("product_update.no_mapping", { wholesaleId });
    return;
  }

  const retailId = mapping.retailId;
  await retailClient.put(
    `products/${retailId}.json`,
    buildRetailPayload(wholesaleProduct, { includePrice: false }),
  );

  // Re-fetch to get current retail variant IDs (variants may be added/removed)
  const retailData = await retailClient.get(`products/${retailId}.json`);
  await upsertVariantMappings(
    wholesaleProduct.variants || [],
    retailData?.product?.variants || [],
  );

  log.info("product_update.done", { wholesaleId, retailId });
}

export async function syncProductDelete(wholesaleProductId) {
  const wholesaleId = String(wholesaleProductId);

  const mapping = await IdMap.findOne({ entityType: "product", wholesaleId });
  if (!mapping) {
    log.warn("product_delete.no_mapping", { wholesaleId });
    return;
  }

  try {
    await retailClient.delete(`products/${mapping.retailId}.json`);
  } catch (err) {
    if (!err.message?.includes("404")) throw err;
    log.warn("product_delete.retail_already_gone", {
      wholesaleId,
      retailId: mapping.retailId,
    });
  }

  await IdMap.deleteOne({ entityType: "product", wholesaleId });
  log.info("product_delete.done", { wholesaleId, retailId: mapping.retailId });
}
