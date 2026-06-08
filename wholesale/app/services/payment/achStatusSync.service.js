// ACH Status Synchronization service.
//
// Owns reconciliation of in-flight ACH transactions between NMI and our
// database. Driven by the dedicated `process-ach-status-sync` CRON
// (services/scheduler/jobs/processAchStatusSync.job.js), which is
// INDEPENDENT of the payment-processing CRON (`process-pending-payments`):
// that job charges; this one ONLY reconciles status.
//
// Responsibilities (and only these):
//   • find ACH invoices in a non-final state (awaiting_settlement) that
//     carry a live NMI transaction id
//   • query NMI for the latest transaction condition
//   • detect status changes (settled / returned / voided / failed /
//     still-settling) and update the payment + invoice records
//   • store ACH return codes + return reasons
//   • append an audit-trail entry for every status CHANGE
//   • emit success/failure logs + a tick summary
//   • notify admins of critical failures / returns / stuck transactions
//
// Idempotent + safe to re-run: a settled or returned invoice leaves the
// awaiting_settlement cursor, and a still-pending poll makes no change —
// so running the sweep twice does no extra work and writes no duplicate
// audit rows. The money/state transitions are delegated to
// payment.service.checkAchSettlement (the single source of truth, shared
// with the admin "check settlement" action); this layer adds the audit
// trail, return-code capture, and admin notification on top.
//
// The per-invoice reconciliation body is extracted into reconcileAchInvoice
// so it is shared verbatim by BOTH the CRON sweep (syncAchTransactionStatuses)
// and the on-demand admin button (manualSyncAchInvoice). The manual path
// additionally takes an atomic per-invoice lock (`achSyncInProgress`) so two
// concurrent sync requests — a double-click, or an overlapping CRON tick —
// can never both reconcile the same invoice at once.

import connectDB from '../APIService/mongo.service'
import Invoice from '../../models/invoice.server'
import CustomerMap from '../../models/customerMap.server'
import { checkAchSettlement } from './payment.service'
import { achSyncConfig, STILL_PENDING_REMARK_THROTTLE_MS } from './achStatusSync.config'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('ach_status_sync')

const MS_PER_DAY = 24 * 60 * 60 * 1000

// Only invoices in a NON-FINAL ACH state with a transaction to poll.
// Final states (paid / failed / cancelled) are never re-checked — this is
// the performance optimization the spec calls for.
function eligibilityFilter() {
  return {
    paymentMethod: 'ach',
    paymentStatus: 'awaiting_settlement',
    pendingSettlementTxnId: { $exists: true, $ne: null },
  }
}

// Map (our action, NMI condition, resulting status) → a normalized
// lifecycle label stored in the audit trail.
function normalizeStatus(action, condition, newStatus) {
  if (action === 'settled') return 'settled'
  if (action === 'returned') {
    if (newStatus === 'failed') return 'failed'
    if (condition === 'canceled') return 'voided'
    return 'returned'
  }
  if (action === 'still_pending') return 'pending_settlement'
  return 'unknown'
}

function money(n) {
  return Number(n || 0).toFixed(2)
}

async function recordStatusChange(invoiceId, entry) {
  await Invoice.updateOne(
    { _id: invoiceId },
    { $push: { achStatusHistory: entry } },
  )
}

// Reuse the existing `cron_ach_settlement_check` remark kind so the
// Order Details / Order List badge map keeps rendering it without a UI
// change. The dedicated audit trail lives on achStatusHistory[].
// `source` is 'cron' for the scheduled sweep, 'admin' for the manual
// button — drives the remarks ledger's origin column.
async function appendRemark(invoiceId, message, amount, currency, at, source = 'cron') {
  await Invoice.updateOne(
    { _id: invoiceId },
    {
      $push: {
        remarks: {
          kind: 'cron_ach_settlement_check',
          message,
          amount,
          currency,
          source,
          createdAt: at,
        },
      },
    },
  )
}

