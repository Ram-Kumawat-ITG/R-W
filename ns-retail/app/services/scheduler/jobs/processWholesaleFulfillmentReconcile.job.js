// Wholesale→Retail fulfillment reconciliation job (pull-based backstop).
//
// Sweeps drop-ship mappings whose WHOLESALE order is fulfilled but whose linked
// RETAIL order isn't, and fulfills the retail order in-process — reading the
// shared Mongo DB directly so it never depends on the wholesale→ns-retail HTTP
// push being reachable. All logic lives in
// services/sync/wholesaleFulfillmentReconcile.service; this module only brackets
// the run with logging.
//
// Cadence is environment-configurable (scheduler.config.js): production runs on
// CDO_FULFILLMENT_RECONCILE_CRON (default every 10 min); dev/test on
// CDO_FULFILLMENT_RECONCILE_INTERVAL (e.g. "1 minute"). concurrency:1 so two
// ticks never overlap (applyWholesaleFulfillment's open-FO check guards anyway).

import { reconcileWholesaleFulfillments } from "../../sync/wholesaleFulfillmentReconcile.service";
import { createLogger } from "../../../utils/logger.utils";

export const PROCESS_WHOLESALE_FULFILLMENT_RECONCILE_JOB =
  "reconcile-wholesale-fulfillments";
const log = createLogger("job.wholesale_fulfillment_reconcile");

export function registerProcessWholesaleFulfillmentReconcileJob(agenda) {
  agenda.define(
    PROCESS_WHOLESALE_FULFILLMENT_RECONCILE_JOB,
    { concurrency: 1, lockLifetime: 10 * 60 * 1000 },
    async (job) => {
      const tickId = String(job.attrs._id).slice(-6);
      log.info("tick.start", { tickId });
      try {
        const s = await reconcileWholesaleFulfillments({});
        // Only log to the console when something was actually reconciled, so a
        // healthy system doesn't spam the log every tick.
        if (s.fulfilled || s.delivered || s.errors) {
          console.log(
            `[ws-ffsync #${tickId}] checked=${s.checked} fulfilled=${s.fulfilled} ` +
              `delivered=${s.delivered} skipped=${s.skipped} errors=${s.errors}`,
          );
        }
        log.info("tick.done", { tickId, ...s });
      } catch (err) {
        console.error(`[ws-ffsync #${tickId}] FAILED:`, err?.stack || err);
        log.error("tick.failed", { tickId, err });
        throw err;
      }
    },
  );
}
