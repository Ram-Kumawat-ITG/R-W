import mongoose from 'mongoose'

// Singleton document (exactly one row, ever) — the GLOBAL EMAIL KILL SWITCH.
//
// When `emailNotificationsPaused` is true, the app sends NO outbound email
// from ANY source. It is enforced at every send choke point:
//   • SMTP transport      — services/email/email.service.sendEmail() (covers
//                            every SMTP notification: payment-failure, batch
//                            summary, reminders, order-block, referral,
//                            account, application-lifecycle, admin alerts)
//   • QBO invoice emails  — services/qbo/qbo.service.sendInvoiceEmail()
//                            (customer invoice + reminder emails QuickBooks
//                            renders/sends)
//   • Shopify invites     — services/shopify/shopify.service.sendCustomerInvite()
//
// This flag NEVER affects charge processing, invoice status, order/customer
// sync, or the CronBatchRun history write — it ONLY silences outbound email.
// Use the existing per-invoice `autoChargePaused` (Invoice model) to pause
// charging a specific invoice instead.
//
// NOTE: NMI's legacy "Electronic Invoicing" emails are configured in the NMI
// merchant dashboard and are NOT triggered by this app's code, so they can
// only be disabled in NMI itself — this switch cannot reach them.
//
// (Collection name is historical — `cron_notification_settings` — kept to
// preserve the existing singleton row; the scope is now app-wide.)
const cronNotificationSettingsSchema = new mongoose.Schema(
  {
    emailNotificationsPaused: { type: Boolean, default: false },
    pausedAt: Date,
    pausedBy: String,
    pauseNote: String,
    resumedAt: Date,
    resumedBy: String,
  },
  { timestamps: true, collection: 'cron_notification_settings' },
)

export default mongoose.models.CronNotificationSettings ||
  mongoose.model('CronNotificationSettings', cronNotificationSettingsSchema)
