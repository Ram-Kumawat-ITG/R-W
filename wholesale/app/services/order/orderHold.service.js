// Payment-driven ORDER HOLD reconciler.
//
// A practitioner is put "on hold" (blocked from placing new orders) whenever
// they have an outstanding FAILED invoice — i.e. an invoice whose card retries
// were exhausted (paymentStatus: 'failed') and which isn't a drop-ship invoice.
// The hold is cleared automatically once no such invoice remains.
//
// This is a SEPARATE concept from the admin `status: 'blocked'` / "Blocked" tag
// flow — an admin block is a manual decision and is never touched here (and this
// hold never sets/clears the admin block). The hold is enforced at CHECKOUT by
// the cart.validations.generate.run Function, which reads the app-owned customer
// metafield this reconciler keeps in sync.
//
// The single source of truth is live invoice state, so this is idempotent and
// self-healing: call it whenever an invoice becomes failed (block) or paid
// (maybe-unblock), or run it as a sweep — it always converges the practitioner's
// hold to match their actual outstanding balance.

import connectDB from '../APIService/mongo.service'
import Invoice from '../../models/invoice.server'
import WholesaleApplication from '../../models/wholesaleApplication.server'
import { setCustomerOrderHoldMetafield } from '../shopify/shopify.service'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('orderHold.service')

// Does this practitioner currently have an outstanding failed invoice?
// `paymentStatus: 'failed'` is the exhausted/unpaid signal (card ladder + the
// chargeInvoice maxAttempts path both set it). Drop-ship invoices are excluded
// (they're collected on a separate batch flow, not by the practitioner).
export async function hasOutstandingFailedInvoice({ shop, email }) {
  if (!shop || !email) return false
  const doc = await Invoice.exists({
    shop,
    customerEmail: String(email).toLowerCase(),
    paymentStatus: 'failed',
    isDropship: { $ne: true },
  })
  return Boolean(doc)
}

// Reconcile a single practitioner's order hold against their live invoice
// state. Best-effort on the Shopify metafield write (never throws) so it can be
// safely awaited from payment/webhook/CRON flows without risking the primary
// operation. Returns { held, changed }.
//
// `force` re-writes the customer metafield even when the stored flag already
// matches (used by the backfill sweep to guarantee the metafield exists).
export async function reconcilePractitionerOrderHold({ shop, email, reason = 'outstanding_invoice', force = false } = {}) {
  if (!shop || !email) return { held: false, changed: false }
  const normalizedEmail = String(email).toLowerCase()

  try {
    await connectDB()

    const app = await WholesaleApplication.findOne({ shop, email: normalizedEmail }).select(
      '_id customerId orderHold',
    )
    // No practitioner record (e.g. a drop-ship / non-registered buyer) — nothing to hold.
    if (!app) return { held: false, changed: false }

    const shouldHold = await hasOutstandingFailedInvoice({ shop, email: normalizedEmail })
    const currentlyHeld = Boolean(app.orderHold)
    const changed = shouldHold !== currentlyHeld

    if (!changed && !force) {
      return { held: shouldHold, changed: false }
    }

    // Persist the flag on the application (source of truth + admin visibility).
    if (changed) {
      app.orderHold = shouldHold
      if (shouldHold) {
        app.orderHoldReason = reason
        app.orderHoldAt = new Date()
      } else {
        app.orderHoldReason = null
        app.orderHoldClearedAt = new Date()
      }
      await app.save()
      log.info('order_hold.changed', { shop, email: normalizedEmail, held: shouldHold, reason })
    }

    // Mirror onto the Shopify customer metafield (what the checkout Function
    // reads). Best-effort — a Shopify failure here must not break the payment
    // flow that triggered this; the next reconcile / backfill re-syncs it.
    if (app.customerId) {
      try {
        await setCustomerOrderHoldMetafield({ shop, customerId: app.customerId, held: shouldHold })
      } catch (metaErr) {
        log.error('order_hold.metafield_failed', {
          shop,
          email: normalizedEmail,
          held: shouldHold,
          err: metaErr?.message || metaErr,
        })
      }
    } else {
      log.warn('order_hold.no_customer_id', { shop, email: normalizedEmail })
    }

    return { held: shouldHold, changed }
  } catch (err) {
    log.error('order_hold.reconcile_failed', { shop, email: normalizedEmail, err: err?.message || err })
    return { held: false, changed: false, error: err?.message || String(err) }
  }
}
