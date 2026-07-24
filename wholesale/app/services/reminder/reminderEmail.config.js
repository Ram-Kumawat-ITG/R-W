import { readEnv } from '../../utils/env.utils'

// Config for the SMTP check-payment reminder emails (First / Second /
// Final card-on-file / Recurring). Mirrors the other notification configs.
export const reminderEmailConfig = {
  // Support address shown in the email's "contact support" line. Falls back
  // to the shared payment-failure support address, then a generic phrase.
  supportEmail:
    readEnv('REMINDER_SUPPORT_EMAIL') || readEnv('PAYMENT_FAILURE_SUPPORT_EMAIL'),
  // Optional admin CC. OFF by default — reminders (esp. the recurring stage)
  // fire frequently, so we don't copy the admin on every one unless asked.
  adminEmail: readEnv('REMINDER_ADMIN_CC') || undefined,
}
