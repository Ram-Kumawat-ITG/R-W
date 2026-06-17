// Retail Vendor Bill reconciliation job.
//
// Sweeps retail orders whose QBO vendor bill exists but hasn't been paid yet,
// and — for any whose mapped WHOLESALE dropship invoice has settled — records a
// Retail QBO BillPayment marking the bill Paid. All money/state transitions
// live in retailBillReconcile.service; this module only iterates the in-flight
// set and brackets the run with logging.
//
// Cadence is environment-configurable (scheduler.config.js): production runs on
// CDO_BILL_RECONCILE_CRON (default every 6h); dev/test on
// CDO_BILL_RECONCILE_INTERVAL (e.g. "2 minutes"). concurrency:1 so two ticks
// never overlap (and the per-order atomic claim guards even if they did).

import {
  listOrdersAwaitingBillReconcile,
  reconcileRetailVendorBillForOrder,
} from "../../retailQbo/retailBillReconcile.service";
import { createLogger } from "../../../utils/logger.utils";

export const PROCESS_BILL_RECONCILIATION_JOB = "reconcile-vendor-bills";
const log = createLogger("job.bill_reconciliation");

export function registerProcessBillReconciliationJob(agenda) {
  agenda.define(
    PROCESS_BILL_RECONCILIATION_JOB,
    { concurrency: 1, lockLifetime: 10 * 60 * 1000 },
    async (job) => {
      const tickId = String(job.attrs._id).slice(-6);
      log.info("tick.start", { tickId });

      let checked = 0;
      let paid = 0;
      let waiting = 0;
      let skipped = 0;
      let errors = 0;

      try {
        const rows = await listOrdersAwaitingBillReconcile({});
        for (const r of rows) {
          checked += 1;
          try {
            const res = await reconcileRetailVendorBillForOrder({
              shop: r.shop,
              shopifyOrderId: r.shopifyOrderId,
            });
            if (res.ok && (res.billPaymentId || res.reason === "bill_already_settled")) paid += 1;
            else if (res.reason === "wholesale_not_paid" || res.reason === "wholesale_invoice_pending")
              waiting += 1;
            else if (!res.ok) errors += 1;
            else skipped += 1;
          } catch (err) {
            // One order's failure never stops the sweep.
            errors += 1;
            log.error("reconcile.error", {
              shopifyOrderId: r.shopifyOrderId,
              err: err?.message || String(err),
            });
          }
        }

        if (checked > 0) {
          console.log(
            `[bill-reconcile #${tickId}] checked=${checked} paid=${paid} ` +
              `waiting=${waiting} skipped=${skipped} errors=${errors}`,
          );
        }
        log.info("tick.done", { tickId, checked, paid, waiting, skipped, errors });
      } catch (err) {
        console.error(`[bill-reconcile #${tickId}] FAILED:`, err?.stack || err);
        log.error("tick.failed", { tickId, err });
        throw err;
      }
    },
  );
}
