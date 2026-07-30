import { readEnv } from '../../utils/env.utils'

export const paymentFailureNotificationConfig = {
  // Support address surfaced in the "contact support" line of the email.
  // Falls back to the shared SMTP from-address if unset.
  supportEmail: readEnv('PAYMENT_FAILURE_SUPPORT_EMAIL'),
  // Admin address CC'd on every customer "Payment Failed" email. Same env
  // var as the batch-summary notification's recipient
  // (services/scheduler/batchSummaryNotification.config.js) — one knob for
  // "where admin payment notifications go", temporary placeholder per the
  // project owner, swappable with no code change.
  adminEmail: readEnv('CRON_ADMIN_EMAIL', { fallback: 'laviva2883@acoxs.com' }),
}
