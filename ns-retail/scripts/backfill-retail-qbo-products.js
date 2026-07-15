/* eslint-env node */
// Backfill: sync every RETAIL Shopify product into the RETAIL QBO realm as a
// Products & Services item (Inventory type), and reconcile each item's
// on-hand quantity to Shopify's CURRENT stock via an InventoryAdjustment.
//
// This is what corrects QBO items that were created (e.g. by the invoice-time
// path, or before stock was loaded) with QtyOnHand 0 — since QBO can only
// change QtyOnHand at create time or via an InventoryAdjustment, a plain
// re-sync can't fix it; this backfill posts the corrective adjustment.
//
// Run:
//   node --experimental-loader ./scripts/extensionless-loader.mjs --env-file-if-exists=.env scripts/backfill-retail-qbo-products.js            (dry-run)
//   node --experimental-loader ./scripts/extensionless-loader.mjs --env-file-if-exists=.env scripts/backfill-retail-qbo-products.js --apply    (write)
//
// Idempotent: re-running only posts an adjustment when QBO's QtyOnHand still
// differs from Shopify. Best-effort per product.

import mongoose from "mongoose";
import connectDB from "../app/db/mongo.server.js";
import { unauthenticated } from "../app/shopify.server.js";
import { syncRetailProductToQbo } from "../app/services/retailQbo/retailQboProductSync.service.js";

const APPLY = process.argv.includes("--apply");
// Optional --sku "VALUE" filter — process only products that have a variant
// with this SKU (handy for verifying/fixing a single product).
const skuArgIdx = process.argv.indexOf("--sku");
const SKU_FILTER = skuArgIdx !== -1 ? process.argv[skuArgIdx + 1] : null;
const shop = process.env.CDO_RETAIL_SHOP;

const PRODUCTS_QUERY = `
  query Products($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      edges {
        node {
          legacyResourceId
          title
          vendor
          status
          variants(first: 100) {
            edges {
              node {
                legacyResourceId
                title
                sku
                price
                inventoryQuantity
                inventoryItem { legacyResourceId }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function toRestProduct(node) {
  return {
    id: parseInt(node.legacyResourceId, 10),
    title: node.title,
    vendor: node.vendor ?? "",
    status: (node.status || "active").toLowerCase(),
    variants: (node.variants?.edges || []).map((e) => {
      const v = e.node;
      return {
        id: parseInt(v.legacyResourceId, 10),
        title: v.title,
        sku: v.sku ?? "",
        price: v.price,
        inventory_quantity: v.inventoryQuantity ?? 0,
        inventory_item_id: v.inventoryItem?.legacyResourceId
          ? parseInt(v.inventoryItem.legacyResourceId, 10)
          : null,
      };
    }),
  };
}

async function main() {
  if (!shop) throw new Error("CDO_RETAIL_SHOP is not set in .env");
  await connectDB();
  let admin;
  try {
    ({ admin } = await unauthenticated.admin(shop));
  } catch (err) {
    let status = err?.status ?? err?.response?.status;
    console.error(
      `[backfill] Could not get an Admin API client for ${shop} (status=${status ?? "?"}). ` +
        "This needs a VALID offline session/token for the retail shop in shopify_sessions — " +
        "run this from an environment where the app is installed + authenticated (e.g. after " +
        "'shopify app dev', or on the deployed server). NOTE: the ongoing quantity sync does NOT " +
        "need this — the inventory_levels/update + products webhooks reconcile QBO live inside the app; " +
        "this backfill is only for a one-time bulk correction of already-created items.",
    );
    throw err;
  }
  console.log(`[backfill] shop=${shop} mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  // Shopify Admin reads can return a transient 5xx; retry with backoff and
  // surface the response body so a real failure is legible (a raw thrown
  // Response otherwise prints as an opaque object).
  async function fetchProductsPage(after) {
    let lastErr;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const res = await admin.graphql(PRODUCTS_QUERY, { variables: { first: 50, after } });
        return await res.json();
      } catch (err) {
        lastErr = err;
        let status = err?.status;
        let body = "";
        if (typeof err?.text === "function") {
          try { body = await err.text(); } catch { /* ignore */ }
        } else if (err?.response && typeof err.response.text === "function") {
          status = err.response.status;
          try { body = await err.response.text(); } catch { /* ignore */ }
        }
        console.warn(`[backfill] products page fetch attempt ${attempt}/5 failed (status=${status ?? "?"}): ${(body || err?.message || String(err)).slice(0, 300)}`);
        if (status && status < 500 && status !== 429) break; // non-transient
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
    throw lastErr;
  }

  const products = [];
  let after = null;
  let hasNext = true;
  while (hasNext) {
    const json = await fetchProductsPage(after);
    const data = json?.data?.products;
    if (!data) throw new Error(`GraphQL returned no products: ${JSON.stringify(json).slice(0, 300)}`);
    for (const edge of data.edges || []) products.push(toRestProduct(edge.node));
    hasNext = data.pageInfo?.hasNextPage ?? false;
    after = data.pageInfo?.endCursor ?? null;
  }
  console.log(`[backfill] fetched ${products.length} products`);

  const selected = SKU_FILTER
    ? products.filter((p) => p.variants.some((v) => v.sku === SKU_FILTER))
    : products;
  if (SKU_FILTER) console.log(`[backfill] --sku "${SKU_FILTER}" → ${selected.length} matching product(s)`);

  const totals = { products: selected.length, variants: 0, withSku: 0, synced: 0, errored: 0, skipped: 0 };
  for (const p of selected) {
    for (const v of p.variants) {
      totals.variants++;
      if (v.sku) totals.withSku++;
    }
    if (!APPLY) {
      const skus = p.variants.filter((v) => v.sku).map((v) => `${v.sku}=${v.inventory_quantity}`);
      console.log(`[dry-run] product ${p.id} "${p.title}" → ${skus.length ? skus.join(", ") : "(no SKUs)"}`);
      continue;
    }
    const s = await syncRetailProductToQbo(p, { shop, event: "backfill" });
    totals.synced += s?.synced ?? 0;
    totals.errored += s?.errored ?? 0;
    totals.skipped += s?.skipped ?? 0;
    console.log(`[apply] product ${p.id} "${p.title}":`, s);
  }

  console.log("[backfill] done:", totals);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("[backfill] FATAL", e?.message || e);
  process.exit(1);
});
