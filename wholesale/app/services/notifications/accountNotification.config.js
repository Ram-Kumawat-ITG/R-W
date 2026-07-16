import { readEnv } from '../../utils/env.utils'

// Config for the account-lifecycle emails (Blocked/Revoked, Profile or
// Payment Method Updated) — see accountNotification.service.js.
export const accountNotificationConfig = {
  // Same shared admin-CC convention as applicationLifecycleNotification.config.js.
  adminEmail: readEnv('CRON_ADMIN_EMAIL', { fallback: 'laviva2883@acoxs.com' }),
  supportEmail: readEnv('WHOLESALE_SUPPORT_EMAIL'),
}