// Record the "last sync" display fields (timestamp + latest status/condition
// returned by NMI + which path ran it). Written on EVERY reconcile — CRON or
// manual, and for every outcome including still-pending / unknown — so the
// Order Details page can always show when the invoice was last synced and
// what NMI last reported.
async function updateSyncDisplayFields(invoiceId, { now, normalizedStatus, condition, source }) {
  await Invoice.updateOne(
    { _id: invoiceId },
    {
      $set: {
        achSyncLastAt: now,
        achSyncLastStatus: normalizedStatus,
        achSyncLastCondition: condition || null,
        achSyncLastSource: source,
      },
    },
  )
}

// Critical-alert notifier. Always emits a high-visibility structured log
// (picked up by log aggregation / monitoring) + a console banner. If a
// deployment has opted in via ACH_ALERT_WEBHOOK_URL, also POSTs the alert
// (best-effort — never throws, never blocks the sweep). The invoice's
// achStatusHistory[] + remarks[] are the persisted, admin-visible record
// (written by the caller); this function is the push channel.
async function notifyAchAlert({ invoice, event, message, detail = {} }) {
  const payload = {
    severity: 'critical',
    event,
    invoiceId: String(invoice._id),
    qboInvoiceId: invoice.qboInvoiceId,
    shopifyOrderId: invoice.shopifyOrderId,
    customerEmail: invoice.customerEmail,
    message,
    ...detail,
  }
  log.error('ach.alert', payload)
  console.error(
    `\n🚨 [ACH ALERT] ${event} — invoice ${invoice.qboInvoiceId || invoice._id}: ${message}\n`,
  )
  if (!achSyncConfig.alertWebhookUrl) return
  try {
    await fetch(achSyncConfig.alertWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (err) {
    // Alerting must never break reconciliation.
    log.warn('ach.alert.webhook_failed', { event, err: err?.message || String(err) })
  }
}

// Reconcile ONE in-flight ACH invoice against NMI and record the outcome
// (status-change audit row, operator remark, critical-alert push, and the
// "last sync" display fields). Shared verbatim by the CRON sweep and the
// manual admin button — `source` distinguishes them ('cron_ach_status_sync'
// vs 'admin_manual_sync') for the audit trail, remark origin, and message
// wording. Returns a normalized result for the caller to summarize / surface.
//
// Throws only on an unexpected error (e.g. DB write failure); a transport /
// lookup failure against NMI is handled gracefully inside checkAchSettlement
// and surfaces here as action 'unknown'. `now` is injectable for testing.
export async function reconcileAchInvoice({
  invoice,
  customerMap = null,
  now = new Date(),
  source = 'cron_ach_status_sync',
}) {
  const invId = invoice._id.toString()
  const txnId = invoice.pendingSettlementTxnId
  // Capture BEFORE the settlement call — checkAchSettlement overwrites
  // pendingSettlementLastCheckedAt with `now`, so we snapshot the prior
  // value (for the still-pending remark throttle) and the prior status.
  const previousStatus = invoice.paymentStatus
  const lastCheckedBefore = invoice.pendingSettlementLastCheckedAt
  const since = invoice.pendingSettlementSince
  const ageDays = since
    ? Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / MS_PER_DAY))
    : 0

  const isManual = source === 'admin_manual_sync'
  const remarkSource = isManual ? 'admin' : 'cron'
  const label = isManual ? 'Manual ACH status sync' : 'ACH status sync'

  console.log(
    `${isManual ? '· manual' : '│ ⟳ cron'} ach-sync invoice ${invoice.qboInvoiceId || invId} txn=${txnId} ageDays=${ageDays}`,
  )

  const result = await checkAchSettlement({ invoice, customerMap })
  const status = normalizeStatus(result.action, result.condition, result.newStatus)

  if (result.action === 'settled') {
    await recordStatusChange(invoice._id, {
      at: now,
      status,
      previousStatus,
      nmiCondition: result.condition || 'complete',
      nmiTransactionId: txnId,
      amount: result.amount,
      source,
    })
    await appendRemark(
      invoice._id,
      `${label} — settlement confirmed (NMI txn ${txnId}, condition=${result.condition || 'complete'}). $${money(result.amount)} applied; invoice now ${result.newStatus}.`,
      result.amount,
      invoice.currency,
      now,
      remarkSource,
    )
    log.info('sync.settled', { invoiceId: invId, txnId, amount: result.amount, newStatus: result.newStatus, source })
  } else if (result.action === 'returned') {
    await recordStatusChange(invoice._id, {
      at: now,
      status,
      previousStatus,
      nmiCondition: result.condition,
      nmiTransactionId: txnId,
      returnCode: result.returnCode,
      returnReason: result.reason,
      amount: result.amount,
      source,
    })
    await appendRemark(
      invoice._id,
      `${label} — ${status}${result.returnCode ? ` (return code ${result.returnCode})` : ''}: ${result.reason || result.condition}. Invoice reset to ${result.newStatus} for retry / card fallback.`,
      result.amount,
      invoice.currency,
      now,
      remarkSource,
    )
    log.warn('sync.returned', {
      invoiceId: invId, txnId, condition: result.condition,
      returnCode: result.returnCode, reason: result.reason, newStatus: result.newStatus, source,
    })
    // Critical: a returned/voided/failed ACH debit needs admin attention.
    await notifyAchAlert({
      invoice,
      event: `ach_${status}`,
      message: `ACH ${status}${result.returnCode ? ` [${result.returnCode}]` : ''} — ${result.reason || result.condition}`,
      detail: { transactionId: txnId, condition: result.condition, returnCode: result.returnCode, newStatus: result.newStatus },
    })
  } else if (result.action === 'still_pending') {
    const sinceLast = lastCheckedBefore ? now.getTime() - new Date(lastCheckedBefore).getTime() : Infinity
    const throttleElapsed = sinceLast >= STILL_PENDING_REMARK_THROTTLE_MS
    // For a manual sync the admin explicitly asked for an update, so we
    // always write a progress remark (bypass the once-per-day throttle
    // that keeps the CRON from flooding the panel during the wait window).
    if (throttleElapsed || isManual) {
      await appendRemark(
        invoice._id,
        `${label} — still settling (NMI condition=${result.condition || 'pendingsettlement'}, day ${ageDays} of the typical 1–3 business day window).`,
        undefined,
        invoice.currency,
        now,
        remarkSource,
      )
    }
    // Stuck-transaction alert (throttled to once/day via the same gate;
    // a manual sync surfaces it immediately).
    if ((throttleElapsed || isManual) && ageDays >= achSyncConfig.stuckAfterDays) {
      await notifyAchAlert({
        invoice,
        event: 'ach_stuck',
        message: `ACH transaction has been awaiting settlement for ${ageDays} day(s) (threshold ${achSyncConfig.stuckAfterDays}) — condition=${result.condition || 'pendingsettlement'}`,
        detail: { transactionId: txnId, ageDays },
      })
    }
    console.log(`  → still pending (condition=${result.condition || '?'})`)
  } else {
    // unknown / noop — lookup failed or invoice changed underneath us.
    console.log(`  → ${result.action} (reason="${result.reason || '?'}")`)
    log.warn('sync.unknown', { invoiceId: invId, txnId, action: result.action, reason: result.reason, source })
  }

  // Record the "last sync" display fields for every outcome (CRON or manual).
  await updateSyncDisplayFields(invoice._id, {
    now,
    normalizedStatus: status,
    condition: result.condition,
    source,
  })

  return {
    action: result.action,
    normalizedStatus: status,
    condition: result.condition,
    amount: result.amount,
    returnCode: result.returnCode,
    reason: result.reason,
    newStatus: result.newStatus,
    transactionId: txnId,
    ageDays,
  }
}

