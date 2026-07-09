import { readEnv } from '../../utils/env.utils'

// Config for the QBO/accounting-integration admin alert emails — see
// qboAlertNotification.service.js. Admin-only (no customer recipient, no
// CC pattern here — unlike applicationLifecycleNotification /
// accountNotification, these never go to a customer).
export const qboAlertNotificationConfig = {
  // Same shared admin-address convention as every other notification
  // module in this app (CRON_ADMIN_EMAIL) — one knob for "where admin
  // alerts go".
  adminEmail: readEnv('CRON_ADMIN_EMAIL', { fallback: 'laviva2883@acoxs.com' }),
}
