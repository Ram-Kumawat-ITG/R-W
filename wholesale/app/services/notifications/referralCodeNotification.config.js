import { readEnv } from '../../utils/env.utils'

// Config for the Practitioner Portal referral-code lifecycle emails
// (Created / Paused / Resumed) — see referralCodeNotification.service.js.
export const referralCodeNotificationConfig = {
  // CC'd on every practitioner email in this module — same shared
  // admin-address convention as every other notification module in this
  // app (CRON_ADMIN_EMAIL).
  adminEmail: readEnv('CRON_ADMIN_EMAIL', { fallback: 'laviva2883@acoxs.com' }),
}
