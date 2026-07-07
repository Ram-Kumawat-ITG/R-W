import mongoose from 'mongoose'

// Singleton document (exactly one row, ever) controlling whether the
// process-pending-payments CRON's two email notifications — the customer
// "Payment Failed" email (services/payment/paymentFailureNotification.
// service.js) and the admin "Batch Processing Summary" email (services/
// scheduler/batchSummaryNotification.service.js) — are sent.
//
// This flag NEVER affects charge processing, invoice status, or the
// CronBatchRun history write — it only silences these two emails. Use the
// existing per-invoice `autoChargePaused` (Invoice model) to pause
// charging a specific invoice instead.
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