// Evaluate every eligible (in-flight) ACH invoice, reconcile its status
// against NMI, and record the outcome. `now` is injectable for testing.
export async function syncAchTransactionStatuses({ now = new Date() } = {}) {
  await connectDB()

  const cursor = Invoice.find(eligibilityFilter()).cursor()
  const summary = {
    evaluated: 0,
    settled: 0,
    returned: 0,
    stillPending: 0,
    unknown: 0,
    failed: 0, // sync errors (exceptions), NOT ACH failures
  }

  for await (const invoice of cursor) {
    summary.evaluated += 1
    const invId = invoice._id.toString()
    const txnId = invoice.pendingSettlementTxnId

    try {
      const customerMap = invoice.customerMapRef
        ? await CustomerMap.findById(invoice.customerMapRef)
        : null

      const result = await reconcileAchInvoice({
        invoice,
        customerMap,
        now,
        source: 'cron_ach_status_sync',
      })

      if (result.action === 'settled') summary.settled += 1
      else if (result.action === 'returned') summary.returned += 1
      else if (result.action === 'still_pending') summary.stillPending += 1
      else summary.unknown += 1
    } catch (err) {
      summary.failed += 1
      console.error(err.stack || err)
      log.error('sync.unexpected', { invoiceId: invId, txnId, err })
      // One bad invoice never stops the sweep — continue to the next.
    }
  }

  log.info('sync.complete', summary)
  return summary
}

