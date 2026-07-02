// Wholesale → Retail fulfillment-status mirror.
//
// When a drop-ship wholesale order is fulfilled / shipped / delivered /
// cancelled, this notifies the ns-retail app so it mirrors the status (and
// carrier + tracking + delivery state) onto the linked RETAIL Shopify order.
//
// Direction: this is the reverse of the existing retail→wholesale sync. The
// retail store owns the retail Shopify Admin token, so we don't mutate the
// retail order from here — we POST the change to ns-retail's
// /api/sync/wholesale-fulfillment endpoint (shared-secret auth) and it applies
// the Shopify fulfillment + records it on cdo_orders + the retail QBO invoice.
//
// Gating: only orders we hold a DropshipMapping for (i.e. retail-triggered
// drop-ship orders) are mirrored. Dedup: a content signature of the order's
// fulfillment state is stored on the mapping; an unchanged signature short-
// circuits, so re-delivered webhooks / repeated Order-Details live-pulls never
// fire a duplicate or conflicting update.
//
// SERVER-ONLY (network + DB). Best-effort: every path is wrapped so a retail
// outage / misconfig NEVER breaks wholesale fulfillment capture.

import DropshipMapping from '../../models/dropshipMapping.server'
import { syncConfig, isFulfillmentSyncEnabled } from './sync.config'
import { carrierDisplayName } from '../../utils/shipping.constants'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('sync.fulfillment')

// Content signature of the order's fulfillment state — order-independent
// (fulfillments sorted by id). Only the fields that matter to the retail
// mirror are included, so cosmetic churn doesn't trigger a re-POST.
function buildSignature({ event, localOrder }) {
  if (event === 'cancelled') {
    const at = localOrder.cancelledAt ? new Date(localOrder.cancelledAt).getTime() : 'x'
    return `cancelled:${at}`
  }
  const parts = (localOrder.fulfillments || [])
    .map((f) =>
      [
        f.fulfillmentId,
        f.trackingNumber || '',
        f.trackingCompany || '',
        f.shipmentStatus || '',
        f.status || '',
      ].join('~'),
    )
    .sort()
  const ship = localOrder.shippedAt ? new Date(localOrder.shippedAt).getTime() : ''
  return `ff:${localOrder.fulfillmentStatus || ''}:${ship}:${parts.join('|')}`
}

// Project the local fulfillments[] into the cross-store payload shape. We send
// a resolved carrier display name so the retail side doesn't need our carrier
// normalization tables.
function projectFulfillments(localOrder) {
  return (localOrder.fulfillments || []).map((f) => ({
    wholesaleFulfillmentId: f.fulfillmentId,
    trackingNumber: f.trackingNumber || null,
    trackingCompany: f.trackingCompany || null,
    carrier: carrierDisplayName(f.carrierKey, f.trackingCompany) || null,
    trackingUrl: f.trackingUrl || f.shopifyTrackingUrl || null,
    shipmentStatus: f.shipmentStatus || null,
    status: f.status || null,
    fulfilledAt: f.fulfilledAt || null,
    deliveredAt: f.deliveredAt || null,
  }))
}

async function recordOutcome(mappingId, { signature, event, status, error }) {
  try {
    const now = new Date()
    const set = {
      'retailFulfillmentSync.lastEvent': event,
      'retailFulfillmentSync.lastStatus': status,
      'retailFulfillmentSync.lastSyncedAt': now,
    }
    if (status === 'ok') {
      set['retailFulfillmentSync.lastSignature'] = signature
      set['retailFulfillmentSync.lastError'] = null
    } else {
      set['retailFulfillmentSync.lastError'] = error || 'unknown'
      set['retailFulfillmentSync.lastErrorAt'] = now
    }
    await DropshipMapping.updateOne(
      { _id: mappingId },
      { $set: set, $inc: { 'retailFulfillmentSync.attempts': 1 } },
    )
  } catch (err) {
    log.warn('record_outcome_failed', { err: err?.message || String(err) })
  }
}

