// Configuration for the dedicated ACH Status Synchronization CRON
// (`process-ach-status-sync`). Kept in its own file so the feature is
// self-contained and all `process.env` reads stay inside a config module.

import { readEnv, readInt } from '../../utils/env.utils'

export const achSyncConfig = {
  // Production cron for the status-sync sweep. ACH settles in 1–3
  // business days, so a single daily reconciliation pass is plenty.
  // Default: once per day at 03:00 (in `timezone`). Fully overridable
  // via ACH_SYNC_CRON without a code change. This is INDEPENDENT of the
  // payment-retry cron (15th + last day) — status reconciliation runs on
  // its own cadence, decoupled from charging.
  cron: readEnv('ACH_SYNC_CRON', { fallback: '0 3 * * *' }),

  // Testing/dev override — replaces the cron with an Agenda "every
  // <interval>" schedule (e.g. ACH_SYNC_INTERVAL="1 minute") so ACH
  // status transitions can be validated rapidly. Leave unset in
  // production to fall back to the daily `cron` above.
  intervalOverride: readEnv('ACH_SYNC_INTERVAL'),

  // Timezone for the cron — reuse the shared payment schedule tz.
  timezone: readEnv('PAYMENT_SCHEDULE_TZ', { fallback: 'America/Los_Angeles' }),

  // Flag an awaiting-settlement invoice as "stuck" once it has been
  // in flight longer than this many days, and raise a (throttled) admin
  // alert. ACH normally settles within 1–3 business days.
  stuckAfterDays: readInt('ACH_SYNC_STUCK_DAYS', 5),

  // Optional outbound webhook for CRITICAL ACH alerts (returns / voids /
  // stuck transactions). OFF unless explicitly set — we never POST
  // payment data to an external endpoint by default; a deployment opts
  // in by configuring this URL. Alerts always go to the structured log
  // regardless of this setting.
  alertWebhookUrl: readEnv('ACH_ALERT_WEBHOOK_URL'),
}

// "Still settling" remark throttle — one progress note per invoice per
// day at most, so the Remarks panel doesn't flood during the normal
// 1–3 day wait window. The status check itself runs every tick.
export const STILL_PENDING_REMARK_THROTTLE_MS = 24 * 60 * 60 * 1000
