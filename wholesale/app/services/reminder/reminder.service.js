// Check-payment reminder service.
//
// Identifies unpaid CHECK-method invoices and sends dynamic SMTP reminder
// emails on a three-stage ladder (first / second / card-on-file) measured
// from the order/invoice date. The ladder thresholds are Day 9 / Day 11 /
// Day 13 in production and Minute 1 / 3 / 4 in testing mode (see
// reminder.config). After the final stage, a RECURRING reminder repeats at
// the configured interval (REMINDER_REPEAT_*) until the invoice is paid.
// Responsibilities are intentionally narrow:
//   • identify eligible invoices (payment type + order date + status)
//   • decide which reminder stage is due
//   • build a per-stage dynamic email (services/reminder/reminderEmail)
//     with full order + invoice details and send it via the shared SMTP
//     queue (enqueueEmail) — NOT QBO, which can't render a dynamic body
//   • record notification history (Invoice.paymentReminders) to dedup
//   • log the activity (emailEvents[] + remarks[]) for audit
//
// It NEVER charges a payment method or moves money — the Day 13 notice
// only informs the customer that the balance may be charged to the card
// on file; any such charge is initiated manually by an admin.

import connectDB from '../APIService/mongo.service'
import Invoice from '../../models/invoice.server'
import ShopifyOrder from '../../models/order.server'
import WholesaleApplication from '../../models/wholesaleApplication.server'
import { enqueueEmail } from '../email/emailQueue.service'
import { recordEmailEvent } from '../invoice/invoice.service'
import { buildReminderEmail } from './reminderEmail.service'
import { reminderEmailConfig } from './reminderEmail.config'
import { createLogger } from '../../utils/logger.utils'
import {
  reminderConfig,
  reminderStages,
  recurringStage,
  recurringIntervalUnits,
} from './reminder.config'

const log = createLogger('reminder.service')

const MS_PER_DAY = 24 * 60 * 60 * 1000
const MS_PER_MIN = 60 * 1000

// Resolve the practitioner's display name for the email greeting/details.
async function resolvePractitionerName(email) {
  if (!email) return null
  try {
    const app = await WholesaleApplication.findOne({ email })
      .select('firstName lastName businessName')
      .lean()
    if (!app) return null
    return [app.firstName, app.lastName].filter(Boolean).join(' ') || app.businessName || null
  } catch {
    return null
  }
}

// Resolve the order number + product summary from the linked ShopifyOrder.
// Products come from the raw Shopify payload's line_items (title/qty/price).
async function resolveOrderContext(invoice) {
  const empty = { orderNumber: null, products: [] }
  if (!invoice.orderRef) return empty
  try {
    const order = await ShopifyOrder.findById(invoice.orderRef)
      .select('shopifyOrderName shopifyOrderNumber rawPayload')
      .lean()
    if (!order) return empty
    const orderNumber =
      order.shopifyOrderName ||
      (order.shopifyOrderNumber ? `#${order.shopifyOrderNumber}` : null)
    const lineItems = Array.isArray(order.rawPayload?.line_items) ? order.rawPayload.line_items : []
    const products = lineItems.slice(0, 25).map((li) => ({
      title: [li.title, li.variant_title && li.variant_title !== 'Default Title' ? li.variant_title : null]
        .filter(Boolean)
        .join(' — '),
      quantity: li.quantity != null ? Number(li.quantity) : null,
      price: li.price != null ? Number(li.price) : null,
    }))
    return { orderNumber, products }
  } catch {
    return empty
  }
}

// Order/issue date anchor. qboTxnDate is the invoice transaction date
// (set to the order date at creation); fall back to the row's createdAt.
function orderDateOf(invoice) {
  if (invoice.qboTxnDate) {
    const d = new Date(invoice.qboTxnDate)
    if (!Number.isNaN(d.getTime())) return d
  }
  return invoice.createdAt || null
}

function elapsedUnits(orderDate, now) {
  const ms = now.getTime() - orderDate.getTime()
  return Math.floor(ms / (reminderConfig.useMinutes ? MS_PER_MIN : MS_PER_DAY))
}

function stageAlreadySent(invoice, stage) {
  return (invoice.paymentReminders || []).some(
    (r) => r.stage === stage && r.status === 'sent',
  )
}

// Timestamp (ms) of the most recent successfully-sent reminder of any
// stage, or null if none. Anchors the recurring-phase throttle.
function lastReminderSentMs(invoice) {
  let max = 0
  for (const r of invoice.paymentReminders || []) {
    if (r.status !== 'sent') continue
    const t = r.sentAt ? new Date(r.sentAt).getTime() : 0
    if (t > max) max = t
  }
  return max || null
}

// Recurring reminder due? Only once the final ladder stage has gone out
// (callers gate on that). Throttled to the configured repeat interval
// since the most recent reminder, so we email at the configured cadence
// rather than on every CRON tick — and never twice within one cycle.
function recurringDue(invoice, now) {
  const lastMs = lastReminderSentMs(invoice)
  if (lastMs == null) return null
  const unitMs = reminderConfig.useMinutes ? MS_PER_MIN : MS_PER_DAY
  const intervalMs = recurringIntervalUnits() * unitMs
  if (now.getTime() - lastMs < intervalMs) return null
  return recurringStage
}