// Mirror a drop-ship wholesale order's fulfillment / cancellation onto the
// linked retail Shopify order (via ns-retail). NEVER throws.
//
//   localOrder — the wholesale ShopifyOrder mongoose doc (already saved)
//   event      — 'fulfillment' (created/updated/shipped/delivered) | 'cancelled'
export async function notifyRetailOfDropshipChange({ localOrder, event = 'fulfillment' }) {
  try {
    if (!isFulfillmentSyncEnabled()) {
      log.info('skip.disabled', { reason: 'NS_RETAIL_API_BASE / RETAIL_SYNC_SECRET not set' })
      return { ok: false, reason: 'disabled' }
    }
    if (!localOrder?.shop || !localOrder?.shopifyOrderId) {
      return { ok: false, reason: 'missing_ids' }
    }

    // Gate: only retail-triggered drop-ship orders have a mapping. This is also
    // how we resolve the retail order id, so a missing mapping = nothing to do.
    const mapping = await DropshipMapping.findOne({
      shop: localOrder.shop,
      wholesaleOrderId: String(localOrder.shopifyOrderId),
    })
    if (!mapping) return { ok: false, reason: 'no_mapping' }
    if (!mapping.retailOrderId && !mapping.retailOrderGid) {
      log.warn('no_retail_order_on_mapping', {
        mappingId: String(mapping._id),
        wholesaleOrderId: localOrder.shopifyOrderId,
      })
      return { ok: false, reason: 'no_retail_order' }
    }

    const signature = buildSignature({ event, localOrder })
    if (
      mapping.retailFulfillmentSync?.lastStatus === 'ok' &&
      mapping.retailFulfillmentSync?.lastSignature === signature
    ) {
      log.info('skip.unchanged', { retailOrderId: mapping.retailOrderId, event })
      return { ok: true, skipped: true, reason: 'unchanged' }
    }

    const payload = {
      event,
      wholesaleShop: localOrder.shop,
      wholesaleOrderId: String(localOrder.shopifyOrderId),
      wholesaleOrderName: localOrder.shopifyOrderName || null,
      retailShop: mapping.retailShop || syncConfig.retailShop || null,
      retailOrderId: mapping.retailOrderId || null,
      retailOrderGid: mapping.retailOrderGid || null,
      retailOrderName: mapping.retailOrderName || null,
      fulfillmentStatus: localOrder.fulfillmentStatus || null,
      shippedAt: localOrder.shippedAt || null,
      // Order-level delivery milestone — set once EVERY active shipment is
      // delivered. `delivered` is the convenience flag the retail side keys on.
      deliveredAt: localOrder.deliveredAt || null,
      delivered: Boolean(localOrder.deliveredAt),
      fulfillments: event === 'cancelled' ? [] : projectFulfillments(localOrder),
      cancel:
        event === 'cancelled'
          ? {
              cancelledAt: localOrder.cancelledAt || null,
              reason: localOrder.cancelReason || null,
            }
          : null,
      signature,
    }

    const url = `${syncConfig.nsRetailApiBase.replace(/\/+$/, '')}/api/sync/wholesale-fulfillment`
    log.info('post', {
      url,
      event,
      retailOrderId: payload.retailOrderId,
      fulfillments: payload.fulfillments.length,
    })

    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-sync-secret': syncConfig.syncSecret,
        },
        body: JSON.stringify(payload),
        // Bound the call so a hung / slow tunnel can't stall the fulfillment
        // webhook, an Order-Details page load, or a resync CRON tick.
        signal: AbortSignal.timeout(syncConfig.fulfillmentSyncTimeoutMs),
      })
    } catch (err) {
      const msg = `network: ${err?.message || err}`
      await recordOutcome(mapping._id, { signature, event, status: 'error', error: msg })
      log.error('post.network_failed', { retailOrderId: payload.retailOrderId, err: msg })
      return { ok: false, reason: 'network', error: msg }
    }

    const text = await res.text().catch(() => '')
    if (!res.ok) {
      const msg = `${res.status}: ${text.slice(0, 300)}`
      await recordOutcome(mapping._id, { signature, event, status: 'error', error: msg })
      log.error('post.failed', { retailOrderId: payload.retailOrderId, status: res.status, body: text.slice(0, 300) })
      return { ok: false, reason: 'http', status: res.status }
    }

    await recordOutcome(mapping._id, { signature, event, status: 'ok', error: null })
    log.info('post.ok', { retailOrderId: payload.retailOrderId, event, status: res.status })
    return { ok: true }
  } catch (err) {
    // Last-ditch guard — this function must never throw into a fulfillment path.
    log.error('unhandled', { err: err?.message || String(err) })
    return { ok: false, reason: 'unhandled', error: err?.message || String(err) }
  }
}
