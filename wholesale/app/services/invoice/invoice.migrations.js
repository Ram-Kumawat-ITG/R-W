// One-time-style migrations for the invoices collection. Safe to run on
// every boot — each function is gated by the presence/absence of the
// field it's backfilling, so it becomes a no-op once the data is
// consistent.

import Invoice from '../../models/invoice.server'
import CustomerMap from '../../models/customerMap.server'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('invoice.migrations')

// Backfill `Invoice.customerPaymentPreference` (the immutable order-time
// preference snapshot) for invoices created before the field existed.
//
// Source of truth ordering, best to worst:
//   1. The linked `CustomerMap.paymentMethod` for that customer. The
//      cheque → card admin override only ever flips
//      `Invoice.paymentMethod`, never `CustomerMap.paymentMethod`, so
//      the customer-map value is a faithful witness for what the
//      preference was — UNLESS the customer has updated their
//      preference via /api/update-profile after the invoice was created.
//      That edge case can't be recovered from existing data.
//   2. Fallback: `Invoice.paymentMethod`. Works for invoices that have
//      not been overridden (paymentMethod === original preference).
//      Wrong for overridden invoices, but it's our last resort if no
//      CustomerMap row exists.
//
// Idempotent: only acts on invoices where `customerPaymentPreference`
// is missing. Once filled, subsequent boots are no-ops.
export async function backfillCustomerPaymentPreferences() {
  const cursor = Invoice.find({ customerPaymentPreference: { $exists: false } })
    .select('_id customerMapRef paymentMethod')
    .cursor()

  let inspected = 0
  let updatedFromCustomerMap = 0
  let updatedFromPaymentMethod = 0
  let skipped = 0
  const customerMapCache = new Map()

  for await (const inv of cursor) {
    inspected += 1
    let source = null
    let value = null

    if (inv.customerMapRef) {
      const key = String(inv.customerMapRef)
      let cm = customerMapCache.get(key)
      if (!cm) {
        cm = await CustomerMap.findById(inv.customerMapRef).select('paymentMethod').lean()
        customerMapCache.set(key, cm || null)
      }
      if (cm?.paymentMethod) {
        value = cm.paymentMethod
        source = 'customer_map'
      }
    }
    if (!value && inv.paymentMethod) {
      value = inv.paymentMethod
      source = 'invoice.paymentMethod'
    }
    if (!value) {
      skipped += 1
      continue
    }

    await Invoice.updateOne(
      { _id: inv._id },
      { $set: { customerPaymentPreference: value } },
    )
    if (source === 'customer_map') updatedFromCustomerMap += 1
    else updatedFromPaymentMethod += 1
  }

  if (inspected === 0) {
    console.log('[boot] customerPaymentPreference backfill — nothing to do')
    return { inspected, updatedFromCustomerMap, updatedFromPaymentMethod, skipped }
  }

  console.log(
    `[boot] customerPaymentPreference backfill — inspected=${inspected} ` +
      `cm=${updatedFromCustomerMap} pm=${updatedFromPaymentMethod} skipped=${skipped}`,
  )
  log.info('backfill.customer_payment_preference.done', {
    inspected,
    updatedFromCustomerMap,
    updatedFromPaymentMethod,
    skipped,
  })
  return { inspected, updatedFromCustomerMap, updatedFromPaymentMethod, skipped }
}
