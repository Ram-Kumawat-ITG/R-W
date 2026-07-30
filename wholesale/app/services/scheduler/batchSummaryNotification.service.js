// Admin-facing "Batch Processing Summary" email — sent once per
// process-pending-payments CRON tick, regardless of outcome (success,
// partial, or failed). Distinct from paymentFailureNotification.service.js
// (customer-facing, one email per failed charge) — this is one email per
// TICK, addressed to the admin recipient in batchSummaryNotificationConfig.
//
// Never throws — a mail-transport hiccup must not affect payment
// processing or the CronBatchRun history write, both of which have
// already fully completed by the time this is called.

import { enqueueEmail } from '../email/emailQueue.service'
import { batchSummaryNotificationConfig } from './batchSummaryNotification.config'
import { isEmailNotificationsPaused } from './cronNotificationSettings.service'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('batchSummaryNotification.service')

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '—'
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

// Pure content builder — no I/O, so it can be reused/tested (or previewed
// from an admin tool later) without touching the send path.
export function buildBatchSummaryEmail({
  jobName,
  tick,
  tickId,
  status,
  startedAt,
  finishedAt,
  durationMs,
  processed,
  approved,
  declined,
  errored,
  skipped,
  followupsLogged,
  sweepProcessed,
  sweepOk,
  sweepFailed,
  totalInvoiceAmount,
  totalPractitioners,
  errorDetails,
}) {
  const statusLabel = { success: 'Success', partial: 'Partial', failed: 'Failed' }[status] || 'Unknown'
  const subject = `[${statusLabel}] CRON Batch Summary — ${jobName} (tick ${tickId})`

  const stats = [
    ['Job', jobName],
    ['Tick', `${tick} (#${tickId})`],
    ['Status', statusLabel],
    ['Started', startedAt ? new Date(startedAt).toISOString() : '—'],
    ['Finished', finishedAt ? new Date(finishedAt).toISOString() : '—'],
    ['Duration', formatDuration(durationMs)],
    ['Total invoices processed', processed],
    ['Approved', approved],
    ['Declined', declined],
    ['Errored', errored],
    ['Skipped', skipped],
    ['Total invoice amount', totalInvoiceAmount != null ? totalInvoiceAmount.toFixed(2) : '—'],
    ['Distinct practitioners', totalPractitioners],
    ['Failed-payment follow-ups logged', followupsLogged],
    ['Sync-retry processed', sweepProcessed],
    ['Sync-retry ok', sweepOk],
    ['Sync-retry failed', sweepFailed],
  ]

  const errors = errorDetails || []

  const text =
    `CRON Batch Processing Summary\n\n` +
    stats.map(([label, value]) => `${label}: ${value}`).join('\n') +
    (errors.length
      ? `\n\nErrors / transaction details (${errors.length}):\n` +
        errors.map((e) => `- [${e.qboInvoiceId || e.invoiceId}] ${e.message}`).join('\n')
      : '\n\nNo errors this tick.')

  const html =
    `<p><strong>CRON Batch Processing Summary</strong></p>` +
    `<p>Automated payment batch has completed. Review the summary and any errors below.</p>` +
    `<table role="presentation" style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px">` +
    `<tbody>` +
    stats.map(([label, value]) => `<tr><th style="text-align:left;padding:8px;border:1px solid #d5d5d5;background:#f4f4f4">${label}</th><td style="padding:8px;border:1px solid #d5d5d5">${value}</td></tr>`).join('') +
    `</tbody>` +
    `</table>` +
    (errors.length
      ? `<p style="margin-top:16px"><strong>Errors / transaction details (${errors.length})</strong></p>` +
        `<table role="presentation" style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr><th style="text-align:left;padding:8px;border:1px solid #d5d5d5;background:#f4f4f4">Invoice</th><th style="text-align:left;padding:8px;border:1px solid #d5d5d5;background:#f4f4f4">Message</th></tr></thead><tbody>` +
        errors.map((e) => `<tr><td style="padding:8px;border:1px solid #d5d5d5"><strong>${e.qboInvoiceId || e.invoiceId}</strong></td><td style="padding:8px;border:1px solid #d5d5d5">${e.message}</td></tr>`).join('') +
        `</tbody></table>`
      : '<p style="margin-top:16px">No errors this tick.</p>')

  return { subject, text, html }
}

export async function sendBatchSummaryEmail(params) {
  const context = { jobName: params?.jobName, tick: params?.tick, tickId: params?.tickId }
  try {
    if (await isEmailNotificationsPaused()) {
      log.info('summary.skipped_paused', context)
      return { success: false, error: 'CRON email notifications are currently paused', skipped: true }
    }

    const { subject, text, html } = buildBatchSummaryEmail(params)
    const result = await enqueueEmail(
      { to: batchSummaryNotificationConfig.adminEmail, subject, text, html },
      { label: 'batch_summary' },
    )
    if (result.success) {
      log.info('summary.queued', { ...context, to: batchSummaryNotificationConfig.adminEmail })
    } else {
      log.error('summary.send_failed', { ...context, error: result.error })
    }
    return result
  } catch (err) {
    log.error('summary.unexpected', { ...context, err })
    return { success: false, error: err.message || 'Unexpected error sending batch summary email' }
  }
}
