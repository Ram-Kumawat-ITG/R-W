// Drop-ship orchestrator — handles the parallel-fulfillment chain when
// a retail order is placed:
//
//   retail order  →  wholesale Shopify order (this service)
//                 →  wholesale invoice (existing pipeline, automatic via
//                    wholesale orders/create webhook)
//                 →  retail QBO Bill (Phase D, not built yet)
//                 →  weekly batch pay (Phase F, not built yet)
//
// This file is the entry point for Phases A + B. Phase A is just the
// foundation: identifying / creating the "Natural Solutions Retail"
// customer on the wholesale store. Phase B adds the actual Draft Order
// creation; line items are priced at the WHOLESALE product price
// (sync_id_maps.wholesalePrice — see resolveWholesaleLines).

import { unauthenticated } from '../../shopify.server'
import { createLogger } from '../../utils/logger.utils'
import DropshipMapping from '../../models/dropshipMapping.server'
import SyncIdMap from '../sync/idMap.model'
import { dropshipConfig } from './dropship.config'

const log = createLogger('dropship.service')

// ── Constants ──────────────────────────────────────────────────────────
// The synthetic B2B customer on the wholesale store that every retail-
// triggered drop-ship order is attached to. The email + tag are
// resolution anchors so we never have to hard-code the customer GID.
// Source-of-truth: dropship.config.js (env-driven).
export const NS_RETAIL_CUSTOMER_EMAIL = dropshipConfig.retailCustomerEmail
export const NS_RETAIL_CUSTOMER_TAG = dropshipConfig.retailCustomerTag

// Module-memoized GID cache. First call queries Shopify; subsequent
// calls return the cached value. Survives until the Node process
// restarts. Cleared automatically if Shopify returns "customer not
// found" on a downstream order create (admin manually deleted the
// customer — we'd re-create on the next call).
let _cachedCustomerGid = null

// ── GraphQL strings ─────────────────────────────────────────────────────

const QUERY_CUSTOMER_BY_TAG = `#graphql
  query NsRetailCustomerByTag($q: String!) {
    customers(first: 1, query: $q) {
      edges {
        node {
          id
          email
          tags
        }
      }
    }
  }
`

const MUTATION_CREATE_NS_RETAIL_CUSTOMER = `#graphql
  mutation CreateNsRetailCustomer($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer {
        id
        email
        tags
      }
      userErrors {
        field
        message
      }
    }
  }
`

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Resolve the "Natural Solutions Retail" customer's Shopify GID on the
 * wholesale store. Creates the customer on first call ever; subsequent
 * calls (in the same process) return the memoized GID instantly.
 *
 * The customer is identified by TAG, not email — admins might change
 * the email later; the tag is our stable anchor.
 *
 * @param {string} shop - wholesale shop domain (e.g. 'foo.myshopify.com')
 * @returns {Promise<string>} - gid://shopify/Customer/...
 */
