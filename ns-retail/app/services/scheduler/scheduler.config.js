// CDO commission-payout scheduler configuration.
//
// Production runs on a monthly cron (default 00:30 on the 25th). Dev/test
// uses a short interval override so the automated payout pipeline can be
// exercised without waiting for the 25th.
//
// All env reads go through readEnv (no raw process.env outside config).

import { readEnv, readBool } from "../../utils/env.utils";

export const schedulerConfig = {
  // IANA timezone the production cron is evaluated in.
  scheduleTimezone: readEnv("CDO_PAYOUT_TZ", { fallback: "America/Los_Angeles" }),

  // Production cron — default 00:30 on the 25th of every month. The payout
  // date is env-configurable today; a settings-driven schedule is a future
  // enhancement (see docs/payout.md §7).
  payoutCron: readEnv("CDO_PAYOUT_CRON", { fallback: "30 0 25 * *" }),

  // Dev-only override. When set, replaces the cron with an Agenda
  // "every <interval>" schedule, e.g.:
  //   CDO_PAYOUT_INTERVAL=3 minutes
  //   CDO_PAYOUT_INTERVAL=30 seconds
  // Leave unset in production.
  payoutIntervalOverride: readEnv("CDO_PAYOUT_INTERVAL"),

  // Hard kill switch — when true the scheduler never boots (entry.server
  // skips getAgenda()). Useful for one-off processes / migrations / tests.
  disabled: readBool("CDO_SCHEDULER_DISABLED", false),

  // Optional outbound alert webhook for failed payouts. Off by default —
  // nothing is POSTed externally unless this is set.
  alertWebhookUrl: readEnv("CDO_PAYOUT_ALERT_WEBHOOK_URL"),
};
