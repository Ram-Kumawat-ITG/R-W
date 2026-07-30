import { readEnv } from '../../utils/env.utils'

// Config for the NMI payment-processing/vault admin alert emails — see
// nmiAlertNotification.service.js. Admin-only, same shared-address
// convention as qboAlertNotification.config.js.
export const nmiAlertNotificationConfig = {
  adminEmail: readEnv('CRON_ADMIN_EMAIL', { fallback: 'laviva2883@acoxs.com' }),
}