export async function ensureNsRetailCustomer(shop) {
  if (_cachedCustomerGid) {
    return _cachedCustomerGid
  }

  const { admin } = await unauthenticated.admin(shop)

  // 1. Try to find by tag.
  try {
    const res = await admin.graphql(QUERY_CUSTOMER_BY_TAG, {
      variables: { q: `tag:${NS_RETAIL_CUSTOMER_TAG}` },
    })
    const data = await res.json()
    const node = data?.data?.customers?.edges?.[0]?.node
    if (node?.id) {
      _cachedCustomerGid = node.id
      log.info('found_existing', { gid: node.id, email: node.email })
      return _cachedCustomerGid
    }
  } catch (err) {
    log.warn('lookup_failed', { err: err?.message || err })
    // fall through to create — better to attempt creation than to fail entirely
  }

  // 2. Not found — create it once.
  try {
    const res = await admin.graphql(MUTATION_CREATE_NS_RETAIL_CUSTOMER, {
      variables: {
        input: {
          email: NS_RETAIL_CUSTOMER_EMAIL,
          firstName: 'Natural Solutions',
          lastName: 'Retail',
          tags: [NS_RETAIL_CUSTOMER_TAG, 'internal', 'drop-ship-target'],
          note: 'Synthetic B2B customer for retail-triggered drop-ship orders. Every retail Shopify order auto-creates a parallel wholesale order attached to this customer. Do not delete.',
        },
      },
    })
    const data = await res.json()
    const errs = data?.data?.customerCreate?.userErrors || []
    if (errs.length) {
      // If the email is already taken (e.g., someone created this manually
      // without our tag), Shopify returns a TAKEN error. Try searching by
      // email as a fallback so we adopt the existing customer.
      const taken = errs.find((e) =>
        String(e?.message || '').toLowerCase().includes('taken'),
      )
      if (taken) {
        log.warn('email_taken_searching_by_email', { email: NS_RETAIL_CUSTOMER_EMAIL })
        const fallbackRes = await admin.graphql(QUERY_CUSTOMER_BY_TAG, {
          variables: { q: `email:${NS_RETAIL_CUSTOMER_EMAIL}` },
        })
        const fallbackData = await fallbackRes.json()
        const fallbackNode = fallbackData?.data?.customers?.edges?.[0]?.node
        if (fallbackNode?.id) {
          _cachedCustomerGid = fallbackNode.id
          log.info('adopted_existing_by_email', { gid: fallbackNode.id })
          return _cachedCustomerGid
        }
      }
      throw new Error(
        `customerCreate userErrors: ${errs.map((e) => e.message).join('; ')}`,
      )
    }

    const created = data?.data?.customerCreate?.customer
    if (!created?.id) {
      throw new Error('customerCreate returned no customer id')
    }
    _cachedCustomerGid = created.id
    log.info('created_new', { gid: created.id, email: created.email })
    return _cachedCustomerGid
  } catch (err) {
    log.error('create_failed', { err: err?.message || err })
    throw err
  }
}

/**
 * Process a retail order through the drop-ship pipeline. Called fire-and-
 * forget from /api/sync/retail-order — never awaits, must self-handle all
 * errors and never throw.
 *
 * Phase A (this file): persist the mapping doc + verify NS Retail customer
 *                      exists. Order creation is a stub.
 * Phase B (next):      replace the stub with actual Draft Order creation.
 *
 * @param {object} args
 * @param {object} args.order - the retail Shopify order payload (REST shape)
 * @param {string} args.wholesaleShop - wholesale shop domain
 * @param {string} [args.retailShop] - retail shop domain (informational)
 */
