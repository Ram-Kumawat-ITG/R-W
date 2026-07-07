import { readEnv } from '../../utils/env.utils'

export const paymentFailureNotificationConfig = {
  // Support address surfaced in the "contact support" line of the email.
  // Falls back to the shared SMTP from-address if unset.
  supportEmail: readEnv('PAYMENT_FAILURE_SUPPORT_EMAIL'),
}
