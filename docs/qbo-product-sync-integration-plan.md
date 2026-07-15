# Shopify → QBO Products & Services + Inventory Sync — Integration Plan

Status: **Products & Services sync IMPLEMENTED in BOTH repos (2026-07-15).**
The catalog-sync + Inventory-type-item portions of this plan are live in
`wholesale/` (services/qbo/qboProductSync.service.js, `qbo_product_maps`) and
`ns-retail/` (services/retailQbo/retailQboProductSync.service.js,
`retail_qbo_product_maps` — a DISTINCT collection since both apps share one
MongoDB). Each syncs ONLY its own Shopify store → its own QBO realm. New QBO
Items are created as `Inventory` type (TrackQtyOnHand + QtyOnHand + InvStartDate
+ Asset/COGS/Income accounts) with a graceful fallback to `Service` when the
inventory accounts can't be resolved. Products are NEVER deleted/deactivated in
QBO (retention). **Still deferred (not built):** ongoing quantity PUSH via
`InventoryAdjustment` on `inventory_levels/update` (§7 — QBO can't PATCH
QtyOnHand after create), the reconciliation CRON + admin visibility tab (§9/§11
Phase 5; a `retryFailed*QboProductSyncs()` reconciliation function exists in
each repo but isn't yet wired to a scheduled job or UI), and Item Categories
for vendor analytics (§3.4). The rest of this document is the original DRAFT
plan and remains the reference for those deferred pieces.

This document covers both Shopify app workspaces in this
monorepo — `wholesale/` (customer invoices) and `ns-retail/` (`retailQbo`,
retail A/R invoices) — since both independently create QBO invoices today
and both need this capability.

## 1. Current state (what already exists, and the gap)

Both repos already create a per-product QBO **Item** and reference it on
invoice lines — but only enough to show a SKU column, not to track
inventory:

| | `wholesale/app/services/qbo/qbo.service.js` | `ns-retail/app/services/retailQbo/retailQbo.service.js` |
|---|---|---|
| Find-or-create | `findOrCreateItemBySku` (L138-170) | `findOrCreateRetailItemBySku` |
| Item `Type` created | **`'Service'`** always (L114) | **`'Service'`** always |
| Inventory fields set | none (no `QtyOnHand`, `TrackQtyOnHand`, `InvStartDate`, `AssetAccountRef`) | none |
| Mapping cache | Mongo `qbo_item_maps` (`models/qboItemMap.server.js`) — keyed by **SKU only**, no Shopify product/variant id | in-process `Map`, not persisted, keyed by SKU |
| Invoice line resolution | `shopifyLinesToQboLines` → `createInvoice` loops lines, resolves `l.qboItemId`, falls back to `qboConfig.defaultItemId` when unresolved (`qbo.utils.js` `toInvoiceLine`) | `buildInvoiceLines({ order, itemId, skuToItemId })` — same per-line fallback shape |
| Sync trigger | **On-demand only**, at invoice-creation time (no Shopify `products/*` webhook drives it) | same — on-demand only |

**The gap this plan closes:**
1. Items are never `Inventory` type, so QBO has no stock/quantity record —
   "accurate inventory tracking" (the stated goal) does not exist today.
2. There is no proactive product sync — an Item is only created the first
   time an order needs it, which is fine for invoicing (best-effort
   fallback already handles this gracefully) but wrong for inventory,
   which needs to exist and be correct **before** any sale.
3. The mapping cache is keyed by SKU, not by a stable Shopify id — a SKU
   rename orphans the mapping (a new row gets created, the old QBO Item
   becomes untracked).
4. Neither repo has a `products/*` or `inventory_levels/*` webhook wired to
   QBO at all (wholesale has them, but only driving the **existing,
   unrelated** wholesale→retail Shopify product mirror in
   `services/sync/product.sync.js` / `inventory.sync.js` — a completely
   separate pipeline this plan does not touch).

There **is** a directly reusable architectural precedent already proven in
this codebase: `wholesale/app/services/sync/` — `idMap.model.js`
(`sync_id_maps`, one row per Shopify entity, price/qty snapshots) +
`product.sync.js` (webhook-driven create/update/delete, SKU-based variant
pairing) + `inventory.sync.js` (quantity delta detection). The QBO product
sync should follow the same shape, pointed at QBO instead of a second
Shopify store.

## 2. Open questions (please confirm before implementation starts)

1. **Which store(s) need this?** Wholesale invoices, ns-retail retail
   invoices, or both? (The plan below is written to apply to both
   symmetrically, matching how the existing Item code is already
   duplicated between the two repos.)
2. **Confirm the QBO subscription plan supports inventory tracking.**
   `Item.Type = 'Inventory'` + `QtyOnHand`/`TrackQtyOnHand` requires
   **QuickBooks Online Plus or Advanced** — it does not exist on Simple
   Start/Essentials. Nothing in either `.env` currently indicates the plan
   tier. If the account is on a lower tier, this plan's inventory piece
   (§4) cannot be built until the plan is upgraded — Items would stay
   `Service`/`NonInventory` type and only §2/§3/§5 (mapping, sync,
   invoicing) would apply.
3. **Does QBO need multi-location inventory**, mirroring Shopify's
   multi-location stock, or is one company-wide quantity enough? (QBO Plus
   inventory is single-location by design; Advanced supports multiple
   inventory sites.) Recommendation below assumes **one aggregate quantity**
   (sum across Shopify locations) unless told otherwise.
4. **Which Shopify locations count toward the synced quantity** — all of
   them, or only a specific fulfillment location (e.g. excluding a
   drop-ship/virtual location that never physically stocks product)?
5. **COGS / Asset account.** Creating an `Inventory` Item requires an
   `AssetAccountRef` (Inventory Asset account) and an `ExpenseAccountRef`
   (COGS account) in addition to the existing `IncomeAccountRef` — which
   Chart-of-Accounts accounts should these be? (Mirrors how
   `QBO_RETAIL_COMMISSION_EXPENSE_ACCOUNT_ID` etc. are already
   env-configured per `docs/payout.md`'s appendix in ns-retail.)
6. **Initial on-hand quantity for products that predate this feature** —
   should the very first sync set `QtyOnHand` from Shopify's current stock
   (a real backfill, §7), or start every existing product at 0 and let it
   drift correct only from that point forward? Backfill is recommended.

## 3. Target architecture

```
Shopify (source of truth for catalog + stock)
  │
  ├─ products/create ──┐
  ├─ products/update ──┼──▶ webhooks.qbo-products.{create,update,delete}.jsx (NEW)
  ├─ products/delete ──┘         │  (mirrors webhooks.products.update.jsx's shape:
  │                              │   authenticate.webhook → gate on config →
  ├─ inventory_levels/update ────┼──▶ connectDB → fire-and-forget → 200)
  │                              ▼
  │                    services/qboProductSync/qboProductSync.service.js (NEW)
  │                              │
  │                              ├─ resolves/creates the QBO Item (Inventory type)
  │                              ├─ upserts qbo_product_maps (NEW model)
  │                              └─ on inventory_levels/update: posts an
  │                                 InventoryAdjustment (delta, not absolute set)
  │                              │
  ▼                              ▼
cdo_orders / ShopifyOrder   QuickBooks Online
  (existing order pipeline)      │
       │                         ├─ Item entity (Type: Inventory)
       │  at invoice creation    │    QtyOnHand, IncomeAccountRef,
       ▼                         │    AssetAccountRef, ExpenseAccountRef
createInvoice / createInvoiceForOrder
  (EXISTING — extended, not replaced)
       │
       └─ resolveItemForLine(shopifyVariantId, sku) ──▶ qbo_product_maps
              (was: findOrCreateItemBySku(sku) directly — now reads the
               proactively-synced mapping first, falls back to the existing
               just-in-time SKU resolution only if the proactive sync missed it)
```

Key design decision: **one-way sync, Shopify → QBO, always.** QBO is never
the source of truth for price or stock and nothing is ever written back
from QBO to Shopify. This matches the existing wholesale→retail product
mirror's direction convention and avoids any risk of this new pipeline
fighting with that unrelated, already-shipped one over the same Shopify
webhooks.

## 4. Product synchronization (Shopify → QBO)

New webhook routes (one pair per repo, following
`webhooks.products.update.jsx`'s exact shape — auth, config gate, connect,
fire-and-forget, 200):

- `webhooks.qbo-products.create.jsx` → `qboProductSync.service.syncProductCreate(payload)`
- `webhooks.qbo-products.update.jsx` → `syncProductUpdate(payload)`
- `webhooks.qbo-products.delete.jsx` → `syncProductDelete(payload)`
- `webhooks.qbo-inventory-levels.update.jsx` → `syncInventoryLevel(payload)`

(Named `qbo-products.*` / `qbo-inventory-levels.*`, distinct from
wholesale's existing `products.*`/`inventory_levels.*` routes, since a shop
can only have one webhook per topic per app — if wholesale's existing
product-mirror webhooks already claim those topics for the SAME shop, the
new QBO sync logic should be called from **inside** the existing handlers
instead of registering a second webhook subscription for the same topic.
This must be checked against the live webhook subscriptions before
implementation — see §9 Phase 0.)

`syncProductCreate(product)`:
1. For each variant, resolve `sku` (skip + log a warning if blank — QBO
   Items need a distinguishing identifier, mirroring
   `pairVariantsBySku`'s existing "no SKU, skip" precedent).
2. `findOrCreateInventoryItem({ shopifyProductId, shopifyVariantId, sku, name, vendor, qty })`
   (§5) — creates the QBO Item **proactively**, not at invoice time.
3. Upsert one `qbo_product_maps` row per variant (§7).

`syncProductUpdate(product)`: same variant loop, but only pushes an
`Item` update to QBO when a synced field actually changed (name, sku,
active/archived state, income account) — an update-if-changed guard, not an
unconditional POST on every webhook, since QBO's `SparseUpdate` requires
the current `SyncToken` and an unnecessary write risks a race against a
concurrent invoice-time resolution.

`syncProductDelete(product)`: see §6 — never hard-deletes the QBO Item.

`syncInventoryLevel(payload)`: see §5 — posts an `InventoryAdjustment`
delta.

## 5. Product mapping strategy (Shopify Product/Variant ↔ QBO Item)

- **Granularity: one QBO Item per Shopify *variant*, not per product** —
  matches what already happens today (Items are resolved by variant SKU).
  A product with 3 variants (e.g. sizes) becomes 3 QBO Items, each with its
  own SKU, stock, and price — this is required for accurate per-variant
  inventory tracking (QBO has no concept of a parent "product" with
  child-variant stock).
- **Primary key: `shopifyVariantId` (the Shopify GID), not SKU.** This is
  the one structural change from the existing `qbo_item_maps` pattern,
  and it's the fix for the SKU-rename-orphans-the-mapping gap in §1. SKU is
  still stored (and still what QBO's `Item.Sku` carries, for the invoice
  SKU column), but the **lookup key** for "does this Shopify variant
  already have a QBO Item" becomes the variant id, which never changes for
  the life of the variant even if its SKU is edited.
- **Product-level fields** (`vendor`, product title) are still snapshotted
  per-variant-row for convenience (avoids a join back to a Shopify products
  collection at invoice time), mirroring how `sync_id_maps` already
  snapshots price per variant row rather than normalizing into a separate
  products table.
- **No-SKU variants**: skip proactive sync (log + skip, same precedent as
  `pairVariantsBySku`); invoice creation keeps falling back to the existing
  shared default Item for these lines, exactly as it does today.

## 6. Handling product updates, new, archived, and deleted products

| Shopify event | QBO action |
|---|---|
| `products/create` | Create Item(s) proactively (§4), `Active: true` |
| `products/update` — name/vendor/sku changed | Sparse-update the Item's `Name`/`Sku` (re-run `sanitizeItemName`); re-key nothing (variant id is stable) |
| `products/update` — status → `archived`/`draft` | Set the QBO Item `Active: false`. **Never delete.** QBO hard-rejects deleting an Item referenced by any existing transaction (invoice line), and even unreferenced items are conventionally archived, not deleted, for audit trail. |
| `products/delete` | Same as archived: `Active: false`. Historical invoices keep referencing the now-inactive Item — QBO explicitly supports invoices with inactive-item lines; only NEW invoice lines can't select an inactive item, which is correct (you can't sell a deleted Shopify product). |
| Variant deleted from an existing product (not full product delete) | Same archive treatment, applied to that one Item only. |
| Re-activating a previously archived Shopify product | Sparse-update `Active: true` back on the matching Item(s) — do NOT create a new Item (would orphan the historical stock/COGS trail). |

## 7. Inventory management and stock synchronization

Contingent on §2 open question #2 (QBO plan tier). If confirmed available:

- **Item creation** (`Type: 'Inventory'`) requires, in addition to today's
  `IncomeAccountRef`: `AssetAccountRef` (Inventory Asset account),
  `ExpenseAccountRef` (COGS account), `TrackQtyOnHand: true`,
  `QtyOnHand` (initial count), `InvStartDate` (as-of date for that count —
  use "today" for a first-sync backfill, see §9 Phase 3).
- **Ongoing quantity changes**: QBO's Item entity does **not** support
  directly PATCHing `QtyOnHand` after creation (updating it via a plain
  Item update is undefined/unsupported behavior in QBO's API) — the correct
  QBO entity for adjusting on-hand quantity post-creation is
  **`InventoryAdjustment`** (`POST /inventoryadjustment`), which this
  codebase does not have a helper for yet (confirmed — neither `qbo.apis.js`
  exposes one). It needs: `AccountRef` (the Inventory Asset account),
  and one `InventoryAdjustmentLine` per Item with `Line.ItemRef` +
  `Line.QtyDiff` (the delta) or `Line.NewQty` (absolute). **Use `QtyDiff`,
  not `NewQty`** — Shopify's `inventory_levels/update` webhook payload
  already gives an absolute new `available`, so the handler computes
  `delta = newAvailable - lastKnownAvailable` (exactly the pattern
  `inventory.sync.js`'s existing delta-detection already uses for the
  Shopify→Shopify mirror) and posts that delta — this avoids a race where
  two near-simultaneous webhooks both try to "set" an absolute value and
  the loser's write is silently lost; deltas compose correctly even when
  applied out of order.
- **One-way, Shopify is authoritative.** No QBO→Shopify stock write-back.
  If QBO's on-hand count ever drifts from Shopify's (e.g. a manual QBO
  adjustment by an accountant), a periodic reconciliation job (§8) should
  detect and correct it FROM Shopify, or at minimum alert an admin — it
  should never silently let a manual QBO edit persist against reality.
- **Multi-location**: aggregate all Shopify locations' `available` into
  one QBO on-hand number by default (§2 open question #3/#4 pending
  confirmation) — sum on every `inventory_levels/update`, since Shopify's
  webhook payload is per-location and QBO Plus has no per-location
  breakdown to mirror into anyway.

## 8. Invoice creation using QBO Products & Services

Both `createInvoice` (wholesale) and `createInvoiceForOrder` (ns-retail
`retailQbo`) already resolve a per-line Item before building `Line[]` —
this plan **extends, not replaces** that resolution:

```
resolveItemForLine(shopifyLineItem):
  1. Look up qbo_product_maps by shopifyVariantId (fast path — the
     proactive sync already created this Item before any order existed)
  2. If missed (e.g. a webhook was delayed, or the product predates this
     feature and hasn't been backfilled yet) — fall back to the EXISTING
     findOrCreateItemBySku(sku) just-in-time resolution, unchanged, so
     invoicing never blocks or fails on a sync gap
  3. If still unresolved (no SKU either) — fall back to the existing
     shared default Item, unchanged
```

This preserves the current "invoicing never breaks" guarantee (explicitly
called out in the existing code's comments) while making the common case
(product already proactively synced) a single indexed Mongo lookup instead
of a live QBO query-by-SKU on every invoice.

No change to how `Line[]` amounts/quantities are built — the invoice line's
`Qty`/`UnitPrice`/`Amount` continue to come from the Shopify order (the
actual sale price at time of purchase), never from the QBO Item's own
`UnitPrice` field (which QBO Items technically carry but this integration
does not rely on — Shopify pricing remains authoritative for what the
customer is actually charged, exactly as today).

## 9. Error handling, retries, and synchronization failures

Reuse everything already proven in this codebase rather than build new
mechanisms:

- **Transport**: no new HTTP client needed — `qbo.post('/item', ...)` /
  `qbo.post('/inventoryadjustment', ...)` go through the existing
  `qbo.apis.js` (`retry()` with transient/permanent classification, the
  QBO idempotency `requestId` already threaded through every call).
- **Never block the webhook response.** Every new webhook route follows
  the existing fire-and-forget shape (`webhooks.products.update.jsx`'s
  exact pattern, §4) — the 200 is returned immediately; the sync work
  happens after, logged on success/failure, never retried inline.
- **Sync-state tracking, per row** (new fields on `qbo_product_maps`, §7):
  `syncStatus` (`synced` \| `pending` \| `error`), `lastSyncedAt`,
  `lastSyncError`, `syncAttemptCount`. Mirrors the existing
  `cdo_orders.retailQbo.{billSyncStatus,billSyncError,billLastAttemptAt}`
  pattern already used for vendor-bill sync in ns-retail.
- **Reconciliation CRON** (new, one per repo, following the existing
  Agenda job pattern e.g. `services/scheduler/jobs/processWholesaleFulfillmentReconcile.job.js`):
  sweeps `qbo_product_maps` rows where `syncStatus != 'synced'` or
  `lastSyncedAt` is older than N hours, and retries. This is the pull-based
  backstop for the same reason the existing fulfillment reconciler exists —
  a webhook can be missed (tunnel down in dev, a dropped delivery in prod)
  and nothing else would ever notice or retry it.
- **Admin visibility**: a simple list view (new, e.g. under a "QBO Product
  Sync" tab) showing `qbo_product_maps` rows with a non-`synced` status, so
  an admin can see and manually re-trigger a failed sync — mirrors the
  existing "Payout Batches" / batch-detail admin pattern already used
  elsewhere in ns-retail for exactly this kind of operational visibility.
- **Idempotency**: `(shop, shopifyVariantId)` unique index on
  `qbo_product_maps` (see §7's schema) prevents a duplicate row from two
  overlapping webhook deliveries; the QBO-side `findItemBySku`-before-create
  check (already existing) plus the request-id idempotency key together
  prevent a duplicate Item being created in QBO itself.

## 10. Data mapping strategy and required database changes

New Mongo model, **one per repo** (matching the existing pattern of
independent, duplicated QBO service code rather than a shared package,
since `wholesale/` and `ns-retail/` are separate npm workspaces with no
shared `node_modules`):

```js
// qboProductMap.server.js — collection: qbo_product_maps
{
  shop: String,                    // indexed
  shopifyProductId: String,        // gid://shopify/Product/<id>
  shopifyVariantId: String,        // gid://shopify/ProductVariant/<id> — PRIMARY KEY
  sku: String,                     // current SKU (display + QBO Item.Sku)
  vendor: String,                  // snapshot, for reporting
  productTitle: String,            // snapshot
  variantTitle: String,            // snapshot (e.g. "Large / Blue")

  qboItemId: String,               // QBO Item.Id
  qboItemType: String,             // 'Inventory' | 'Service' | 'NonInventory'
  qboSyncToken: String,            // last-known SyncToken, for sparse updates
  active: { type: Boolean, default: true },  // mirrors Shopify archived/deleted state

  // Inventory (only populated when qboItemType === 'Inventory')
  lastKnownShopifyAvailable: Number,  // sum across locations, for delta computation
  lastKnownQboQtyOnHand: Number,      // best-effort mirror of QBO's count

  // Price snapshot (informational / drift-detection only — never drives
  // invoice pricing, which always comes from the live Shopify order)
  shopifyPrice: Number,

  // Sync-state audit (§8)
  syncStatus: { type: String, enum: ['synced','pending','error'], default: 'pending' },
  lastSyncedAt: Date,
  lastSyncError: String,
  syncAttemptCount: { type: Number, default: 0 },
}
// unique index: (shop, shopifyVariantId)
// index: (shop, sku) — for the just-in-time fallback path (§8 step 2)
// index: (shop, syncStatus) — for the reconciliation CRON (§9)
```

Existing models this **reads but does not modify**:
`qboItemMap.server.js` (wholesale) stays as-is for backward compatibility
with the existing SKU-only fallback path (§8 step 2 explicitly still uses
`findOrCreateItemBySku`, which is backed by that model) — it is not
replaced, only supplemented.

No schema changes to `cdo_orders`, `cdo_commissions`, `ShopifyOrder`, or
`Invoice` — this feature is entirely upstream of invoice creation (it only
changes *how a Line's ItemRef is resolved*, not the invoice/order schemas
themselves).

## 11. Implementation plan

### Phase 0 — Verify webhook topic availability (spike, ~0.5 day)

Before writing any sync code: check each shop's currently-registered
webhook subscriptions (Shopify Admin → Settings → Notifications, or
`webhookSubscriptions` GraphQL query) for `products/create`,
`products/update`, `products/delete`, `inventory_levels/update`. Wholesale
already declares these for its own Shopify→Shopify mirror
(`services/sync/product.sync.js`) — **a shop can only have one webhook
subscription per topic per app**, so if wholesale's app already owns these
topics for the wholesale shop, the new QBO sync logic must be called
**from inside** the existing `webhooks.products.*.jsx` /
`webhooks.inventory_levels.update.jsx` handlers (as an additional
fire-and-forget call alongside the existing `syncProductCreate` etc.),
not as new separate webhook registrations. For ns-retail, confirm whether
any product/inventory webhooks are already registered for the retail shop
by any other feature before assuming a clean slate.

### Phase 1 — Item creation upgraded to support `Inventory` type (config-gated)

- Add `QBO_INVENTORY_TRACKING_ENABLED` (bool, default false) +
  `QBO_INVENTORY_ASSET_ACCOUNT_ID` + `QBO_INVENTORY_COGS_ACCOUNT_ID` env
  vars, per repo.
- Extend `createItem`/`createRetailItem` (existing functions) to build an
  `Inventory`-type payload (`TrackQtyOnHand`, `QtyOnHand`, `InvStartDate`,
  `AssetAccountRef`, `ExpenseAccountRef`) when the flag is on, otherwise
  keep today's exact `Service`-type payload unchanged — so this ships
  safely behind a flag with zero behavior change until enabled.
- New `qbo.service.postInventoryAdjustment({ itemId, qtyDiff, accountId })`
  helper (§5) — first use of the `InventoryAdjustment` endpoint in either
  repo.

### Phase 2 — `qbo_product_maps` model + sync service

- New model (§10), new `services/qboProductSync/qboProductSync.service.js`
  with `syncProductCreate/Update/Delete` + `syncInventoryLevel`, built by
  directly adapting `product.sync.js`'s variant-loop shape (§1) but calling
  `findOrCreateInventoryItem` (Phase 1) instead of `retailClient.post`.

### Phase 3 — Webhook wiring (per Phase 0's finding) + one-time backfill

- Wire the new sync calls into the existing (or new) webhook routes.
- One-off backfill script (`scripts/backfill-qbo-product-sync.js`,
  `--dry-run` supported, following the existing script conventions in both
  repos e.g. `scripts/backfill-cron-batch-item-amounts.js`): page through
  all active Shopify products via Admin GraphQL, run each through
  `syncProductCreate`-equivalent logic, so every pre-existing product gets
  a QBO Item + an accurate initial `QtyOnHand` (§2 open question #6) before
  the webhooks start carrying it forward incrementally.

### Phase 4 — Invoice-creation integration

- Extend the existing per-line item resolution (§8) in both
  `qbo.service.createInvoice`/`invoice.utils.shopifyLinesToQboLines`
  (wholesale) and `retailQbo.service.createInvoiceForOrder`/
  `buildInvoiceLines` (ns-retail) to check `qbo_product_maps` by
  `shopifyVariantId` first, falling back to the existing SKU-based
  `findOrCreateItemBySku` path unchanged.

### Phase 5 — Reconciliation CRON + admin visibility

- New Agenda job (per repo) sweeping non-`synced` rows (§9).
- New admin list route showing sync status, with a manual "Retry sync"
  action per row.

### APIs used (all via the existing `qbo.apis.js` transport, no new SDK)

| Operation | QBO endpoint |
|---|---|
| Find Item by SKU | `GET /query?query=SELECT * FROM Item WHERE Sku='...'` (existing) |
| Create/update Item | `POST /item`, sparse `POST /item` with `sparse:true` + `SyncToken` (existing pattern, extended payload) |
| Adjust on-hand quantity | `POST /inventoryadjustment` (**new** to this codebase) |
| Shopify product/variant read (backfill) | Admin GraphQL `products`/`productVariants` connection (existing GraphQL client in both repos) |
| Shopify webhooks consumed | `products/create`, `products/update`, `products/delete`, `inventory_levels/update` (topics already used elsewhere in wholesale; new to ns-retail) |

### Recommended development approach

1. Build and test Phase 1 (Item `Inventory` type) against a QBO **sandbox**
   company first, manually, before any webhook wiring — confirm the
   Chart-of-Accounts ids (§2 Q5) actually accept an Inventory Item create
   and that `InventoryAdjustment` behaves as expected (test both a
   positive and negative `QtyDiff`).
2. Ship Phases 2-3 behind the `QBO_INVENTORY_TRACKING_ENABLED` flag,
   defaulting off in production, so it can be toggled on for one shop/repo
   at a time once verified in dev/sandbox.
3. Run the backfill (Phase 3) in `--dry-run` first and manually spot-check
   a sample of products' resulting `QtyOnHand` against Shopify before
   running for real.
4. Only wire Phase 4 (invoice integration) after Phases 1-3 have been
   running clean (no `syncStatus:'error'` backlog) for a full order cycle,
   so the fast-path lookup has real data to hit rather than falling
   through to the slow-path on every invoice during initial rollout.
5. Ship Phase 5 (reconciliation + admin visibility) alongside Phase 4, not
   after — operational visibility should exist from day one of this
   feature being live, not bolted on once a problem is already reported.