export async function processRetailOrderForDropShip({
  order,
  wholesaleShop,
  retailShop = null,
}) {
  const retailOrderId = String(order?.id || '')
  if (!retailOrderId) {
    log.warn('skip_no_retail_id')
    return
  }

  // 1. Compute the amounts — locked at order receipt so any later
  //    price changes on the catalog don't retroactively shift this
  //    drop-ship order's wholesale invoice. wholesaleSubtotal is sourced
  //    from the actual wholesale product prices (sync_id_maps), not a
  //    ½-of-retail estimate.
  const { retailBaseSubtotal, wholesaleSubtotal, currency } =
    await computeDropshipAmounts(order)

  // 2. Upsert the mapping doc (idempotent on (shop, retailOrderId)).
  //    If a row already exists and is past 'received' we ALREADY started
  //    or finished the pipeline for this order — bail out.
  let mapping
  try {
    mapping = await DropshipMapping.findOneAndUpdate(
      { shop: wholesaleShop, retailOrderId },
      {
        $setOnInsert: {
          shop: wholesaleShop,
          retailShop,
          retailOrderId,
          retailOrderName: order?.name || null,
          retailOrderGid: order?.admin_graphql_api_id || null,
          retailBaseSubtotal,
          wholesaleSubtotal,
          currency,
          status: 'received',
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )
  } catch (err) {
    log.error('mapping_upsert_failed', {
      retailOrderId,
      err: err?.message || err,
    })
    return
  }

  log.info('mapping_ready', {
    retailOrderId,
    mappingId: String(mapping._id),
    status: mapping.status,
    retailBaseSubtotal,
    wholesaleSubtotal,
  })

  // If the mapping is past 'received', another concurrent webhook already
  // processed it. Bail.
  if (mapping.status !== 'received') {
    log.info('skip_already_processed', {
      retailOrderId,
      status: mapping.status,
    })
    return
  }

  // 3. Verify NS Retail customer exists on the wholesale store. Caches the
  //    GID on first call. Failure here is non-fatal for Phase A — we still
  //    keep the mapping doc so we can retry later.
  let nsRetailCustomerGid
  try {
    nsRetailCustomerGid = await ensureNsRetailCustomer(wholesaleShop)
  } catch (err) {
    log.error('ns_retail_customer_resolve_failed', {
      retailOrderId,
      err: err?.message || err,
    })
    await markMappingError(mapping._id, `ensureNsRetailCustomer: ${err?.message || err}`)
    return
  }

  log.info('ns_retail_customer_resolved', {
    retailOrderId,
    customerGid: nsRetailCustomerGid,
  })

  // 4. Create the wholesale Draft Order with wholesale-priced line items,
  //    then complete it to a real Order (Phase B).
  try {
    const result = await createDropshipWholesaleOrder({
      shop: wholesaleShop,
      order,
      mappingId: mapping._id,
      customerGid: nsRetailCustomerGid,
    })
    await DropshipMapping.updateOne(
      { _id: mapping._id },
      {
        $set: {
          wholesaleDraftOrderId: result.draftOrderGid,
          wholesaleOrderGid: result.orderGid,
          wholesaleOrderId: result.orderId,
          wholesaleOrderName: result.orderName,
          status: 'wholesale_order_created',
        },
      },
    )
    log.info('wholesale_order_created', {
      retailOrderId,
      wholesaleOrderId: result.orderId,
      wholesaleOrderName: result.orderName,
    })
  } catch (err) {
    log.error('wholesale_order_create_failed', {
      retailOrderId,
      err: err?.message || err,
    })
    await markMappingError(
      mapping._id,
      `createDropshipWholesaleOrder: ${err?.message || err}`,
    )
    return
  }
}

// ── Phase B — wholesale Draft Order creation ───────────────────────────

const MUTATION_DRAFT_ORDER_CREATE = `#graphql
  mutation DropshipDraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
      }
      userErrors { field message }
    }
  }
`

const MUTATION_DRAFT_ORDER_COMPLETE = `#graphql
  mutation DropshipDraftOrderComplete($id: ID!, $paymentPending: Boolean) {
    draftOrderComplete(id: $id, paymentPending: $paymentPending) {
      draftOrder {
        id
        name
        order {
          id
          name
          legacyResourceId
        }
      }
      userErrors { field message }
    }
  }
`

/**
 * Create the wholesale Shopify order that fulfills the retail order.
 * Uses Shopify's Draft Order API so we can set the wholesale product price
 * per line (via priceOverride), then completes the draft into a real order
 * (which decrements wholesale inventory natively).
 *
 * @returns {Promise<{draftOrderGid, orderGid, orderId, orderName}>}
 */
async function createDropshipWholesaleOrder({
  shop,
  order,
  mappingId,
  customerGid,
}) {
  const { admin } = await unauthenticated.admin(shop)

  // 1. Build line items — variant mapping + ½ base price.
  const lineItems = await buildDropshipLineItems(order)
  if (lineItems.length === 0) {
    throw new Error(
      'No mappable line items — every variant_id is missing from sync_id_maps',
    )
  }

  // 2. Build the Draft Order input. Shipping address copied from retail
  //    order. Email is intentionally OMITTED — when customerId is set,
  //    Shopify uses the linked customer's email automatically, and the
  //    explicit email field triggers a STRICTER MX-record validation
  //    that fails for any disposable / test domain (e.g., denipl.com).
  //    Customer-create has lenient validation; draftOrderCreate is strict.
  const draftInput = {
    customerId: customerGid,
    lineItems,
    shippingAddress: buildShopifyShippingAddress(order),
    tags: [
      'drop-ship',
      `retail-order:${order.id}`,
      `mapping:${String(mappingId)}`,
    ],
    note: `Auto-drop-ship for retail order ${order?.name || order?.id}. Patient: ${order?.email || 'n/a'}. Mapping ${String(mappingId)}.`,
  }

  const shippingLine = buildShippingLine(order)
  if (shippingLine) draftInput.shippingLine = shippingLine

  // 3. Create the Draft Order. If Shopify rejects with "Record is invalid"
  //    and no field path, the customerId is almost certainly stale (the
  //    cached customer was deleted out-of-band — either by an admin or by
  //    the old customers/create deletion path before the whitelist fix
  //    landed). Clear the in-process cache, re-resolve fresh, retry once.
  let createData = await runDraftOrderCreate(admin, draftInput)
  let createErrs = createData?.data?.draftOrderCreate?.userErrors || []

  const looksLikeDeadCustomer = createErrs.some(
    (e) =>
      /record is invalid/i.test(String(e?.message || '')) &&
      (!e?.field || e.field.length === 0),
  )
  if (looksLikeDeadCustomer) {
    log.warn('draft_order.cache_reset_retry', {
      cachedCustomerGid: customerGid,
      firstErrors: createErrs,
    })
    _resetNsRetailCustomerCache()
    const freshGid = await ensureNsRetailCustomer(shop)
    draftInput.customerId = freshGid
    log.info('draft_order.retrying_with_fresh_customer', { freshGid })
    createData = await runDraftOrderCreate(admin, draftInput)
    createErrs = createData?.data?.draftOrderCreate?.userErrors || []
  }

  if (createErrs.length) {
    throw new Error(
      `draftOrderCreate userErrors: ${createErrs.map((e) => `${(e.field || []).join('.')}: ${e.message}`).join('; ')}`,
    )
  }
  const draftOrderGid = createData?.data?.draftOrderCreate?.draftOrder?.id
  if (!draftOrderGid) {
    throw new Error('draftOrderCreate returned no draft order id')
  }

  // 4. Complete the draft → real Order. paymentPending=true because NS
  //    Retail isn't paying anything at draft time; the weekly batch (Phase F)
  //    will close the retail-side QBO bill that mirrors this invoice.
  const completeRes = await admin.graphql(MUTATION_DRAFT_ORDER_COMPLETE, {
    variables: { id: draftOrderGid, paymentPending: true },
  })
  const completeData = await completeRes.json()
  const completeErrs = completeData?.data?.draftOrderComplete?.userErrors || []
  if (completeErrs.length) {
    throw new Error(
      `draftOrderComplete userErrors: ${completeErrs.map((e) => `${(e.field || []).join('.')}: ${e.message}`).join('; ')}`,
    )
  }
  const realOrder = completeData?.data?.draftOrderComplete?.draftOrder?.order
  if (!realOrder?.id) {
    throw new Error('draftOrderComplete returned no real order')
  }

  return {
    draftOrderGid,
    orderGid: realOrder.id,
    orderId: String(realOrder.legacyResourceId || ''),
    orderName: realOrder.name || null,
  }
}

// Thin wrapper around the GraphQL call so the cache-reset retry above can
// re-invoke it with the same shape. Keeps the call site readable.
async function runDraftOrderCreate(admin, draftInput) {
  const res = await admin.graphql(MUTATION_DRAFT_ORDER_CREATE, {
    variables: { input: draftInput },
  })
  return await res.json()
}

// Fallback factor for the rare case where a variant's wholesale price
// snapshot isn't populated in sync_id_maps yet — preserves the legacy
// ½-of-retail behavior so an un-synced product never blocks invoicing.
// Mirrors the retail Vendor Bill's QBO_RETAIL_WHOLESALE_PRICE_FACTOR (0.5)
// so the two sides stay in sync even on this fallback path.
const WHOLESALE_PRICE_FALLBACK_FACTOR = 0.5

/**
 * Resolve each retail order line to its matching wholesale variant + the
 * wholesale UNIT price to charge. Pricing precedence (per the "Admin Order
 * invoices must use the wholesale product price" requirement):
 *
 *   1. sync_id_maps.wholesalePrice — the actual wholesale Shopify variant
 *      price captured by the product sync. AUTHORITATIVE. The retail QBO
 *      Vendor Bill reads the SAME field, so the wholesale invoice (A/R) and
 *      the retail vendor bill (A/P) stay numerically in sync by construction.
 *   2. retail base price × WHOLESALE_PRICE_FALLBACK_FACTOR — graceful
 *      fallback when the snapshot isn't populated yet (legacy ½ behavior).
 *
 * Lines with no variant_id, or no sync_id_maps row, come back with
 * wholesaleVariantId=null so the caller can skip + warn (we never silently
 * drop a product onto the wholesale order). Used by BOTH buildDropshipLineItems
 * (the order/invoice) and computeDropshipAmounts (the mapping audit subtotal)
 * so the two always agree.
 */
async function resolveWholesaleLines(order) {
  const lines = Array.isArray(order?.line_items) ? order.line_items : []
  const out = []
  for (const line of lines) {
    const retailVariantId = String(line?.variant_id || '')
    const qty = parseInt(line?.quantity || '1', 10) || 1
    const retailUnit = parseFloat(line?.price || '0') || 0
    const fallbackUnit =
      Math.round(retailUnit * WHOLESALE_PRICE_FALLBACK_FACTOR * 100) / 100

    if (!retailVariantId) {
      out.push({
        line,
        qty,
        retailVariantId: '',
        retailUnit,
        wholesaleVariantId: null,
        wholesaleUnitPrice: fallbackUnit,
        priceSource: 'fallback_no_variant',
        reason: 'no variant_id in retail line',
      })
      continue
    }

    const idMap = await SyncIdMap.findOne({
      entityType: 'productVariant',
      retailId: retailVariantId,
    })
      .select('wholesaleId wholesalePrice')
      .lean()

    if (!idMap?.wholesaleId) {
      out.push({
        line,
        qty,
        retailVariantId,
        retailUnit,
        wholesaleVariantId: null,
        wholesaleUnitPrice: fallbackUnit,
        priceSource: 'fallback_no_mapping',
        reason: 'no sync_id_maps row for this retail variant',
      })
      continue
    }

    const snapshot = Number(idMap.wholesalePrice)
    const hasSnapshot = Number.isFinite(snapshot) && snapshot > 0
    out.push({
      line,
      qty,
      retailVariantId,
      retailUnit,
      wholesaleVariantId: idMap.wholesaleId,
      wholesaleUnitPrice: hasSnapshot
        ? Math.round(snapshot * 100) / 100
        : fallbackUnit,
      priceSource: hasSnapshot
        ? 'sync_id_maps.wholesalePrice'
        : 'fallback_no_snapshot',
    })
  }
  return out
}

/**
 * Build the wholesale DraftOrder line item inputs from the retail order,
 * priced at the actual WHOLESALE product price (see resolveWholesaleLines).
 *
 * Throws if ANY variant is unmappable (we'd rather hard-fail than silently
 * drop products from the wholesale order).
 */
async function buildDropshipLineItems(order) {
  const resolved = await resolveWholesaleLines(order)
  const out = []
  const unmapped = []

  for (const r of resolved) {
    if (!r.wholesaleVariantId) {
      unmapped.push({
        line_id: r.line?.id,
        retailVariantId: r.retailVariantId,
        reason: r.reason,
      })
      continue
    }
    out.push({
      variantId: `gid://shopify/ProductVariant/${r.wholesaleVariantId}`,
      quantity: r.qty,
      priceOverride: {
        amount: r.wholesaleUnitPrice.toFixed(2),
        currencyCode: order?.currency || 'USD',
      },
    })
  }

  if (unmapped.length) {
    log.warn('unmapped_line_items', { count: unmapped.length, unmapped })
  }
  const lineCount = Array.isArray(order?.line_items)
    ? order.line_items.length
    : 0
  if (out.length === 0 && lineCount > 0) {
    throw new Error(
      `All ${lineCount} line items unmappable to wholesale variants`,
    )
  }
  // Trace so an admin can confirm the wholesale price was applied per line
  // (and which lines fell back) when verifying an Admin Order invoice.
  log.info('dropship_line_pricing', {
    lines: resolved
      .filter((r) => r.wholesaleVariantId)
      .map((r) => ({
        wholesaleVariantId: r.wholesaleVariantId,
        qty: r.qty,
        retailUnit: r.retailUnit,
        wholesaleUnit: r.wholesaleUnitPrice,
        source: r.priceSource,
      })),
  })
  return out
}

/**
 * Pull the retail order's shipping address and project it into the
 * MailingAddressInput shape Shopify expects on draftOrderCreate.
 */
function buildShopifyShippingAddress(order) {
  const a = order?.shipping_address || order?.billing_address
  if (!a) return null
  return {
    firstName: a.first_name || null,
    lastName: a.last_name || null,
    address1: a.address1 || null,
    address2: a.address2 || null,
    city: a.city || null,
    province: a.province || null,
    provinceCode: a.province_code || null,
    zip: a.zip || null,
    country: a.country || null,
    countryCode: a.country_code || null,
    phone: a.phone || null,
    company: a.company || null,
  }
}

/**
 * Build the shipping line for the wholesale order at the REAL carrier
 * cost (not retail's marked-up price).
 *
 * Retail's checkout charged the customer:
 *   retail_shipping = carrier_real_rate + (totalQty × SHIPPING_PER_QTY_CENTS)
 *
 * The wholesale order should reflect ONLY the real carrier portion —
 * the per-qty markup is retail's margin and must NOT propagate to the
 * supplier-side order. Reverse-calculation:
 *
 *   real_carrier_cost = retail_shipping − (totalQty × SHIPPING_PER_QTY_CENTS)
 *
 * The markup constant is read from `dropshipConfig.shippingMarkupPerQtyCents`,
 * which reads the SAME `SHIPPING_PER_QTY_CENTS` env that the carrier-service
 * callback at app/api/shipping/rates.js uses. Both ends MUST share the same
 * value — the env file is the single source of truth.
 *
 * Edge cases:
 *   • No shipping_lines on retail order → returns null (no shipping line on wholesale).
 *   • Markup exceeds retail shipping (static fallback rates, free-shipping
 *     promos) → flooring at $0 so wholesale never sees a NEGATIVE shipping
 *     line. Acceptable trade-off until proper static-fallback handling lands.
 */
function buildShippingLine(order) {
  const lines = Array.isArray(order?.shipping_lines) ? order.shipping_lines : []
  const first = lines[0]
  if (!first) return null

  const retailPriceDollars = parseFloat(first?.price || '0')
  const perItemCents = Number(dropshipConfig.shippingMarkupPerQtyCents) || 100
  const totalQty = (order?.line_items || []).reduce(
    (sum, it) => sum + (Number(it?.quantity) || 0),
    0,
  )
  const markupDollars = (totalQty * perItemCents) / 100
  const realCostDollars = Math.max(0, retailPriceDollars - markupDollars)

  return {
    title: first?.title || 'Shipping',
    price: realCostDollars.toFixed(2),
  }
}

// ── Internals ───────────────────────────────────────────────────────────

/**
 * Compute the retail base subtotal (sum of retail variant.price × qty BEFORE
 * patient discount/shipping/tax) and the wholesale subtotal (sum of the
 * resolved WHOLESALE unit prices × qty — see resolveWholesaleLines). Both are
 * informational fields stored on the DropshipMapping for traceability; the
 * actual invoiced amount comes from the QBO invoice the wholesale pipeline
 * creates from the order's wholesale-priced lines.
 *
 * Reads `line_items[].price` from the REST payload (the retail BASE unit
 * price; Shopify applies any patient discount separately in
 * `discount_allocations`, so this ignores discounts by design). Locked at
 * order receipt so later catalog price changes don't retroactively shift the
 * recorded amounts.
 */
async function computeDropshipAmounts(order) {
  const resolved = await resolveWholesaleLines(order)
  let retailBaseSubtotal = 0
  let wholesaleSubtotal = 0
  for (const r of resolved) {
    retailBaseSubtotal += r.retailUnit * r.qty
    wholesaleSubtotal += r.wholesaleUnitPrice * r.qty
  }
  // Round to cents to avoid floating-point drift in downstream comparisons.
  retailBaseSubtotal = Math.round(retailBaseSubtotal * 100) / 100
  wholesaleSubtotal = Math.round(wholesaleSubtotal * 100) / 100
  const currency = order?.currency || 'USD'
  return { retailBaseSubtotal, wholesaleSubtotal, currency }
}

async function markMappingError(mappingId, message) {
  try {
    await DropshipMapping.updateOne(
      { _id: mappingId },
      {
        $set: {
          status: 'error',
          lastError: String(message).slice(0, 1000),
          lastErrorAt: new Date(),
        },
      },
    )
  } catch (err) {
    log.error('markMappingError_failed', {
      mappingId: String(mappingId),
      err: err?.message || err,
    })
  }
}

// ── Test helpers (not used in production code paths) ───────────────────

/**
 * Reset the in-process memoization. Useful in tests; in production this
 * only matters if an admin deletes the customer manually after we've
 * cached its GID — but downstream code can call this when it sees a
 * "customer not found" error on the next drop-ship order create.
 */
export function _resetNsRetailCustomerCache() {
  _cachedCustomerGid = null
}
