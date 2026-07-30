// Read-side helpers for the Orders page's "CRON Batch" section — the
// upcoming process-pending-payments run (live-computed, no new
// persistence needed) and the batch-run history (CronBatchRun, written
// by processPendingPayments.job.js after every tick).

import Invoice from '../../models/invoice.server'
import ShopifyOrder from '../../models/order.server'
import WholesaleApplication from '../../models/wholesaleApplication.server'
import CronBatchRun from '../../models/cronBatchRun.server'
import CronBatchRunItem from '../../models/cronBatchRunItem.server'
import { getAgenda, JOB_NAMES } from './scheduler.service'
import { parseDateOnly, startOfDay } from '../../utils/format.utils'

// Practitioner display name isn't stored on Invoice/CustomerMap — batch
// resolve (one IN query, not N) from WholesaleApplication by email.
// Shared shape with the per-invoice names processPendingPayments.job.js
// resolves at charge time (that one is a per-tick cache built while
// streaming a cursor, so it can't reuse this batched form directly, but
// the derivation — firstName+lastName, falling back to businessName —
// is kept identical here).
async function resolvePractitionerNamesByEmail(emails) {
  const uniqueEmails = [...new Set(emails.filter(Boolean))]
  if (!uniqueEmails.length) return new Map()
  const apps = await WholesaleApplication.find({ email: { $in: uniqueEmails } })
    .select('email firstName lastName businessName')
    .lean()
  const map = new Map()
  for (const app of apps) {
    const name = [app.firstName, app.lastName].filter(Boolean).join(' ') || app.businessName || null
    map.set(app.email, name)
  }
  return map
}

// Same eligibility filter PASS 1 of processPendingPayments.job.js charges
// against — kept in sync manually since the job's cursor isn't exported
// as a reusable query builder. If that filter changes, update this too.
function pendingChargeFilter(blockedEmails = []) {
  return {
    paymentStatus: 'pending',
    paymentMethod: { $in: ['card', 'ach'] },
    isDropship: { $ne: true },
    autoChargePaused: { $ne: true },
    $expr: { $lt: ['$attemptCount', '$maxAttempts'] },
    ...(blockedEmails.length ? { customerEmail: { $nin: blockedEmails } } : {}),
  }
}

// Upcoming batch: next scheduled run (from Agenda's persisted job docs)
// + a live snapshot of every invoice PASS 1 would currently pick up if
// it ran right now, with the same per-order breakdown shape as a
// completed batch's history (Order ID, Practitioner, Order date,
// Invoice #, Invoice amount, Processing fee). The snapshot is
// necessarily a moving target — invoices can be added/paid/paused
// between page load and the actual run — so this is presented as an
// estimate, not a locked-in batch. No new persistence: everything here
// is a live re-query.
export async function getUpcomingBatch() {
  const agenda = await getAgenda()
  const jobs = await agenda.jobs({ name: JOB_NAMES.PROCESS_PENDING_PAYMENTS })

  let soonest = null
  let running = false
  for (const job of jobs) {
    const a = job.attrs
    // Agenda holds `lockedAt` for the duration of an in-flight run and
    // clears it on completion/failure — a simple, good-enough "is this
    // job executing right now" signal without reimplementing Agenda's
    // internal lock-lifetime logic.
    if (a.lockedAt) running = true
    if (a.nextRunAt && (!soonest || a.nextRunAt < soonest.nextRunAt)) soonest = a
  }

  const blockedApps = await WholesaleApplication.find({ status: 'blocked' })
    .select('email')
    .lean()
  const blockedEmails = blockedApps
    .map((app) => String(app.email || '').toLowerCase())
    .filter(Boolean)

  const invoices = await Invoice.find(pendingChargeFilter(blockedEmails))
    .select(
      'shopifyOrderId orderRef customerEmail qboInvoiceId qboDocNumber ' +
        'currency amountDue amountPaid processingFeeAmount attemptCount ' +
        'maxAttempts createdAt qboTxnDate',
    )
    .lean()

  const orderIds = invoices.map((i) => i.orderRef).filter(Boolean)
  const orders = orderIds.length
    ? await ShopifyOrder.find({ _id: { $in: orderIds } })
        .select('shopifyOrderName shopifyOrderNumber receivedAt')
        .lean()
    : []
  const orderById = new Map(orders.map((o) => [o._id.toString(), o]))

  const nameByEmail = await resolvePractitionerNamesByEmail(invoices.map((i) => i.customerEmail))

  const items = invoices.map((inv) => {
    const order = inv.orderRef ? orderById.get(inv.orderRef.toString()) : null
    const orderLabel =
      order?.shopifyOrderName ||
      (order?.shopifyOrderNumber ? `#${order.shopifyOrderNumber}` : inv.shopifyOrderId)
    return {
      _id: inv._id.toString(),
      shopifyOrderId: inv.shopifyOrderId,
      orderLabel,
      orderDate: order?.receivedAt || inv.qboTxnDate || inv.createdAt,
      practitionerEmail: inv.customerEmail || null,
      practitionerName: nameByEmail.get(inv.customerEmail) || null,
      qboInvoiceId: inv.qboInvoiceId,
      qboDocNumber: inv.qboDocNumber,
      currency: inv.currency || 'USD',
      invoiceAmount: Number(((inv.amountDue || 0) - (inv.amountPaid || 0)).toFixed(2)),
      processingFeeAmount: inv.processingFeeAmount || 0,
      attemptCount: inv.attemptCount,
      maxAttempts: inv.maxAttempts,
    }
  })

  const totalAmount = items.reduce((sum, it) => sum + it.invoiceAmount, 0)
  const totalPractitioners = new Set(items.map((it) => it.practitionerEmail).filter(Boolean)).size

  return {
    nextRunAt: soonest?.nextRunAt || null,
    tick: soonest?.data?.tick || null,
    status: running ? 'running' : soonest?.nextRunAt ? 'scheduled' : 'unscheduled',
    totalInvoices: items.length,
    totalAmount: Number(totalAmount.toFixed(2)),
    totalPractitioners,
    items,
  }
}

