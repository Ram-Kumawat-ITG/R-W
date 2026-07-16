import IdMap from "./idMap.model";
import { retailClient } from "./retailApi";
import { resolveRetailLocationId } from "./sync.utils";
import {
  fetchRetailPricingMetafield,
  resolveVariantPricing,
} from "./retailPricing";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("sync.product");

// Build the payload for a retail product create/update from the
// wholesale webhook payload (Shopify REST format).
//
// Pricing sources (checked in order per variant):
//   1. `retailPricing` — the parsed `custom.retail_pricing` metafield on the
//      wholesale product (fetched by `fetchRetailPricingMetafield`). This is
//      the primary + intended source of retail prices, added 2026-07-14.
//   2. `includePrice: true` — legacy escape hatch that copies wholesale
//      prices to retail directly. Only used when explicitly requested;
//      wholesale ≠ retail pricing tiers, so this is rarely correct.
//   3. Neither → variant is created WITHOUT a price (Shopify defaults it to
//      $0). Non-breaking: this matches the pre-2026-07-14 behavior.
//
// Variant-matching for the update path (2026-07-14):
//   Pass `retailVariantsBySku` = a Map<sku, retailVariantObject> keyed by
//   SKU. Each wholesale variant is looked up by SKU and the corresponding
//   retail variant's `id` is injected into the payload so Shopify's PUT
//   updates the correct row in place. Wholesale variants without a matching
//   retail SKU are SKIPPED from the payload with a warn log — the retail
//   variant stays untouched. When `retailVariantsBySku` is null (create
//   path), all wholesale variants are included and Shopify creates fresh
//   retail variants.
function buildRetailPayload(
  p,
  {
    includePrice = false,
    retailPricing = null,
    retailVariantsBySku = null,
  } = {},
) {
  const variants = (p.variants || [])
    .map((v) => buildRetailVariant(v, { includePrice, retailPricing, retailVariantsBySku }))
    .filter(Boolean);

  return {
    product: {
      title: p.title,
      body_html: p.body_html,
      vendor: p.vendor,
      product_type: p.product_type,
      tags: p.tags,
      status: p.status,
      options: p.options?.map((o) => ({ name: o.name, values: o.values })),
      variants,
      images: p.images
        ?.filter((i) => i.src)
        .map((i) => ({ src: i.src, alt: i.alt || null })),
    },
  };
}

