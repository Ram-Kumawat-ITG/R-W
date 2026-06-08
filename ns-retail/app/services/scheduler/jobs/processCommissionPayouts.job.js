// CDO commission-payout job.
//
// The thin Agenda wrapper around cdo.service.runAutomatedPayouts — the
// fully-automated lifecycle: accrue → auto-approve → batch → approve →
// execute (QBO Bill + BillPayment) → settle. All idempotency, pause/hold
// filtering, audit, and alerting live in the service; this module only
// brackets the run with structured logging and lets Agenda mark the tick.
//
// Cadence is set by the scheduler and is environment-configurable:
// production runs monthly (CDO_PAYOUT_CRON, default "30 0 25 * *" — 00:30
// on the 25th); dev/test runs on CDO_PAYOUT_INTERVAL (e.g. "3 minutes").
// concurrency:1 so two ticks never overlap.

import { runAutomatedPayouts } from "../../cdo/cdo.service";
import { createLogger } from "../../../utils/logger.utils";

export const PROCESS_COMMISSION_PAYOUTS_JOB = "process-commission-payouts";
const log = createLogger("job.commission_payouts");

export function registerProcessCommissionPayoutsJob(agenda) {
  agenda.define(
    PROCESS_COMMISSION_PAYOUTS_JOB,
    { concurrency: 1, lockLifetime: 15 * 60 * 1000 },
    async (job) => {
      const tick = job.attrs.data?.tick || "manual";
      const tickId = String(job.attrs._id).slice(-6);

      console.log(`\n┌─── [commission-payouts ${tick} #${tickId}] ${new Date().toISOString()}`);
      log.info("tick.start", { tick, tickId });

      try {
        const summary = await runAutomatedPayouts({ mode: "cron", trigger: tick });
        console.log(
          `└─── [commission-payouts #${tickId}] batch=${summary.reference} ` +
            `accrued=${summary.accrued} approved=${summary.approved} ` +
            `batched=${summary.batched} paid=${summary.paid} ` +
            `failed=${summary.failed} skipped=${summary.skipped}`,
        );
        log.info("tick.done", { tickId, ...summary });
      } catch (err) {
        // A whole-run failure (e.g. DB connect) is logged + rethrown so
        // Agenda marks the job failed; per-payout failures are isolated
        // inside the service and never reach here.
        console.error(`└─── [commission-payouts #${tickId}] FAILED:`, err?.stack || err);
        log.error("tick.failed", { tickId, err });
        throw err;
      }
    },
  );
}
