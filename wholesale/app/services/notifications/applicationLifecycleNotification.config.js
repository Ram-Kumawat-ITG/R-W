import { readEnv } from '../../utils/env.utils'

// Config for the three wholesale-registration lifecycle emails (Submitted /
// Approved / Declined) — see applicationLifecycleNotification.service.js.
export const applicationLifecycleNotificationConfig = {
  // CC'd on every customer email in this module. Same env var / same
  // "one knob for where admin notifications go" convention already
  // established by services/payment/paymentFailureNotification.config.js
  // and services/scheduler/batchSummaryNotification.config.js.
  adminEmail: readEnv('CRON_ADMIN_EMAIL', { fallback: 'laviva2883@acoxs.com' }),
  // Optional support contact surfaced on the Declined email. Falls back to
  // a generic phrase if unset (mirrors PAYMENT_FAILURE_SUPPORT_EMAIL's
  // pattern in paymentFailureNotification.config.js).
  supportEmail: readEnv('WHOLESALE_SUPPORT_EMAIL'),
}
