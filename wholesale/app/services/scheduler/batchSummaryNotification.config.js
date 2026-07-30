import { readEnv } from '../../utils/env.utils'

export const batchSummaryNotificationConfig = {
  // Admin recipient for the post-tick "Batch Processing Summary" email.
  // Temporary placeholder per the project owner's request — swap via env
  // once a permanent address is decided, no code change needed.
  adminEmail: readEnv('CRON_ADMIN_EMAIL', { fallback: 'laviva2883@acoxs.com' }),
}
