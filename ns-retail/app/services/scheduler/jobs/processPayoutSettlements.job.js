// CDO payout-settlement reconciliation job.
//
// Polls the disbursement provider for every payout in `awaiting_settlement`
// and applies the outcome (settle → paid, return/fail → failed, else leave).
// All money/state transitions live in cdo.service.checkPayoutSettlement; this
// module only sweeps the in-flight set and brackets the run with logging.
//
// Cadence is environment-configurable (payout.config.js): production runs on
// CDO_SETTLEMENT_CRON (default every 6h); dev/test on CDO_SETTLEMENT_INTERVAL
// (e.g. "1 minute"). concurrency:1 so two ticks never overlap.

import {
  listPayoutsAwaitingSettlement,
  checkPayoutSettlement,
} from "../../cdo/cdo.service";
import { createLogger } from "../../../utils/logger.utils";

export const PROCESS_PAYOUT_SETTLEMENTS_JOB = "process-payout-settlements";
const log = createLogger("job.payout_settlements");

export function registerProcessPayoutSettlementsJob(agenda) {
  agenda.define(
    PROCESS_PAYOUT_SETTLEMENTS_JOB,
    { concurrency: 1, lockLifetime: 10 * 60 * 1000 },
    async (job) => {
      const tickId = String(job.attrs._id).slice(-6);
      log.info("tick.start", { tickId });

      let checked = 0;
      let settled = 0;
      let returned = 0;
      let pending = 0;
      let errors = 0;

      try {
        const rows = await listPayoutsAwaitingSettlement();
        for (const r of rows) {
          checked += 1;
          try {
            const res = await checkPayoutSettlement(String(r._id), {
              actor: "system",
              source: "cron",
            });
            if (res.status === "paid") settled += 1;
            else if (res.status === "failed") returned += 1;
            else pending += 1;
          } catch (err) {
            // One payout's failure never stops the sweep.
            errors += 1;
            log.error("settlement.check_error", {
              payoutId: String(r._id),
              err: err?.message || String(err),
            });
          }
        }

        if (checked > 0) {
          console.log(
            `[payout-settlements #${tickId}] checked=${checked} settled=${settled} ` +
              `returned=${returned} pending=${pending} errors=${errors}`,
          );
        }
        log.info("tick.done", { tickId, checked, settled, returned, pending, errors });
      } catch (err) {
        console.error(`[payout-settlements #${tickId}] FAILED:`, err?.stack || err);
        log.error("tick.failed", { tickId, err });
        throw err;
      }
    },
  );
}
