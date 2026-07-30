import { readEnv } from '../../utils/env.utils'

// Config for the drop-ship fulfillment-sync admin alert email — see
// fulfillmentSyncNotification.service.js. Admin-only (no customer
// recipient, no CC pattern here — same shape as qboAlertNotification /
// nmiAlertNotification).
export const fulfillmentSyncNotificationConfig = {
  // Same shared admin-address convention as every other notification
  // module in this app (CRON_ADMIN_EMAIL) — one knob for "where admin
  // alerts go".
  adminEmail: readEnv('CRON_ADMIN_EMAIL', { fallback: 'laviva2883@acoxs.com' }),
}