// The reminder due for this invoice right now, or null.
//
// We send only the CURRENT level — the highest-threshold stage whose
// elapsed time has been reached — and only if it hasn't been sent yet. A
// later notice supersedes earlier ones: if the CRON was down across
// several days (or thresholds are crossed at once), we jump straight to
// the most-advanced reminder instead of replaying the earlier ones. Each
// named stage fires at most once, in order.
//
// Once the FINAL (highest-threshold / card / Day 13) stage has been
// sent, we enter the RECURRING phase: keep reminding at the configured
// interval (recurringDue) until the invoice is paid — at which point it
// has already dropped out of the eligibility filter and stops.
function dueStage(invoice, elapsed, now) {
  const stages = reminderStages()
  const target = stages.find((s) => elapsed >= s.threshold)
  if (!target) return null
  if (!stageAlreadySent(invoice, target.stage)) return target
  // Highest reached named stage already sent. If that's the final stage
  // (stages are ordered high → low, so stages[0] is the last one), keep
  // the recurring reminders going; otherwise wait for the next stage.
  if (target.stage === stages[0].stage) {
    return recurringDue(invoice, now)
  }
  return null
}

// Eligible invoices: Check method, open + unpaid, with a real QBO invoice
// to email, and not muted via the reminder-pause flag. Once an invoice is
// paid it drops out of the `paymentStatus` set, so reminders stop
// automatically; `reminderPaused` lets an admin mute it ahead of that.
function eligibilityFilter() {
  return {
    paymentMethod: 'check',
    paymentStatus: { $in: ['pending', 'partially_paid'] },
    qboCreationStatus: 'created',
    qboInvoiceId: { $exists: true, $ne: null },
    reminderPaused: { $ne: true },
  }
}

// Evaluate every eligible Check invoice and trigger the appropriate QBO
// reminder email. Named ladder stages are sent at most once (guarded by
// Invoice.paymentReminders); the recurring stage repeats on the
// configured interval; a failed send is retried on the next run.
// `now` is injectable for testing.
export async function processCheckPaymentReminders({ now = new Date() } = {}) {
  await connectDB()

  const invoices = await Invoice.find(eligibilityFilter())
  const summary = { evaluated: invoices.length, sent: 0, failed: 0, skipped: 0 }

  for (const invoice of invoices) {
    const orderDate = orderDateOf(invoice)
    if (!orderDate) {
      summary.skipped += 1
      continue
    }
    const elapsed = elapsedUnits(orderDate, now)
    const stage = dueStage(invoice, elapsed, now)
    if (!stage) {
      summary.skipped += 1
      continue
    }

    const recipient = invoice.customerEmail || undefined
    const unit = reminderConfig.useMinutes ? 'min' : 'day'

    if (!recipient) {
      // No email to send to — record a skip and move on (can't remind).
      summary.skipped += 1
      log.warn('reminder.skipped_no_email', { invoiceId: String(invoice._id), stage: stage.stage })
      continue
    }

    try {
      // Gather full order + invoice details for the dynamic body.
      const [practitionerName, orderCtx] = await Promise.all([
        resolvePractitionerName(invoice.customerEmail),
        resolveOrderContext(invoice),
      ])

      const { subject, text, html } = buildReminderEmail({
        stage: stage.stage,
        practitionerName,
        orderNumber: orderCtx.orderNumber,
        invoiceNumber: invoice.qboDocNumber || invoice.qboInvoiceId || null,
        invoiceDate: invoice.qboTxnDate || invoice.createdAt || null,
        outstandingAmount:
          invoice.amountDue != null && invoice.amountPaid != null
            ? invoice.amountDue - invoice.amountPaid
            : invoice.amountDue,
        currency: invoice.currency,
        paymentStatus: invoice.paymentStatus,
        dueDate: invoice.dueAt || invoice.qboDueDate || null,
        products: orderCtx.products,
        supportEmail: reminderEmailConfig.supportEmail,
      })

      const result = await enqueueEmail(
        {
          to: recipient,
          cc: reminderEmailConfig.adminEmail || undefined,
          subject,
          text,
          html,
        },
        { label: `payment_reminder_${stage.stage}` },
      )

      if (!result?.success) {
        throw new Error(result?.error || 'email enqueue failed')
      }

      invoice.paymentReminders.push({
        stage: stage.stage,
        sentAt: now,
        daysSinceOrder: elapsed,
        recipient,
        status: 'sent',
      })
      recordEmailEvent(invoice, {
        triggerType: 'auto',
        triggeredBy: 'system',
        source: 'payment_reminder',
        recipient,
        status: 'sent',
      })
      invoice.remarks.push({
        kind: 'cron_payment_reminder',
        message: `${stage.label} emailed via SMTP (${unit} ${elapsed}). ${stage.message}`,
        source: 'cron',
        createdAt: now,
      })
      invoice.invoiceEmailLastSentAt = now
      await invoice.save()

      summary.sent += 1
      log.info('reminder.sent', {
        invoiceId: String(invoice._id),
        qboInvoiceId: invoice.qboInvoiceId,
        stage: stage.stage,
        elapsed,
        unit,
      })
    } catch (err) {
      const message = err?.message || String(err)
      invoice.paymentReminders.push({
        stage: stage.stage,
        sentAt: now,
        daysSinceOrder: elapsed,
        recipient: recipient || '(none)',
        status: 'failed',
        errorMessage: message,
      })
      recordEmailEvent(invoice, {
        triggerType: 'auto',
        triggeredBy: 'system',
        source: 'payment_reminder',
        recipient: recipient || '(none)',
        status: 'failed',
        errorMessage: message,
      })
      invoice.remarks.push({
        kind: 'cron_payment_reminder',
        message: `${stage.label} send FAILED (${unit} ${elapsed}): ${message}`,
        source: 'cron',
        createdAt: now,
      })
      invoice.lastEmailError = message
      await invoice.save()

      summary.failed += 1
      log.error('reminder.failed', {
        invoiceId: String(invoice._id),
        stage: stage.stage,
        err: message,
      })
    }
  }

  log.info('reminder.run_complete', summary)
  return summary
}