// Batch history, each row carrying its own per-order breakdown
// (CronBatchRunItem) so the Orders page can render an `<s-details>`
// drill-down per batch (same pattern as the Admin Order Batch page's
// "Order details" disclosure) with no extra per-row fetch. History is
// paginated at a small page size, so pulling every visible batch's
// items in one grouped query is cheap — no N+1.
//
// `status` / `tick` are exact matches on CronBatchRun's own fields;
// `dateFrom`/`dateTo` are inclusive on `startedAt` (date-only strings,
// same convention as the Orders list's own date-range filter).
export async function getBatchHistory({
  page = 1,
  pageSize = 10,
  status,
  tick,
  dateFrom,
  dateTo,
} = {}) {
  const safePage = Math.max(1, Number(page) || 1)

  const query = {}
  if (status) query.status = status
  if (tick) query.tick = tick
  const from = parseDateOnly(dateFrom)
  const to = parseDateOnly(dateTo)
  if (from || to) {
    query.startedAt = {}
    if (from) query.startedAt.$gte = startOfDay(from)
    if (to) {
      const end = new Date(to)
      end.setHours(23, 59, 59, 999)
      query.startedAt.$lte = end
    }
  }

  const total = await CronBatchRun.countDocuments(query)
  const rows = await CronBatchRun.find(query)
    .sort({ startedAt: -1 })
    .skip((safePage - 1) * pageSize)
    .limit(pageSize)
    .lean()

  const batchIds = rows.map((r) => r._id)
  const items = batchIds.length
    ? await CronBatchRunItem.find({ batchRunRef: { $in: batchIds } })
        .sort({ createdAt: 1 })
        .lean()
    : []
  const itemsByBatch = new Map()
  for (const item of items) {
    const key = item.batchRunRef.toString()
    if (!itemsByBatch.has(key)) itemsByBatch.set(key, [])
    itemsByBatch.get(key).push({ ...item, _id: item._id.toString(), batchRunRef: key })
  }

  return {
    // `.lean()` leaves `_id` as a BSON ObjectId. React Router's loader
    // serialization doesn't preserve its prototype (toString/toJSON get
    // dropped), so the client was rendering `String(b._id)` as the
    // useless default `"[object Object]"`. Stringify server-side, same
    // as every other loader in this app (e.g. `r._id.toString()` in the
    // order rows above).
    rows: rows.map((r) => {
      const id = r._id.toString()
      return { ...r, _id: id, items: itemsByBatch.get(id) || [] }
    }),
    total,
    page: safePage,
    pageSize,
  }
}
