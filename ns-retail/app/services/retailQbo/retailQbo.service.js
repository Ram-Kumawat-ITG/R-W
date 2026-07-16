// Retail QBO domain methods — the accounts-receivable ("money in") side:
// retail customer → QBO Customer, retail order → QBO Invoice, shipment
// tracking → invoice sync. All HTTP goes through retailQbo.apis.js (the
// retail realm). Independent of the CDO payouts service (services/qbo/*).

import { retailQbo, qboRetailRequest, qboRetailGetBinary } from "./retailQbo.apis";
import { retailQboConfig } from "./retailQbo.config";
import RetailQboProductMap from "../../models/retailQboProductMap.server";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("retail.qbo.service");

// QBO QL escapes a single quote inside a string literal with a backslash.
function escapeQuery(value) {
  return String(value ?? "").replace(/'/g, "\\'");
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// QBO date fields are date-only (YYYY-MM-DD).
function toQboDate(d) {
  if (!d) return undefined;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

// ── Customers ────────────────────────────────────────────────────────

// QBO Customer DisplayName must be unique across the customer list. We use
// the buyer's email as the DisplayName when present (stable + unique per
// person), falling back to their name. Find-or-create is idempotent: repeat
// orders from the same buyer resolve to the same Customer (no duplicates).
async function queryCustomerByDisplayName(displayName) {
  if (!displayName) return null;
  const res = await retailQbo.query(
    `SELECT * FROM Customer WHERE DisplayName = '${escapeQuery(displayName)}'`,
  );
  return res?.QueryResponse?.Customer?.[0] || null;
}

function mapQboAddr(a) {
  if (!a) return undefined;
  const line1 = a.line1 || a.address1;
  const out = {
    ...(line1 ? { Line1: String(line1) } : {}),
    ...(a.line2 || a.address2 ? { Line2: String(a.line2 || a.address2) } : {}),
    ...(a.city ? { City: String(a.city) } : {}),
    ...(a.province ? { CountrySubDivisionCode: String(a.province) } : {}),
    ...(a.zip ? { PostalCode: String(a.zip) } : {}),
    ...(a.country ? { Country: String(a.country) } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

export async function findOrCreateCustomer({
  email,
  firstName,
  lastName,
  name,
  phone,
  billingAddress,
  shippingAddress,
}) {
  const displayName = (email || name || "").trim();
  if (!displayName) {
    throw new Error("findOrCreateCustomer: an email or name is required");
  }

  // 1) Adopt an existing customer with this DisplayName.
  let customer = await queryCustomerByDisplayName(displayName);

  // 2) Otherwise create. A 6240 (duplicate name) means one already exists —
  //    adopt it.
  if (!customer) {
    const billAddr = mapQboAddr(billingAddress);
    const shipAddr = mapQboAddr(shippingAddress);
    const payload = {
      DisplayName: displayName.slice(0, 100),
      ...(firstName ? { GivenName: String(firstName).slice(0, 100) } : {}),
      ...(lastName ? { FamilyName: String(lastName).slice(0, 100) } : {}),
      ...(email ? { PrimaryEmailAddr: { Address: email } } : {}),
      ...(phone ? { PrimaryPhone: { FreeFormNumber: String(phone) } } : {}),
      ...(billAddr ? { BillAddr: billAddr } : {}),
      ...(shipAddr ? { ShipAddr: shipAddr } : {}),
    };
    try {
      const created = await retailQbo.post("/customer", payload);
      customer = created?.Customer || null;
    } catch (err) {
      const code = err?.body?.Fault?.Error?.[0]?.code;
      if (code === "6240" || /duplicate/i.test(err?.message || "")) {
        customer = await queryCustomerByDisplayName(displayName);
      }
      if (!customer) throw err;
    }
  }

  if (!customer?.Id) {
    throw new Error(`Retail QBO: failed to resolve a customer for "${displayName}"`);
  }
  log.info("customer.resolved", { displayName, qboCustomerId: customer.Id });
  return { id: String(customer.Id), displayName: customer.DisplayName || displayName };
}

// ── Sales item (single, per the locked decision) ─────────────────────

// Module-memoized so we resolve the income/sales item once per process.
let _salesItemId = null;

// Resolve the income account to attach a freshly-created Service item to:
// explicit override → reuse an existing item's income account → first Income
// account in the chart of accounts.
async function resolveIncomeAccountRef() {
  if (retailQboConfig.incomeAccountId) {
    return { value: String(retailQboConfig.incomeAccountId) };
  }
  const itemRes = await retailQbo.query(
    "SELECT * FROM Item WHERE Type = 'Service' MAXRESULTS 1",
  );
  const existing = itemRes?.QueryResponse?.Item?.[0];
  if (existing?.IncomeAccountRef?.value) {
    return { value: String(existing.IncomeAccountRef.value) };
  }
  const acctRes = await retailQbo.query(
    "SELECT Id, Name FROM Account WHERE AccountType = 'Income' MAXRESULTS 1",
  );
  const acct = acctRes?.QueryResponse?.Account?.[0];
  if (acct?.Id) return { value: String(acct.Id) };
  throw new Error(
    "Retail QBO: no Income account found to back the sales item. " +
      "Set QBO_RETAIL_INCOME_ACCOUNT_ID or QBO_RETAIL_ITEM_ID.",
  );
}

// Inventory-Asset + COGS account resolvers for Inventory-type Items. Env-
// pinned (QBO_RETAIL_INVENTORY_*) or auto-resolved from the retail realm's
// Chart of Accounts, preferring the standard-named account. Cached in-module:
// `undefined` = unresolved, `null` = none found.
let _assetAccountRef;
async function resolveInventoryAssetAccountRef() {
  if (_assetAccountRef !== undefined) return _assetAccountRef;
  if (retailQboConfig.inventoryAssetAccountId) {
    _assetAccountRef = { value: String(retailQboConfig.inventoryAssetAccountId) };
    return _assetAccountRef;
  }
  try {
    const res = await retailQbo.query(
      "SELECT * FROM Account WHERE AccountType = 'Other Current Asset' AND AccountSubType = 'Inventory'",
    );
    const accounts = res?.QueryResponse?.Account || [];
    const chosen = accounts.find((a) => /^inventory asset$/i.test(a.Name || "")) || accounts[0];
    _assetAccountRef = chosen?.Id ? { value: String(chosen.Id) } : null;
  } catch (err) {
    log.warn("retail.item.asset_account.lookup_failed", { err: err?.message || String(err) });
    _assetAccountRef = null;
  }
  return _assetAccountRef;
}

let _cogsAccountRef;
async function resolveCogsAccountRef() {
  if (_cogsAccountRef !== undefined) return _cogsAccountRef;
  if (retailQboConfig.inventoryCogsAccountId) {
    _cogsAccountRef = { value: String(retailQboConfig.inventoryCogsAccountId) };
    return _cogsAccountRef;
  }
  try {
    const res = await retailQbo.query(
      "SELECT * FROM Account WHERE AccountType = 'Cost of Goods Sold'",
    );
    const accounts = res?.QueryResponse?.Account || [];
    const chosen = accounts.find((a) => /^cost of goods sold$/i.test(a.Name || "")) || accounts[0];
    _cogsAccountRef = chosen?.Id ? { value: String(chosen.Id) } : null;
  } catch (err) {
    log.warn("retail.item.cogs_account.lookup_failed", { err: err?.message || String(err) });
    _cogsAccountRef = null;
  }
  return _cogsAccountRef;
}

// Income account for INVENTORY items specifically — QBO requires Detail Type
// 'Sales of Product Income' (Account Type Income). A generic service-fee
// income account is rejected on an Inventory create. Env-pinned or
// auto-resolved (preferring the standard-named "Sales of Product Income").
let _productIncomeRef;
async function resolveProductIncomeAccountRef() {
  if (_productIncomeRef !== undefined) return _productIncomeRef;
  if (retailQboConfig.productIncomeAccountId) {
    _productIncomeRef = { value: String(retailQboConfig.productIncomeAccountId) };
    return _productIncomeRef;
  }
  try {
    const res = await retailQbo.query(
      "SELECT * FROM Account WHERE AccountType = 'Income' AND AccountSubType = 'SalesOfProductIncome'",
    );
    const accounts = res?.QueryResponse?.Account || [];
    const chosen = accounts.find((a) => /^sales of product income$/i.test(a.Name || "")) || accounts[0];
    _productIncomeRef = chosen?.Id ? { value: String(chosen.Id) } : null;
  } catch (err) {
    log.warn("retail.item.product_income_account.lookup_failed", { err: err?.message || String(err) });
    _productIncomeRef = null;
  }
  return _productIncomeRef;
}

// Offset account for InventoryAdjustment posts. Env-pinned or auto-resolved,
// preferring an "Inventory Shrinkage"/adjustment account, else the COGS account.
let _adjustAccountRef;
async function resolveInventoryAdjustmentAccountRef() {
  if (_adjustAccountRef !== undefined) return _adjustAccountRef;
  if (retailQboConfig.inventoryAdjustmentAccountId) {
    _adjustAccountRef = { value: String(retailQboConfig.inventoryAdjustmentAccountId) };
    return _adjustAccountRef;
  }
  try {
    const res = await retailQbo.query("SELECT * FROM Account WHERE AccountType = 'Cost of Goods Sold'");
    const accounts = res?.QueryResponse?.Account || [];
    const chosen =
      accounts.find((a) => /shrinkage|adjust/i.test(a.Name || "")) ||
      accounts.find((a) => /^cost of goods sold$/i.test(a.Name || "")) ||
      accounts[0];
    _adjustAccountRef = chosen?.Id ? { value: String(chosen.Id) } : await resolveCogsAccountRef();
  } catch (err) {
    log.warn("retail.item.adjust_account.lookup_failed", { err: err?.message || String(err) });
    _adjustAccountRef = await resolveCogsAccountRef();
  }
  return _adjustAccountRef;
}

// QBO wants InvStartDate as a plain date (YYYY-MM-DD).
function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

// Post a QBO InventoryAdjustment to change an Inventory item's on-hand by a
// signed delta. This is the ONLY supported way to change QtyOnHand after an
// item is created — a plain item update silently ignores QtyOnHand. Throws on
// failure (caller records state). No-op when qtyDiff is 0.
export async function postRetailInventoryAdjustment({ itemId, qtyDiff }) {
  const diff = Number(qtyDiff);
  if (!itemId) throw new Error("postRetailInventoryAdjustment: itemId is required");
  if (!Number.isFinite(diff) || diff === 0) return { adjusted: false, reason: "no_diff" };
  const adjustRef = await resolveInventoryAdjustmentAccountRef();
  if (!adjustRef) throw new Error("postRetailInventoryAdjustment: no adjustment account available");
  const payload = {
    AdjustAccountRef: adjustRef,
    Line: [
      {
        DetailType: "ItemAdjustmentLineDetail",
        ItemAdjustmentLineDetail: {
          ItemRef: { value: String(itemId) },
          QtyDiff: diff,
        },
      },
    ],
  };
  const res = await retailQbo.post("/inventoryadjustment", payload);
  return { adjusted: true, id: res?.InventoryAdjustment?.Id || null, qtyDiff: diff };
}

// Reconcile a QBO Inventory item's on-hand TO an absolute target quantity
// (Shopify is authoritative). GETs the item, computes the delta, and posts a
// single corrective InventoryAdjustment. No-op when already matching or when
// the item isn't an Inventory type. Throws on a QBO failure.
export async function reconcileRetailItemInventory({ itemId, targetQty }) {
  const target = Number(targetQty);
  if (!itemId || !Number.isFinite(target)) return { adjusted: false, reason: "no_target" };
  const item = await getRetailItem(itemId);
  if (!item) return { adjusted: false, reason: "item_not_found" };
  if (String(item.Type) !== "Inventory") return { adjusted: false, reason: "not_inventory" };
  const current = Number(item.QtyOnHand ?? 0);
  const diff = target - current;
  if (diff === 0) return { adjusted: false, reason: "already_matches", qty: current };
  await postRetailInventoryAdjustment({ itemId, qtyDiff: diff });
  log.info("retail.item.qty_reconciled", { itemId: String(itemId), from: current, to: target, diff });
  return { adjusted: true, from: current, to: target, diff };
}

// Parse a Shopify price string ("9.99") to a Number, or null.
function priceToNumber(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Resolve the single QBO Item every retail invoice line posts to:
//   1. QBO_RETAIL_ITEM_ID override (verbatim)
//   2. an existing item named QBO_RETAIL_ITEM_NAME
//   3. any existing Service item (simplest — avoids a create + account lookup)
//   4. create the named Service item against a resolved Income account
export async function resolveSalesItemId() {
  if (_salesItemId) return _salesItemId;
  if (retailQboConfig.salesItemId) {
    _salesItemId = String(retailQboConfig.salesItemId);
    return _salesItemId;
  }

  const wantName = retailQboConfig.salesItemName;
  const byName = await retailQbo.query(
    `SELECT * FROM Item WHERE Name = '${escapeQuery(wantName)}'`,
  );
  const named = byName?.QueryResponse?.Item?.[0];
  if (named?.Id) {
    _salesItemId = String(named.Id);
    return _salesItemId;
  }

  const anyService = await retailQbo.query(
    "SELECT * FROM Item WHERE Type = 'Service' MAXRESULTS 1",
  );
  const svc = anyService?.QueryResponse?.Item?.[0];
  if (svc?.Id) {
    _salesItemId = String(svc.Id);
    return _salesItemId;
  }

  const incomeRef = await resolveIncomeAccountRef();
  const created = await retailQbo.post("/item", {
    Name: wantName,
    Type: "Service",
    IncomeAccountRef: incomeRef,
  });
  const item = created?.Item;
  if (!item?.Id) throw new Error("Retail QBO: failed to create the sales item");
  _salesItemId = String(item.Id);
  log.info("sales_item.created", { itemId: _salesItemId, name: wantName });
  return _salesItemId;
}

// ── Per-product Items (SKU column support) ───────────────────────────
//
// QBO populates the invoice's SKU column from the referenced Item's `Sku`
// field — there is no per-line SKU override. To surface the correct SKU on
// each line we resolve (find-or-create) a dedicated Service Item per SKU,
// keyed by the SKU value.  Everything is best-effort: a failed resolution
// falls back to the shared default item so invoicing never breaks.

// In-process cache: sku → qboItemId (reset on process restart, re-resolved
// via QBO query — idempotent so this is safe).
const _retailItemCache = new Map();

// QBO Item Name can't contain ':' and is capped at 100 chars. Pure sanitizer —
// no SKU appended (SKU has its own Item.Sku field/column). QBO also requires a
// unique Name; that's handled at create time by falling back to
// `uniqueRetailItemName` only on a genuine collision — see createRetailItem.
function sanitizeRetailItemName(name) {
  let full = String(name || "").replace(/:/g, "-").trim();
  if (!full) full = "Item";
  return full.length > 100 ? full.slice(0, 100).trim() : full;
}

// Collision fallback: append the SKU to disambiguate two different items that
// would otherwise share a Name. Trims the base so the SKU survives the cap.
function uniqueRetailItemName(name, sku) {
  const cleanSku = sku ? String(sku).replace(/:/g, "-").trim() : "";
  const suffix = cleanSku ? ` (${cleanSku})` : "";
  let base = String(name || "").replace(/:/g, "-").trim();
  const max = 100 - suffix.length;
  if (base.length > max) base = base.slice(0, Math.max(0, max)).trim();
  let full = `${base}${suffix}`.trim();
  if (!full) full = cleanSku ? `SKU ${cleanSku}` : "Item";
  return full.slice(0, 100);
}

async function findRetailItemBySku(sku) {
  if (!sku) return null;
  const res = await retailQbo.query(
    `SELECT * FROM Item WHERE Sku = '${escapeQuery(sku)}' MAXRESULTS 1`,
  );
  return res?.QueryResponse?.Item?.[0] || null;
}

async function findRetailItemByName(name) {
  if (!name) return null;
  const res = await retailQbo.query(
    `SELECT * FROM Item WHERE Name = '${escapeQuery(name)}' MAXRESULTS 1`,
  );
  return res?.QueryResponse?.Item?.[0] || null;
}

async function createRetailItem({ name, sku, description, price, qtyOnHand }) {
  const incomeRef = await resolveIncomeAccountRef();
  if (!incomeRef) throw new Error("createRetailItem: no IncomeAccountRef available");
  const Name = sanitizeRetailItemName(name);
  const payload = { Name, Sku: sku, Type: "Service", IncomeAccountRef: incomeRef };
  if (description) payload.Description = String(description).slice(0, 4000);
  const priceNum = priceToNumber(price);
  if (priceNum != null) payload.UnitPrice = priceNum;

  // Inventory type (QBO Plus/Advanced) — needs an Inventory-Asset account + a
  // COGS/expense account + TrackQtyOnHand/QtyOnHand/InvStartDate. If either
  // account can't be resolved we GRACEFULLY stay on Service type so item
  // creation (and therefore invoicing/sync) never breaks.
  if (retailQboConfig.inventoryTrackingEnabled) {
    const [assetRef, cogsRef, productIncomeRef] = await Promise.all([
      resolveInventoryAssetAccountRef(),
      resolveCogsAccountRef(),
      resolveProductIncomeAccountRef(),
    ]);
    if (assetRef && cogsRef && productIncomeRef) {
      const qty = Number.isFinite(Number(qtyOnHand)) ? Number(qtyOnHand) : 0;
      payload.Type = "Inventory";
      payload.TrackQtyOnHand = true;
      payload.QtyOnHand = qty;
      payload.InvStartDate = todayYmd();
      payload.AssetAccountRef = assetRef;
      payload.ExpenseAccountRef = cogsRef;
      // Inventory items require a 'Sales of Product Income' income account —
      // override the generic one resolved above (QBO rejects the create
      // otherwise; that's the whole reason for the dedicated resolver).
      payload.IncomeAccountRef = productIncomeRef;
    } else {
      log.warn("retail.item.inventory_fallback_service", {
        sku,
        reason: !assetRef
          ? "no_inventory_asset_account"
          : !cogsRef
            ? "no_cogs_account"
            : "no_product_income_account",
      });
    }
  }
  try {
    const res = await retailQbo.post("/item", payload);
    const created = res?.Item;
    if (!created?.Id) throw new Error("QBO retail item create returned no Id");
    return created;
  } catch (err) {
    if (/duplicate name|6240/i.test(err?.message || "")) {
      const existing = await findRetailItemByName(Name);
      // Same SKU → adopt (idempotent). Never adopt a different-SKU item.
      if (existing?.Id && String(existing.Sku || "") === String(sku || "")) {
        return existing;
      }
      // Different item owns this clean Name → retry once with a SKU-qualified
      // unique Name so both items can coexist (QBO requires unique Names).
      const retryName = uniqueRetailItemName(name, sku);
      if (retryName !== Name) {
        const retry = await retailQbo.post("/item", { ...payload, Name: retryName });
        const created = retry?.Item;
        if (created?.Id) return created;
      }
    }
    throw err;
  }
}

// Resolve a SKU to a QBO Item id: process cache → QBO query → create.
// Returns the id string, or null on any failure (caller falls back to
// the shared default item). `name` seeds the Item Name on first create.
async function findOrCreateRetailItemBySku({ sku, name }) {
  const clean = sku ? String(sku).trim() : "";
  if (!clean) return null;
  try {
    if (_retailItemCache.has(clean)) return _retailItemCache.get(clean);
    let item = await findRetailItemBySku(clean);
    if (!item) item = await createRetailItem({ name, sku: clean });
    const qboItemId = item?.Id ? String(item.Id) : null;
    if (qboItemId) _retailItemCache.set(clean, qboItemId);
    return qboItemId;
  } catch (err) {
    log.warn("retail.item.resolve_failed", { sku: clean, err: err?.message || String(err) });
    return null;
  }
}

// Resolve the retail QBO Item id for ONE invoice line, referencing the QBO
// Products & Services (Inventory) records maintained by the proactive retail
// product sync. Resolution order (mirrors the wholesale side, QBO product-sync
// plan §8):
//
//   1. retail_qbo_product_maps by shopifyVariantId — the DURABLE variant-keyed
//      mapping written by retailQboProductSync.service. Points at the QBO
//      Inventory Item created before any order existed, so each invoice line
//      references the real stock-tracked product (accurate sales/inventory
//      reporting). Keyed on the stable variant id (not SKU) so a SKU rename
//      never orphans the reference.
//   2. findOrCreateRetailItemBySku — the just-in-time SKU resolver (also warms
//      the in-process _retailItemCache) for lines the proactive sync hasn't
//      covered yet (delayed webhook / un-backfilled legacy product).
//   3. null — caller falls back to the shared default Item, unchanged.
//
// Best-effort throughout: any lookup failure degrades to the next tier.
async function resolveRetailInvoiceItemId({ shopifyVariantId, sku, name }) {
  const variantId = shopifyVariantId ? String(shopifyVariantId).trim() : "";
  if (variantId) {
    try {
      const row = await RetailQboProductMap.findOne({ shopifyVariantId: variantId })
        .select("qboItemId")
        .lean();
      if (row?.qboItemId) return String(row.qboItemId);
    } catch (err) {
      log.warn("retail.item.variant_map_lookup_failed", {
        shopifyVariantId: variantId,
        err: err?.message || String(err),
      });
    }
  }
  return findOrCreateRetailItemBySku({ sku, name });
}

// ── Proactive product sync (Products & Services) ─────────────────────
//
// Used by the Shopify → Retail-QBO product sync (retailQboProductSync
// .service.js). Creates or updates the retail QBO Item for one Shopify
// variant and returns the resolved id + SyncToken + action. Unlike
// `findOrCreateRetailItemBySku` (best-effort, returns null on error), this
// THROWS so the caller can record per-variant sync state + retry. It NEVER
// deletes or deactivates an Item — retail QBO product records are retained
// for historical reporting even after the Shopify product is archived/deleted.
// New Items are `Inventory` type when tracking is on (initial QtyOnHand seeded
// from the Shopify variant), else `Service`.
export async function getRetailItem(itemId) {
  const res = await retailQbo.get(`/item/${encodeURIComponent(itemId)}`);
  return res?.Item || null;
}

async function updateRetailItemSparse(existing, desired) {
  const changed = {};
  if (desired.Name && desired.Name !== existing.Name) changed.Name = desired.Name;
  if (desired.Sku != null && String(desired.Sku) !== String(existing.Sku || "")) {
    changed.Sku = desired.Sku;
  }
  if (desired.Description != null && desired.Description !== (existing.Description || "")) {
    changed.Description = desired.Description;
  }
  if (desired.UnitPrice != null && Number(desired.UnitPrice) !== Number(existing.UnitPrice ?? NaN)) {
    changed.UnitPrice = desired.UnitPrice;
  }
  if (Object.keys(changed).length === 0) return { item: existing, updated: false };
  const payload = {
    Id: String(existing.Id),
    SyncToken: String(existing.SyncToken),
    sparse: true,
    ...changed,
  };
  try {
    const res = await retailQbo.post("/item", payload);
    return { item: res?.Item || existing, updated: true };
  } catch (err) {
    // Name collision — retry without the Name change (keep the other fields).
    if (/duplicate name|6240/i.test(err?.message || "") && changed.Name) {
      const { Name, ...rest } = changed;
      void Name;
      if (Object.keys(rest).length === 0) return { item: existing, updated: false };
      const res = await retailQbo.post("/item", {
        Id: String(existing.Id),
        SyncToken: String(existing.SyncToken),
        sparse: true,
        ...rest,
      });
      return { item: res?.Item || existing, updated: true };
    }
    throw err;
  }
}

export async function upsertRetailQboItem({ sku, name, description, price, qtyOnHand }) {
  const clean = sku ? String(sku).trim() : "";
  if (!clean) throw new Error("upsertRetailQboItem: sku is required");

  const desired = {
    Name: sanitizeRetailItemName(name),
    Sku: clean,
    Description: description ? String(description).slice(0, 4000) : undefined,
    UnitPrice: priceToNumber(price) ?? undefined,
  };

  const existing = await findRetailItemBySku(clean);
  if (existing?.Id) {
    const { item, updated } = await updateRetailItemSparse(existing, desired);
    // Keep the invoice-time cache warm/consistent.
    _retailItemCache.set(clean, String(item.Id));
    // Reconcile on-hand quantity to Shopify's value. The sparse item update
    // above CANNOT change QtyOnHand — QBO only accepts it at create time or
    // via an InventoryAdjustment — so an item created earlier with QtyOnHand 0
    // (e.g. by the invoice-time path, or created before stock was loaded)
    // stays 0 until this corrective adjustment runs. Best-effort: a failure
    // here must not fail the item upsert.
    let qtyResult = null;
    if (retailQboConfig.inventoryTrackingEnabled && qtyOnHand != null && String(existing.Type) === "Inventory") {
      try {
        qtyResult = await reconcileRetailItemInventory({ itemId: existing.Id, targetQty: qtyOnHand });
      } catch (err) {
        log.warn("retail.item.qty_reconcile_failed", { sku: clean, err: err?.message || String(err) });
      }
    }
    return {
      qboItemId: String(item.Id),
      qboSyncToken: item.SyncToken != null ? String(item.SyncToken) : String(existing.SyncToken),
      qboItemName: item.Name || existing.Name,
      sku: item.Sku != null ? String(item.Sku) : clean,
      action: updated ? "updated" : "unchanged",
      qtyReconciled: qtyResult?.adjusted ? qtyResult : null,
    };
  }

  const created = await createRetailItem({ name, sku: clean, description, price, qtyOnHand });
  _retailItemCache.set(clean, String(created.Id));
  return {
    qboItemId: String(created.Id),
    qboSyncToken: created.SyncToken != null ? String(created.SyncToken) : "0",
    qboItemName: created.Name,
    sku: created.Sku != null ? String(created.Sku) : clean,
    action: "created",
  };
}

// ── Invoices ─────────────────────────────────────────────────────────

// Build the QBO Invoice payload from a cdo_orders snapshot. Every product +
// shipping line posts to either a per-SKU item (so the QBO SKU column
// populates) or the shared default item as a fallback. A DiscountLine applies
// order discounts, and a reconciling Adjustment line guarantees QBO TotalAmt
// equals the Shopify order total.
//
// `variantToItemId` / `skuToItemId` — Map<string, string> pre-resolved by
// createInvoiceForOrder. Each product line resolves to its QBO Item by variant
// id first (the durable retail_qbo_product_maps Inventory Item), then by SKU,
// then the shared default item.
function buildInvoiceLines({ order, itemId, skuToItemId = new Map(), variantToItemId = new Map() }) {
  const lines = [];
  let productSum = 0;
  for (const li of order.lineItems || []) {
    const qty = Number(li.quantity) || 0;
    const unit = round2(li.price);
    const amount = round2(qty * unit);
    productSum += amount;
    // SKU is used as the QBO Item key (→ populates the dedicated SKU column).
    // Use the raw stored value so the column display matches what's in the data.
    const rawSku = li.sku ? String(li.sku).trim() : null;
    const rawVariant = li.variantId ? String(li.variantId).trim() : null;
    const productPart = [li.title, li.variantTitle].filter(Boolean).join(" — ");
    // Format: "Product Name — Variant by Vendor" (mirrors wholesale formatLineDescription).
    // SKU goes to the dedicated QBO column; omit it from description.
    const desc = li.vendor ? `${productPart} by ${li.vendor}` : productPart;
    const lineItemId =
      (rawVariant && variantToItemId.get(rawVariant)) ||
      (rawSku && skuToItemId.get(rawSku)) ||
      itemId;
    lines.push({
      DetailType: "SalesItemLineDetail",
      Amount: amount,
      ...(desc ? { Description: desc.slice(0, 4000) } : {}),
      SalesItemLineDetail: {
        ItemRef: { value: lineItemId },
        Qty: qty,
        UnitPrice: unit,
        TaxCodeRef: { value: "NON" },
      },
    });
  }

  const p = order.pricing || {};
  const shipping = round2(p.totalShipping);
  if (shipping > 0) {
    lines.push({
      DetailType: "SalesItemLineDetail",
      Amount: shipping,
      Description: "Shipping",
      SalesItemLineDetail: {
        ItemRef: { value: itemId },
        Qty: 1,
        UnitPrice: shipping,
        TaxCodeRef: { value: "NON" },
      },
    });
  }

  const discount = round2(p.totalDiscounts);
  if (discount > 0) {
    lines.push({
      DetailType: "DiscountLineDetail",
      Amount: discount,
      DiscountLineDetail: { PercentBased: false },
    });
  }

  const tax = round2(p.totalTax);
  const expected = round2(order.amount ?? p.total);
  // QBO TotalAmt = sum(SalesItem lines) - discount + TxnTaxDetail.TotalTax.
  const computed = round2(productSum + shipping - discount + tax);
  const adjustment = round2(expected - computed);
  if (Math.abs(adjustment) > 0.005) {
    lines.push({
      DetailType: "SalesItemLineDetail",
      Amount: adjustment,
      Description: "Adjustment",
      SalesItemLineDetail: {
        ItemRef: { value: itemId },
        Qty: 1,
        UnitPrice: adjustment,
        TaxCodeRef: { value: "NON" },
      },
    });
  }

  return { lines, tax };
}

// Create the QBO Invoice for a cdo_orders snapshot. Idempotent at the QBO
// layer via `requestid` (a retry that committed server-side returns the
// original). Returns the created Invoice.
export async function createInvoiceForOrder({ order, customerId, itemId, requestId }) {
  if (!customerId) throw new Error("createInvoiceForOrder: customerId is required");
  if (!itemId) throw new Error("createInvoiceForOrder: itemId is required");

  // Pre-resolve each line to its QBO Products & Services (Inventory) Item so
  // invoice lines reference the real stock-tracked product (accurate sales /
  // inventory reporting in QBO) and the SKU column populates. Variant-id fast
  // path (durable retail_qbo_product_maps) → SKU JIT → default item. Best-
  // effort: a null result leaves the line on the shared default item.
  const variantToItemId = new Map();
  const skuToItemId = new Map();
  for (const li of order.lineItems || []) {
    const rawVariant = li.variantId ? String(li.variantId).trim() : null;
    const rawSku = li.sku ? String(li.sku).trim() : null;
    if (rawVariant) {
      if (variantToItemId.has(rawVariant)) continue;
      const qboItemId = await resolveRetailInvoiceItemId({
        shopifyVariantId: rawVariant,
        sku: rawSku,
        name: li.title || undefined,
      });
      if (qboItemId) variantToItemId.set(rawVariant, qboItemId);
    } else if (rawSku) {
      if (skuToItemId.has(rawSku)) continue;
      const qboItemId = await findOrCreateRetailItemBySku({ sku: rawSku, name: li.title || undefined });
      if (qboItemId) skuToItemId.set(rawSku, qboItemId);
    }
  }

  const { lines, tax } = buildInvoiceLines({ order, itemId, skuToItemId, variantToItemId });
  if (lines.length === 0) {
    throw new Error("createInvoiceForOrder: order has no line items to invoice");
  }

  const email = order.customerEmail || order.customer?.email || null;
  const invoiceDocNumber = order.orderName || String(order.shopifyOrderId || "").split("/").pop() || "";
  const payload = {
    CustomerRef: { value: String(customerId) },
    Line: lines,
    ...(tax > 0 ? { TxnTaxDetail: { TotalTax: tax } } : {}),
    ...(order.placedAt ? { TxnDate: toQboDate(order.placedAt) } : {}),
    ...(email ? { BillEmail: { Address: email } } : {}),
    CustomerMemo: {
      value: `Retail order ${order.orderName || order.shopifyOrderId || ""}`.trim().slice(0, 1000),
    },
    ...(order.currency ? { CurrencyRef: { value: order.currency } } : {}),
    ...(invoiceDocNumber ? { DocNumber: String(invoiceDocNumber).slice(0, 21) } : {}),
  };

  // QBO caps requestid at 50 chars; order.shopifyOrderId is the full GID, so
  // fall back to its short numeric tail (stable + unique per order).
  const shortOrderId = String(order.shopifyOrderId || "").split("/").pop() || "x";
  const res = await retailQbo.post("/invoice", payload, undefined, {
    requestId: (requestId || `retail-inv-${shortOrderId}`).slice(0, 50),
  });
  const invoice = res?.Invoice;
  if (!invoice?.Id) throw new Error("createInvoiceForOrder: QBO did not return an Invoice id");
  log.info("invoice.created", {
    shopifyOrderId: order.shopifyOrderId,
    invoiceId: invoice.Id,
    docNumber: invoice.DocNumber,
    total: invoice.TotalAmt,
  });
  return invoice;
}

export async function getInvoice(invoiceId) {
  const res = await retailQbo.get(`/invoice/${invoiceId}`);
  return res?.Invoice || null;
}

// ── Payments (mark an invoice Paid) ──────────────────────────────────

// Create a QBO Payment that fully applies to one invoice, so QBO shows the
// invoice Paid (Balance → 0). Idempotent at the QBO layer via `requestid`.
// `amount` should equal the invoice's current Balance. `paymentRefNum` carries
// the Shopify payment reference (QBO caps it at 21 chars). Returns the Payment.
export async function createPaymentForInvoice({
  customerId,
  invoiceId,
  amount,
  txnDate,
  paymentRefNum,
  currency,
  privateNote,
  requestId,
}) {
  if (!customerId) throw new Error("createPaymentForInvoice: customerId is required");
  if (!invoiceId) throw new Error("createPaymentForInvoice: invoiceId is required");
  const total = round2(amount);
  if (!(total > 0)) {
    throw new Error(`createPaymentForInvoice: amount must be > 0 (got ${amount})`);
  }

  const payload = {
    CustomerRef: { value: String(customerId) },
    TotalAmt: total,
    ...(txnDate ? { TxnDate: toQboDate(txnDate) } : {}),
    ...(paymentRefNum ? { PaymentRefNum: String(paymentRefNum).slice(0, 21) } : {}),
    ...(currency ? { CurrencyRef: { value: currency } } : {}),
    ...(retailQboConfig.depositAccountId
      ? { DepositToAccountRef: { value: String(retailQboConfig.depositAccountId) } }
      : {}),
    ...(privateNote ? { PrivateNote: String(privateNote).slice(0, 4000) } : {}),
    Line: [
      {
        Amount: total,
        LinkedTxn: [{ TxnId: String(invoiceId), TxnType: "Invoice" }],
      },
    ],
  };

  const res = await retailQbo.post("/payment", payload, undefined, {
    requestId: (requestId || `retail-pay-${invoiceId}`).slice(0, 50),
  });
  const payment = res?.Payment;
  if (!payment?.Id) {
    throw new Error("createPaymentForInvoice: QBO did not return a Payment id");
  }
  log.info("payment.created", {
    invoiceId,
    paymentId: payment.Id,
    total: payment.TotalAmt,
    paymentRefNum: payment.PaymentRefNum,
  });
  return payment;
}

// Deep link for the admin UI so operators can open the payment in QBO.
export function paymentWebUrl(paymentId) {
  return `${retailQboConfig.appBaseUrl}/app/recvpayment?txnId=${paymentId}`;
}

// Mirror shipment carrier + tracking + ship date onto the QBO invoice via a
// sparse update. Re-fetches the invoice first for a fresh SyncToken so we
// never collide on a stale token. Returns the updated Invoice (carries the
// new SyncToken).
export async function syncInvoiceShipping({ invoiceId, shipDate, trackingNum, memo }) {
  const current = await getInvoice(invoiceId);
  if (!current?.Id) throw new Error(`syncInvoiceShipping: invoice ${invoiceId} not found`);

  const payload = {
    Id: String(current.Id),
    SyncToken: current.SyncToken,
    sparse: true,
    ...(shipDate ? { ShipDate: toQboDate(shipDate) } : {}),
    ...(trackingNum ? { TrackingNum: String(trackingNum).slice(0, 31) } : {}),
    ...(memo ? { CustomerMemo: { value: String(memo).slice(0, 1000) } } : {}),
  };

  const res = await retailQbo.update("/invoice", payload);
  const updated = res?.Invoice;
  if (!updated?.Id) throw new Error("syncInvoiceShipping: QBO did not return the updated Invoice");
  log.info("invoice.shipping_synced", { invoiceId, trackingNum, shipDate });
  return updated;
}

// Email the invoice to the customer via QBO's send endpoint. `email` (when
// provided) overrides the invoice's BillEmail as the recipient. QBO flips the
// invoice's EmailStatus to "EmailSent". Used both right after creation (invoice
// delivery) and after a shipping update (shipment notification — the memo by
// then carries the carrier + tracking + URL + status). Returns the Invoice.
export async function sendInvoice({ invoiceId, email }) {
  if (!invoiceId) throw new Error("sendInvoice: invoiceId is required");
  const res = await qboRetailRequest({
    method: "POST",
    path: `/invoice/${invoiceId}/send`,
    query: email ? { sendTo: email } : undefined,
    // QBO's /send endpoint takes no JSON body; octet-stream is the documented
    // content type for the empty-body send.
    contentType: "application/octet-stream",
  });
  const invoice = res?.Invoice || null;
  log.info("invoice.sent", { invoiceId, email, emailStatus: invoice?.EmailStatus });
  return invoice;
}

// Fetch the rendered invoice PDF straight from QBO. Used by the admin
// "Preview invoice" action — we hold the OAuth token, the admin doesn't.
// Returns { buffer, contentType }.
export async function getInvoicePdf(invoiceId) {
  if (!invoiceId) throw new Error("getInvoicePdf: invoiceId is required");
  return qboRetailGetBinary(`/invoice/${encodeURIComponent(invoiceId)}/pdf`, {
    accept: "application/pdf",
  });
}

export async function getBillPdf(billId) {
  if (!billId) throw new Error("getBillPdf: billId is required");
  return qboRetailGetBinary(`/bill/${encodeURIComponent(billId)}/pdf`, {
    accept: "application/pdf",
  });
}

// Deep link for the admin UI so operators can open the invoice in QBO.
export function invoiceWebUrl(invoiceId) {
  return `${retailQboConfig.appBaseUrl}/app/invoice?txnId=${invoiceId}`;
}

// ── Vendor Bills (A/P "money out" — dropship cost) ───────────────────
//
// The accounts-PAYABLE counterpart to the customer Invoice above, posted to
// the SAME retail company. Each dropship order records what the retail store
// owes the wholesale supplier ("Natural Solution Wholesale") as an UNPAID QBO
// Bill, mirroring the wholesale invoice for the same order. Orchestrated by
// retailVendorBill.service.js. The customer-invoice (A/R) path is untouched.

// Vendor lookup helpers (mirror the CDO payout client's, but on the retail
// realm). QBO returns ACTIVE entities by default; a deactivated vendor is
// found via a second `Active = false` query. The GET /vendor/{id} read 610s on
// an inactive vendor, so we always look up via query.
async function queryOneVendor(whereClause) {
  let res = await retailQbo.query(`SELECT * FROM Vendor WHERE ${whereClause}`);
  let v = res?.QueryResponse?.Vendor?.[0];
  if (v) return v;
  res = await retailQbo.query(`SELECT * FROM Vendor WHERE ${whereClause} AND Active = false`);
  return res?.QueryResponse?.Vendor?.[0] || null;
}

async function queryVendorByDisplayName(displayName) {
  if (!displayName) return null;
  return queryOneVendor(`DisplayName = '${escapeQuery(displayName)}'`);
}

// QBO QL can't filter Vendor by the complex PrimaryEmailAddr field, so fetch
// and match client-side (active then inactive).
async function queryVendorByEmail(email) {
  if (!email) return null;
  const target = String(email).toLowerCase();
  const match = (list) =>
    list.find((v) => (v.PrimaryEmailAddr?.Address || "").toLowerCase() === target);
  let res = await retailQbo.query("SELECT * FROM Vendor MAXRESULTS 1000");
  let v = match(res?.QueryResponse?.Vendor || []);
  if (v) return v;
  res = await retailQbo.query("SELECT * FROM Vendor WHERE Active = false MAXRESULTS 1000");
  return match(res?.QueryResponse?.Vendor || []) || null;
}

// A Bill can't post to an inactive vendor — flip it back to Active via a sparse
// update. Idempotent on an already-active vendor.
async function reactivateVendor(vendor) {
  const res = await retailQbo.update("/vendor", {
    Id: String(vendor.Id),
    SyncToken: vendor.SyncToken,
    Active: true,
    sparse: true,
  });
  return res?.Vendor || vendor;
}

// Module-memoized so we resolve the wholesale-supplier vendor once per process.
let _dropshipVendorId = null;

// Resolve the QBO Vendor id the dropship bills post to:
//   1. configured id (QBO_RETAIL_DROPSHIP_VENDOR_ID / QBO_RETAIL_ADMIN_VENDOR) — verbatim
//   2. adopt an existing vendor by email / DisplayName (incl. inactive)
//   3. create it under the configured name + email
// Returns the vendor id as a string.
export async function resolveDropshipVendorId() {
  if (_dropshipVendorId) return _dropshipVendorId;

  if (retailQboConfig.dropshipVendorId) {
    _dropshipVendorId = String(retailQboConfig.dropshipVendorId);
    return _dropshipVendorId;
  }

  const name = retailQboConfig.dropshipVendorName;
  const email = retailQboConfig.dropshipVendorEmail;

  let vendor =
    (await queryVendorByEmail(email)) || (await queryVendorByDisplayName(name));

  if (!vendor) {
    const payload = {
      DisplayName: String(name).slice(0, 100),
      ...(email ? { PrimaryEmailAddr: { Address: email } } : {}),
    };
    try {
      const created = await retailQbo.post("/vendor", payload);
      vendor = created?.Vendor || null;
    } catch (err) {
      const code = err?.body?.Fault?.Error?.[0]?.code;
      if (code === "6240" || /duplicate/i.test(err?.message || "")) {
        vendor = await queryVendorByDisplayName(name);
      }
      if (!vendor) throw err;
    }
  }

  if (!vendor?.Id) {
    throw new Error(`Retail QBO: failed to resolve the dropship vendor "${name}"`);
  }
  if (vendor.Active === false) vendor = await reactivateVendor(vendor);

  _dropshipVendorId = String(vendor.Id);
  log.info("dropship_vendor.resolved", { qboVendorId: _dropshipVendorId, name });
  return _dropshipVendorId;
}

// Module-memoized expense account for the bill lines.
let _dropshipExpenseAccountId = null;

// Resolve the expense/COGS account each bill line posts to:
//   1. QBO_RETAIL_DROPSHIP_EXPENSE_ACCOUNT_ID override (verbatim)
//   2. first "Cost of Goods Sold" account in the chart of accounts
//   3. first "Expense" account
export async function resolveDropshipExpenseAccountId() {
  if (_dropshipExpenseAccountId) return _dropshipExpenseAccountId;
  if (retailQboConfig.dropshipExpenseAccountId) {
    _dropshipExpenseAccountId = String(retailQboConfig.dropshipExpenseAccountId);
    return _dropshipExpenseAccountId;
  }

  const cogs = await retailQbo.query(
    "SELECT Id, Name FROM Account WHERE AccountType = 'Cost of Goods Sold' MAXRESULTS 1",
  );
  const cogsAcct = cogs?.QueryResponse?.Account?.[0];
  if (cogsAcct?.Id) {
    _dropshipExpenseAccountId = String(cogsAcct.Id);
    return _dropshipExpenseAccountId;
  }

  const exp = await retailQbo.query(
    "SELECT Id, Name FROM Account WHERE AccountType = 'Expense' MAXRESULTS 1",
  );
  const expAcct = exp?.QueryResponse?.Account?.[0];
  if (expAcct?.Id) {
    _dropshipExpenseAccountId = String(expAcct.Id);
    return _dropshipExpenseAccountId;
  }

  throw new Error(
    "Retail QBO: no Cost of Goods Sold / Expense account found for the dropship bill. " +
      "Set QBO_RETAIL_DROPSHIP_EXPENSE_ACCOUNT_ID.",
  );
}

// The retail order's shipping cost mirrored onto the bill (the wholesale draft
// order copies retail's FIRST shipping line at full cost — match that).
function firstShippingPrice(order) {
  const lines = Array.isArray(order?.shippingLines) ? order.shippingLines : [];
  if (lines.length) return round2(lines[0]?.price);
  return round2(order?.pricing?.totalShipping);
}

// Build the QBO Bill payload from a cdo_orders snapshot, mirroring the wholesale
// dropship invoice: one AccountBasedExpenseLine per product at the actual
// WHOLESALE product price + an optional Shipping line at full retail cost.
// Idempotent at the QBO layer via `requestid`. Returns the created Bill.
//
// Per-line unit pricing precedence (keeps the bill in sync with the wholesale
// invoice, which prices from the same source):
//   1. wholesalePriceByVariantId — the actual wholesale Shopify variant price
//      (sync_id_maps.wholesalePrice), keyed by the line's retail variant id.
//   2. retail BASE unit price × priceFactor — graceful fallback when a
//      variant's wholesale price snapshot isn't populated (legacy ½ behavior).
// Discounts are ignored in both cases (matching the wholesale base formula).
export async function createBillForOrder({
  order,
  vendorId,
  expenseAccountId,
  apAccountId,
  priceFactor = 0.5,
  wholesalePriceByVariantId,
  includeShipping = true,
  requestId,
}) {
  if (!vendorId) throw new Error("createBillForOrder: vendorId is required");
  if (!expenseAccountId) throw new Error("createBillForOrder: expenseAccountId is required");

  const factor = Number.isFinite(Number(priceFactor)) ? Number(priceFactor) : 0.5;
  const wsPrices =
    wholesalePriceByVariantId instanceof Map ? wholesalePriceByVariantId : new Map();
  const expenseRef = { value: String(expenseAccountId) };
  const lines = [];

  for (const li of order.lineItems || []) {
    const qty = Number(li.quantity) || 0;
    // Prefer the actual wholesale product price; fall back to retail × factor.
    const mapped = li.variantId != null ? wsPrices.get(String(li.variantId)) : undefined;
    const unit =
      Number.isFinite(mapped) && mapped > 0
        ? round2(mapped)
        : round2((Number(li.price) || 0) * factor);
    const amount = round2(unit * qty);
    if (!(amount > 0)) continue;
    const productPart = [li.title, li.variantTitle].filter(Boolean).join(" — ");
    const titleParts = li.vendor ? `${productPart} by ${li.vendor}` : productPart;
    const desc = [titleParts, `${qty} × ${unit.toFixed(2)} (wholesale)`]
      .filter(Boolean)
      .join("\n");
    lines.push({
      DetailType: "AccountBasedExpenseLineDetail",
      Amount: amount,
      ...(desc ? { Description: desc.slice(0, 4000) } : {}),
      AccountBasedExpenseLineDetail: { AccountRef: expenseRef },
    });
  }

  if (includeShipping) {
    const shipping = firstShippingPrice(order);
    if (shipping > 0) {
      lines.push({
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: shipping,
        Description: "Shipping",
        AccountBasedExpenseLineDetail: { AccountRef: expenseRef },
      });
    }
  }

  if (lines.length === 0) {
    throw new Error("createBillForOrder: order has no billable lines");
  }

  const orderRef = order.orderName || order.shopifyOrderId || "";
  const payload = {
    VendorRef: { value: String(vendorId) },
    Line: lines,
    ...(apAccountId ? { APAccountRef: { value: String(apAccountId) } } : {}),
    ...(order.placedAt ? { TxnDate: toQboDate(order.placedAt) } : {}),
    // Vendor's reference for the bill — RS-<retail order number> for traceability
    // and to match the corresponding wholesale Admin Order Invoice (RS-#1234).
    ...(orderRef ? { DocNumber: `RS-${orderRef}`.slice(0, 21) } : {}),
    PrivateNote: `Dropship cost — retail order ${orderRef} → ${retailQboConfig.dropshipVendorName}`
      .trim()
      .slice(0, 4000),
    ...(order.currency ? { CurrencyRef: { value: order.currency } } : {}),
  };

  const shortOrderId = String(order.shopifyOrderId || "").split("/").pop() || "x";
  const res = await retailQbo.post("/bill", payload, undefined, {
    requestId: (requestId || `retail-bill-${shortOrderId}`).slice(0, 50),
  });
  const bill = res?.Bill;
  if (!bill?.Id) throw new Error("createBillForOrder: QBO did not return a Bill id");
  log.info("bill.created", {
    shopifyOrderId: order.shopifyOrderId,
    billId: bill.Id,
    docNumber: bill.DocNumber,
    total: bill.TotalAmt,
  });
  return bill;
}

export async function getBill(billId) {
  const res = await retailQbo.get(`/bill/${billId}`);
  return res?.Bill || null;
}

// Record a BillPayment that fully applies to one vendor Bill, so QBO shows the
// bill Paid (Balance → 0) — the A/P counterpart to createPaymentForInvoice.
// Drawn from the configured bank/clearing account (PayType "Check" is QBO's
// representation of a bank-account disbursement; this RECORDS the payment in
// the ledger — it does not itself move money). `amount` should equal the bill's
// current Balance. Idempotent at the QBO layer via `requestid`. Returns the
// created BillPayment.
export async function createBillPaymentForBill({
  vendorId,
  billId,
  amount,
  txnDate,
  currency,
  privateNote,
  requestId,
}) {
  if (!vendorId) throw new Error("createBillPaymentForBill: vendorId is required");
  if (!billId) throw new Error("createBillPaymentForBill: billId is required");
  if (!retailQboConfig.paymentAccountId) {
    throw new Error(
      "createBillPaymentForBill: QBO_RETAIL_PAYMENT_ACCOUNT_ID is not set — " +
        "cannot record the bill payment without a bank/clearing account.",
    );
  }
  const total = round2(amount);
  if (!(total > 0)) {
    throw new Error(`createBillPaymentForBill: amount must be > 0 (got ${amount})`);
  }

  const payload = {
    VendorRef: { value: String(vendorId) },
    TotalAmt: total,
    PayType: "Check",
    CheckPayment: { BankAccountRef: { value: String(retailQboConfig.paymentAccountId) } },
    ...(txnDate ? { TxnDate: toQboDate(txnDate) } : {}),
    ...(currency ? { CurrencyRef: { value: currency } } : {}),
    ...(privateNote ? { PrivateNote: String(privateNote).slice(0, 4000) } : {}),
    Line: [
      {
        Amount: total,
        LinkedTxn: [{ TxnId: String(billId), TxnType: "Bill" }],
      },
    ],
  };

  const res = await retailQbo.post("/billpayment", payload, undefined, {
    requestId: (requestId || `retail-billpay-${billId}`).slice(0, 50),
  });
  const payment = res?.BillPayment;
  if (!payment?.Id) {
    throw new Error("createBillPaymentForBill: QBO did not return a BillPayment id");
  }
  log.info("billpayment.created", { vendorId, billId, billPaymentId: payment.Id, total });
  return payment;
}

// Deep link for the admin UI so operators can open the bill in QBO.
export function billWebUrl(billId) {
  return `${retailQboConfig.appBaseUrl}/app/bill?txnId=${billId}`;
}

// Deep link to a bill payment in QBO.
export function billPaymentWebUrl(billPaymentId) {
  return `${retailQboConfig.appBaseUrl}/app/billpayment?txnId=${billPaymentId}`;
}

// ── Analytics query helpers ──────────────────────────────────────

const ANALYTICS_MAX_PAGE_SIZE = 200;
const ANALYTICS_DEFAULT_PAGE_SIZE = 50;

async function runListQuery(ql, startPosition = 1, maxResults = ANALYTICS_DEFAULT_PAGE_SIZE) {
  const resp = await retailQbo.query(
    `${ql} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`,
  );
  if (!resp?.QueryResponse) return [];
  return Object.values(resp.QueryResponse)
    .flat()
    .filter((v) => v && typeof v === "object");
}

async function runCountQuery(entityAndWhere) {
  const resp = await retailQbo.query(`SELECT COUNT(*) FROM ${entityAndWhere}`);
  return resp?.QueryResponse?.totalCount ?? 0;
}

export async function listCustomers({
  search = "",
  status = "all",
  page = 1,
  pageSize = ANALYTICS_DEFAULT_PAGE_SIZE,
} = {}) {
  const predicates = [];
  if (status === "active") predicates.push("Active = true");
  if (status === "inactive") predicates.push("Active = false");
  if (search) {
    const v = escapeQuery(search);
    predicates.push(
      `(DisplayName LIKE '%${v}%' OR CompanyName LIKE '%${v}%' OR PrimaryEmailAddr LIKE '%${v}%')`,
    );
  }
  const where = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
  const ql = `SELECT * FROM Customer${where} ORDERBY DisplayName`;
  const startPos = (page - 1) * pageSize + 1;
  return runListQuery(ql, startPos, pageSize);
}

export async function countCustomers({ search = "", status = "all" } = {}) {
  const predicates = [];
  if (status === "active") predicates.push("Active = true");
  if (status === "inactive") predicates.push("Active = false");
  if (search) {
    const v = escapeQuery(search);
    predicates.push(
      `(DisplayName LIKE '%${v}%' OR CompanyName LIKE '%${v}%' OR PrimaryEmailAddr LIKE '%${v}%')`,
    );
  }
  const where = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
  return runCountQuery(`Customer${where}`);
}

export async function listInvoices({
  search = "",
  status = "all",
  dateFrom = "",
  dateTo = "",
  customerId = "",
  page = 1,
  pageSize = ANALYTICS_DEFAULT_PAGE_SIZE,
} = {}) {
  const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
  const todayYmd = new Date().toISOString().slice(0, 10);
  const predicates = [];
  if (status === "paid") predicates.push("Balance = '0' AND TotalAmt > '0'");
  else if (status === "pending") predicates.push("Balance > '0'");
  else if (status === "overdue")
    predicates.push(`Balance > '0' AND DueDate < '${todayYmd}'`);
  else if (status === "voided") predicates.push("TotalAmt = '0'");
  if (customerId) predicates.push(`CustomerRef = '${escapeQuery(customerId)}'`);
  if (YMD_RE.test(dateFrom)) predicates.push(`TxnDate >= '${dateFrom}'`);
  if (YMD_RE.test(dateTo)) predicates.push(`TxnDate <= '${dateTo}'`);
  if (search) {
    const v = escapeQuery(search);
    predicates.push(`DocNumber LIKE '%${v}%'`);
  }
  const where = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
  const ql = `SELECT * FROM Invoice${where} ORDERBY TxnDate DESC`;
  const startPos = (page - 1) * pageSize + 1;
  return runListQuery(ql, startPos, pageSize);
}

export async function countInvoices({
  search = "",
  status = "all",
  dateFrom = "",
  dateTo = "",
  customerId = "",
} = {}) {
  const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
  const todayYmd = new Date().toISOString().slice(0, 10);
  const predicates = [];
  if (status === "paid") predicates.push("Balance = '0' AND TotalAmt > '0'");
  else if (status === "pending") predicates.push("Balance > '0'");
  else if (status === "overdue")
    predicates.push(`Balance > '0' AND DueDate < '${todayYmd}'`);
  else if (status === "voided") predicates.push("TotalAmt = '0'");
  if (customerId) predicates.push(`CustomerRef = '${escapeQuery(customerId)}'`);
  if (YMD_RE.test(dateFrom)) predicates.push(`TxnDate >= '${dateFrom}'`);
  if (YMD_RE.test(dateTo)) predicates.push(`TxnDate <= '${dateTo}'`);
  if (search) {
    const v = escapeQuery(search);
    predicates.push(`DocNumber LIKE '%${v}%'`);
  }
  const where = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
  return runCountQuery(`Invoice${where}`);
}

export async function listPayments({
  search = "",
  dateFrom = "",
  dateTo = "",
  customerId = "",
  page = 1,
  pageSize = ANALYTICS_DEFAULT_PAGE_SIZE,
} = {}) {
  const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
  const predicates = [];
  if (customerId) predicates.push(`CustomerRef = '${escapeQuery(customerId)}'`);
  if (YMD_RE.test(dateFrom)) predicates.push(`TxnDate >= '${dateFrom}'`);
  if (YMD_RE.test(dateTo)) predicates.push(`TxnDate <= '${dateTo}'`);
  if (search) {
    const v = escapeQuery(search);
    predicates.push(`PaymentRefNum LIKE '%${v}%'`);
  }
  const where = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
  const ql = `SELECT * FROM Payment${where} ORDERBY TxnDate DESC`;
  const startPos = (page - 1) * pageSize + 1;
  return runListQuery(ql, startPos, pageSize);
}

export async function countPayments({ search = "", dateFrom = "", dateTo = "", customerId = "" } = {}) {
  const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
  const predicates = [];
  if (customerId) predicates.push(`CustomerRef = '${escapeQuery(customerId)}'`);
  if (YMD_RE.test(dateFrom)) predicates.push(`TxnDate >= '${dateFrom}'`);
  if (YMD_RE.test(dateTo)) predicates.push(`TxnDate <= '${dateTo}'`);
  if (search) {
    const v = escapeQuery(search);
    predicates.push(`PaymentRefNum LIKE '%${v}%'`);
  }
  const where = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
  return runCountQuery(`Payment${where}`);
}

export async function listVendors() {
  const res = await retailQbo.query(
    "SELECT * FROM Vendor ORDERBY DisplayName MAXRESULTS 1000",
  );
  return res?.QueryResponse?.Vendor || [];
}

export async function listBills({
  search = "",
  status = "all",
  dateFrom = "",
  dateTo = "",
  vendorId = "",
  page = 1,
  pageSize = ANALYTICS_DEFAULT_PAGE_SIZE,
} = {}) {
  const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
  const todayYmd = new Date().toISOString().slice(0, 10);
  const predicates = [];
  if (status === "paid") predicates.push("Balance = '0' AND TotalAmt > '0'");
  else if (status === "open") predicates.push("Balance > '0'");
  else if (status === "overdue")
    predicates.push(`Balance > '0' AND DueDate < '${todayYmd}'`);
  else if (status === "voided") predicates.push("TotalAmt = '0'");
  if (vendorId) predicates.push(`VendorRef = '${escapeQuery(vendorId)}'`);
  if (YMD_RE.test(dateFrom)) predicates.push(`TxnDate >= '${dateFrom}'`);
  if (YMD_RE.test(dateTo)) predicates.push(`TxnDate <= '${dateTo}'`);
  if (search) {
    const v = escapeQuery(search);
    predicates.push(`DocNumber LIKE '%${v}%'`);
  }
  const where = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
  const ql = `SELECT * FROM Bill${where} ORDERBY TxnDate DESC`;
  const startPos = (page - 1) * pageSize + 1;
  return runListQuery(ql, startPos, pageSize);
}

export async function countBills({
  search = "",
  status = "all",
  dateFrom = "",
  dateTo = "",
  vendorId = "",
} = {}) {
  const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
  const todayYmd = new Date().toISOString().slice(0, 10);
  const predicates = [];
  if (status === "paid") predicates.push("Balance = '0' AND TotalAmt > '0'");
  else if (status === "open") predicates.push("Balance > '0'");
  else if (status === "overdue")
    predicates.push(`Balance > '0' AND DueDate < '${todayYmd}'`);
  else if (status === "voided") predicates.push("TotalAmt = '0'");
  if (vendorId) predicates.push(`VendorRef = '${escapeQuery(vendorId)}'`);
  if (YMD_RE.test(dateFrom)) predicates.push(`TxnDate >= '${dateFrom}'`);
  if (YMD_RE.test(dateTo)) predicates.push(`TxnDate <= '${dateTo}'`);
  if (search) {
    const v = escapeQuery(search);
    predicates.push(`DocNumber LIKE '%${v}%'`);
  }
  const where = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
  return runCountQuery(`Bill${where}`);
}

export async function getBillCountSnapshot() {
  const todayYmd = new Date().toISOString().slice(0, 10);
  const safe = async (fn) => {
    try { return await fn(); } catch { return null; }
  };

  const [total, paid, open, overdue, recentRaw] = await Promise.all([
    safe(() => runCountQuery("Bill")),
    safe(() => runCountQuery("Bill WHERE Balance = '0' AND TotalAmt > '0'")),
    safe(() => runCountQuery("Bill WHERE Balance > '0'")),
    safe(() => runCountQuery(`Bill WHERE Balance > '0' AND DueDate < '${todayYmd}'`)),
    safe(() => runListQuery(
      "SELECT * FROM Bill ORDERBY TxnDate DESC",
      1,
      ANALYTICS_MAX_PAGE_SIZE,
    )),
  ]);

  let totalBilled = 0;
  let totalOutstanding = 0;
  let currency = "USD";
  if (recentRaw) {
    for (const b of recentRaw) {
      totalBilled += Number(b.TotalAmt || 0);
      totalOutstanding += Number(b.Balance || 0);
      if (b.CurrencyRef?.value) currency = b.CurrencyRef.value;
    }
  }

  const billCount = recentRaw?.length ?? 0;
  return {
    total: total ?? 0,
    paid: paid ?? 0,
    open: open ?? 0,
    overdue: overdue ?? 0,
    totalBilled,
    totalOutstanding,
    currency,
    billCount,
    truncated: billCount >= ANALYTICS_MAX_PAGE_SIZE,
    recentBills: (recentRaw ?? []).slice(0, 10),
  };
}

export async function getDashboardSnapshot() {
  const safe = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      console.error(`[retailQbo/dashboard] ${label} failed:`, e?.message || e);
      return null;
    }
  };

  const todayYmd = new Date().toISOString().slice(0, 10);

  const [
    customers,
    activeCustomers,
    invoices,
    paidInvoices,
    pendingInvoices,
    overdueInvoices,
    recentPaymentsRaw,
    recentInvoicesRaw,
    billedRaw,
  ] = await Promise.all([
    safe("customers", () => runCountQuery("Customer")),
    safe("activeCustomers", () => runCountQuery("Customer WHERE Active = true")),
    safe("invoices", () => runCountQuery("Invoice")),
    safe("paidInvoices", () =>
      runCountQuery("Invoice WHERE Balance = '0' AND TotalAmt > '0'"),
    ),
    safe("pendingInvoices", () => runCountQuery("Invoice WHERE Balance > '0'")),
    safe("overdueInvoices", () =>
      runCountQuery(`Invoice WHERE Balance > '0' AND DueDate < '${todayYmd}'`),
    ),
    safe("recentPayments", () =>
      runListQuery("SELECT * FROM Payment ORDERBY TxnDate DESC", 1, 10),
    ),
    safe("recentInvoices", () =>
      runListQuery("SELECT * FROM Invoice ORDERBY TxnDate DESC", 1, 10),
    ),
    safe("billedRaw", () =>
      runListQuery(
        "SELECT * FROM Invoice WHERE TotalAmt > '0' ORDERBY TxnDate DESC",
        1,
        ANALYTICS_MAX_PAGE_SIZE,
      ),
    ),
  ]);

  let billed = 0;
  let collected = 0;
  let sampledInvoiceCount = 0;
  let truncated = false;
  let currency = "USD";
  if (billedRaw) {
    sampledInvoiceCount = billedRaw.length;
    truncated = billedRaw.length >= ANALYTICS_MAX_PAGE_SIZE;
    for (const inv of billedRaw) {
      const total = Number(inv.TotalAmt || 0);
      const balance = Number(inv.Balance || 0);
      billed += total;
      collected += total - balance;
      if (inv.CurrencyRef?.value) currency = inv.CurrencyRef.value;
    }
  }

  const errors = [
    customers == null && "customers",
    activeCustomers == null && "activeCustomers",
    invoices == null && "invoices",
    paidInvoices == null && "paidInvoices",
    pendingInvoices == null && "pendingInvoices",
    overdueInvoices == null && "overdueInvoices",
    recentPaymentsRaw == null && "recentPayments",
    recentInvoicesRaw == null && "recentInvoices",
    billedRaw == null && "revenue",
  ].filter(Boolean);

  return {
    counts: {
      customers: customers ?? 0,
      activeCustomers: activeCustomers ?? 0,
      invoices: invoices ?? 0,
      paidInvoices: paidInvoices ?? 0,
      pendingInvoices: pendingInvoices ?? 0,
      overdueInvoices: overdueInvoices ?? 0,
    },
    revenue: {
      billed,
      collected,
      periodLabel: truncated
        ? `Last ${ANALYTICS_MAX_PAGE_SIZE} invoices`
        : "All invoices",
      sampledInvoiceCount,
      truncated,
      currency,
    },
    recentPayments: recentPaymentsRaw ?? [],
    recentInvoices: recentInvoicesRaw ?? [],
    errors,
    asOf: new Date().toISOString(),
  };
}