// On-demand reconciliation of a SINGLE ACH invoice, triggered by the admin
// "Sync ACH status" button. Takes an atomic per-invoice lock first so a
// double-click (or an overlapping CRON tick) can't reconcile the same
// invoice twice concurrently. The lock is ALWAYS released in `finally`,
// even when reconciliation throws.
//
// Returns:
//   { ok: true,  ...reconcileResult, lastSyncAt }
//   { ok: false, reason: 'in_progress' }   — another sync holds the lock
//   { ok: false, reason: 'not_found' }     — invoice id doesn't exist
//   { ok: false, reason: 'error', error }  — reconciliation threw
export async function manualSyncAchInvoice({
  invoiceId,
  customerMap = null,
  initiatedBy = 'admin',
  now = new Date(),
}) {
  await connectDB()

  // Atomic lock: flip achSyncInProgress false→true in one operation. If the
  // doc isn't returned, either it doesn't exist or a sync is already running.
  const invoice = await Invoice.findOneAndUpdate(
    { _id: invoiceId, achSyncInProgress: { $ne: true } },
    { $set: { achSyncInProgress: true, achSyncStartedAt: now } },
    { new: true },
  )
  if (!invoice) {
    const exists = await Invoice.exists({ _id: invoiceId })
    return { ok: false, reason: exists ? 'in_progress' : 'not_found' }
  }

  try {
    const result = await reconcileAchInvoice({
      invoice,
      customerMap,
      now,
      source: 'admin_manual_sync',
    })
    await Invoice.updateOne({ _id: invoiceId }, { $set: { achSyncLastBy: initiatedBy } })
    return { ok: true, ...result, lastSyncAt: now }
  } catch (err) {
    log.error('manual_sync.failed', { invoiceId: String(invoiceId), err })
    // Record that a sync was attempted + failed so the UI reflects it.
    await Invoice.updateOne(
      { _id: invoiceId },
      {
        $set: {
          achSyncLastAt: now,
          achSyncLastStatus: 'error',
          achSyncLastSource: 'admin_manual_sync',
          achSyncLastBy: initiatedBy,
        },
      },
    )
    return { ok: false, reason: 'error', error: err?.message || String(err) }
  } finally {
    // Always release the lock — use updateOne (not the possibly-stale
    // in-memory doc) so a thrown reconcile still clears it cleanly.
    await Invoice.updateOne(
      { _id: invoiceId },
      { $set: { achSyncInProgress: false }, $unset: { achSyncStartedAt: '' } },
    )
  }
}
