import { readEnv } from '../../utils/env.utils'

// Config for the "New Orders Temporarily Blocked" notification (order hold on
// card-retry exhaustion). Mirrors paymentFailureNotification.config so admin
// notifications all land in one place.
export const orderBlockNotificationConfig = {
  // Support address surfaced in the email's "contact support" line. Falls back
  // to the shared payment-failure support address; if neither is set a generic
  // line (no address) is used.
  supportEmail:
    readEnv('ORDER_BLOCK_SUPPORT_EMAIL') || readEnv('PAYMENT_FAILURE_SUPPORT_EMAIL'),
  // Admin address CC'd on the block email — same knob as the other admin
  // payment notifications (batch-summary + payment-failed).
  adminEmail: readEnv('CRON_ADMIN_EMAIL', { fallback: 'laviva2883@acoxs.com' }),
}
