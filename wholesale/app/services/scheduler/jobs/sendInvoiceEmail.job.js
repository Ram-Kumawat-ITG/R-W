// Durable, background QuickBooks invoice-email delivery.
//
// QBO's `/invoice/<id>/send` is an HTTP round-trip that renders + mails the
// current invoice document. Firing it inline blocks whatever triggered it —
// notably the admin "Send invoice" button (an HTTP request). This job moves
// that send off the request path and makes it durable + retried:
//
//   • the admin action returns immediately (queued), never waiting on QBO;
//   • the job is persisted, so a restart mid-send doesn't lose it;
//   • a failed send reschedules on a backoff ladder, and every attempt is
//     recorded on the invoice's emailEvents[] audit ledger either way.
//
// Payload carries only ids/strings (fully serializable); the job reloads the
// live Invoice so it always mails current state.

import Invoice from '../../../models/invoice.server'
import { sendInvoiceEmail } from '../../qbo/qbo.service'
import { appendInvoiceRemark, recordEmailEvent } from '../../invoice/invoice.service'
import { createLogger } from '../../../utils/logger.utils'

export const SEND_INVOICE_EMAIL_JOB = 'send-invoice-email'
const log = createLogger('job.send_invoice_email')

const RETRY_DELAYS_MIN = [2, 5, 15, 60]
const MAX_ATTEMPTS = RETRY_DELAYS_MIN.length + 1

export function registerSendInvoiceEmailJob(agenda) {
  agenda.define(
    SEND_INVOICE_EMAIL_JOB,
    { concurrency: 5, lockLifetime: 5 * 60 * 1000 },
    async (job) => {
      const {
        shop,
        invoiceId,
        sendTo: sendToOverride,
        triggerType = 'auto',
        triggeredBy = 'system',
        source = 'manual_resend',
        remark,
        attempt = 1,
      } = job.attrs.data || {}
      const context = { shop, invoiceId, attempt }

      if (!invoiceId) {
        log.error('invoice_email.no_id', context)
        return
      }

      const invoice = await Invoice.findOne(shop ? { _id: invoiceId, shop } : { _id: invoiceId })
      if (!invoice) {
        log.error('invoice_email.invoice_missing', context)
        return
      }
      if (!invoice.qboInvoiceId) {
        log.warn('invoice_email.no_qbo_id', context)
        return
      }

      const sendTo = sendToOverride || invoice.customerEmail
      if (!sendTo) {
        log.warn('invoice_email.no_recipient', context)
        return
      }

      try {
        await sendInvoiceEmail({ qboInvoiceId: invoice.qboInvoiceId, sendTo })

        // Advance the lifecycle-dispatcher baseline so a later payment/status
        // event doesn't immediately re-send a duplicate.
        const now = new Date()
        if (!invoice.invoiceEmailSentAt) invoice.invoiceEmailSentAt = now
        invoice.invoiceEmailLastSentAt = now
        invoice.invoiceEmailedStatus = invoice.paymentStatus
        invoice.invoiceEmailedAmountPaid = Number((invoice.amountPaid || 0).toFixed(2))
        invoice.lastEmailError = undefined
        recordEmailEvent(invoice, { triggerType, triggeredBy, source, recipient: sendTo, status: 'sent' })
        await invoice.save()

        if (remark) {
          await appendInvoiceRemark(invoice._id, { kind: 'admin_action', message: remark, source: 'admin' })
        }
        log.info('invoice_email.sent', { ...context, qboInvoiceId: invoice.qboInvoiceId, sendTo })
      } catch (err) {
        const msg = `QBO invoice send failed: ${err?.message || 'unknown error'}`
        invoice.lastEmailError = msg
        recordEmailEvent(invoice, {
          triggerType,
          triggeredBy,
          source,
          recipient: sendTo,
          status: 'failed',
          errorMessage: err?.message || 'unknown error',
        })
        await invoice.save()

        if (attempt < MAX_ATTEMPTS) {
          const delayMin = RETRY_DELAYS_MIN[attempt - 1]
          log.warn('invoice_email.retry_scheduled', { ...context, error: msg, retryInMin: delayMin })
          await job.agenda.schedule(`in ${delayMin} minutes`, SEND_INVOICE_EMAIL_JOB, {
            ...job.attrs.data,
            attempt: attempt + 1,
          })
          return
        }
        log.error('invoice_email.exhausted', { ...context, error: msg, maxAttempts: MAX_ATTEMPTS })
      }
    },
  )
}