// Build one variant entry for the retail payload. Returns null if the
// variant should be skipped (update path only — no retail SKU match).
function buildRetailVariant(v, { includePrice, retailPricing, retailVariantsBySku }) {
  const wholesaleSku = String(v?.sku || "").trim();

  // Update path — require SKU match against existing retail variants.
  let retailVariantId = null;
  if (retailVariantsBySku) {
    if (!wholesaleSku) {
      log.warn("variant.skip_no_sku", { wholesaleVariantId: v?.id });
      return null;
    }
    const retailVariant = retailVariantsBySku.get(wholesaleSku);
    if (!retailVariant) {
      log.warn("variant.skip_no_retail_match", {
        wholesaleVariantId: v?.id,
        sku: wholesaleSku,
      });
      return null;
    }
    retailVariantId = retailVariant.id;
  }

  const base = {
    // `id` — critical on the update path so Shopify updates the correct
    // retail variant in place instead of matching by option combinations.
    ...(retailVariantId != null && { id: retailVariantId }),
    option1: v.option1,
    option2: v.option2,
    option3: v.option3,
    sku: v.sku,
    taxable: v.taxable,
    barcode: v.barcode,
    inventory_management: "shopify",
    inventory_policy: v.inventory_policy,
    // Physical + shipping fields added 2026-07-14 so retail carrier-service
    // callback (rates.js) can compute correct package weight + dimensions.
    // Passed through verbatim from the wholesale variant — Shopify accepts
    // either `grams` (canonical) or `weight` + `weight_unit` and normalizes.
    ...(v.grams != null && { grams: v.grams }),
    ...(v.weight != null && { weight: v.weight }),
    ...(v.weight_unit && { weight_unit: v.weight_unit }),
    ...(v.requires_shipping != null && { requires_shipping: v.requires_shipping }),
    ...(v.position != null && { position: v.position }),
  };

  const metafieldPricing = resolveVariantPricing(v, retailPricing);
  if (metafieldPricing) {
    base.price = metafieldPricing.price;
    if (metafieldPricing.compareAtPrice) {
      base.compare_at_price = metafieldPricing.compareAtPrice;
    }
  } else if (includePrice) {
    base.price = v.price;
    base.compare_at_price = v.compare_at_price;
  }

  return base;
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

// Sentinel retailId stored on the claim row while a retail product create
// is in flight. Lets a concurrent duplicate webhook (Shopify at-least-once
// delivery, or the products/update Shopify fires right after create) detect
// the in-progress create and back off instead of POSTing a second retail
// product or PUTing against a nonexistent id.
export const PENDING_RETAIL_ID = "__pending__";

export async function syncProductCreate(wholesaleProduct, { shop } = {}) {
  const wholesaleId = String(wholesaleProduct.id);

  const existing = await IdMap.findOne({ entityType: "product", wholesaleId });
  if (existing) {
    if (existing.retailId === PENDING_RETAIL_ID) {
      log.warn("product_create.create_in_flight", { wholesaleId });
      return;
    }
    log.info("product_create.already_mapped", {
      wholesaleId,
      retailId: existing.retailId,
    });
    return syncProductUpdate(wholesaleProduct, { shop });
  }

  // ── Claim-first (2026-07-15) ─────────────────────────────────────────
  // Insert the mapping row BEFORE the retail POST so the unique
  // (entityType, wholesaleId) index — not the findOne above — is the real
  // duplicate guard. Two racing creates (duplicate webhook delivery, or a
  // restart replay) both pass the findOne when neither has inserted yet;
  // without this claim both would POST products.json and the loser's
  // retail product would be a permanent unmapped orphan.
  try {
    await IdMap.create({
      entityType: "product",
      wholesaleId,
      retailId: PENDING_RETAIL_ID,
    });
  } catch (err) {
    if (err?.code === 11000) {
      log.warn("product_create.lost_claim_race", { wholesaleId });
      return;
    }
    throw err;
  }

  // Fetch retail-price metafield from the wholesale product. Best-effort —
  // missing/malformed metafield returns null and we sync without prices
  // (pre-2026-07-14 behavior, non-breaking). `shop` is optional so any
  // legacy/test caller that doesn't pass it still works.
  const retailPricing = shop
    ? await fetchRetailPricingMetafield({ shop, productId: wholesaleId })
    : null;
  log.info("product_create.retail_pricing", {
    wholesaleId,
    hasPricing: !!retailPricing,
    topLevelPrice: retailPricing?.price ?? null,
    perVariantCount: retailPricing?.variantsBySku?.size ?? 0,
  });

  let retailProduct;
  try {
    const data = await retailClient.post(
      "products.json",
      buildRetailPayload(wholesaleProduct, { retailPricing }),
    );
    retailProduct = data?.product;
    if (!retailProduct?.id) {
      throw new Error(
        `syncProductCreate: no retail product id returned for wholesale ${wholesaleId}`,
      );
    }
  } catch (err) {
    // Release the claim so a later retry (webhook redelivery, manual
    // backfill) can attempt the create again instead of hitting the
    // "create in flight" guard forever.
    await IdMap.deleteOne({
      entityType: "product",
      wholesaleId,
      retailId: PENDING_RETAIL_ID,
    }).catch(() => {});
    throw err;
  }

  // Finalize the claim with the real retail id.
  await IdMap.updateOne(
    { entityType: "product", wholesaleId },
    { $set: { retailId: String(retailProduct.id) } },
  );
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

export async function syncProductUpdate(wholesaleProduct, { shop } = {}) {
  const wholesaleId = String(wholesaleProduct.id);

  const mapping = await IdMap.findOne({ entityType: "product", wholesaleId });
  if (!mapping) {
    log.warn("product_update.no_mapping", { wholesaleId });
    return;
  }
  if (mapping.retailId === PENDING_RETAIL_ID) {
    // A create is still in flight (Shopify fires products/update almost
    // immediately after products/create) — the create path will push the
    // full current payload, so skipping here loses nothing.
    log.warn("product_update.create_in_flight", { wholesaleId });
    return;
  }

  // Re-fetch the retail-price metafield on every update — the merchant may
  // have edited it. Missing → null → sync without prices (unchanged).
  const retailPricing = shop
    ? await fetchRetailPricingMetafield({ shop, productId: wholesaleId })
    : null;
  log.info("product_update.retail_pricing", {
    wholesaleId,
    hasPricing: !!retailPricing,
    topLevelPrice: retailPricing?.price ?? null,
    perVariantCount: retailPricing?.variantsBySku?.size ?? 0,
  });

  const retailId = mapping.retailId;

  // ── Pre-fetch retail product to pair variants by SKU (2026-07-14) ───
  //
  // Shopify PUT `/products/{id}.json` needs each variant's `id` in the
  // payload to update the correct variant in place. Without variant IDs,
  // Shopify falls back to matching by option combinations — which silently
  // fails to apply price / weight / etc. updates when the option keys
  // don't line up perfectly (empty SKUs, renamed options, etc.). This was
  // the root cause of "metafield edit didn't push to retail" bug fixed
  // 2026-07-14. Fetch retail's current variants, build a SKU → variant
  // map, and hand it to `buildRetailPayload`; wholesale variants without
  // a matching retail SKU are skipped (warn logged) so retail is never
  // silently mangled.
  const retailVariantsBySku = new Map();
  try {
    const preFetch = await retailClient.get(`products/${retailId}.json`);
    const currentRetailVariants = preFetch?.product?.variants || [];
    for (const rv of currentRetailVariants) {
      const sku = String(rv?.sku || "").trim();
      if (sku) retailVariantsBySku.set(sku, rv);
    }
    log.info("product_update.retail_prefetch_ok", {
      wholesaleId,
      retailId,
      retailVariantCount: currentRetailVariants.length,
      retailSkuCount: retailVariantsBySku.size,
    });
  } catch (err) {
    log.warn("product_update.retail_prefetch_failed", {
      wholesaleId,
      retailId,
      err: err?.message || String(err),
    });
    // Fall through — proceed without retail IDs. Existing behavior (Shopify
    // matches by option combinations) is preserved as the fallback.
  }

  await retailClient.put(
    `products/${retailId}.json`,
    buildRetailPayload(wholesaleProduct, {
      retailPricing,
      retailVariantsBySku:
        retailVariantsBySku.size > 0 ? retailVariantsBySku : null,
    }),
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
  if (mapping.retailId === PENDING_RETAIL_ID) {
    // Create still in flight — just drop the claim; there is no retail
    // product to delete yet (and if the racing create does land one, the
    // next products/delete redelivery or reconciliation pass cleans it up).
    await IdMap.deleteOne({ entityType: "product", wholesaleId });
    log.warn("product_delete.pending_claim_dropped", { wholesaleId });
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
