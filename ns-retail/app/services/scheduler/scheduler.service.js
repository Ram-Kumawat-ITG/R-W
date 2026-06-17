/* eslint-env node */
// Agenda lifecycle + recurring job registration for the CDO Program.
//
// One singleton per process. Concurrent first calls all await the same
// startPromise so we never have two Agenda instances on the same Mongo
// collection. Ported from the wholesale workspace's scheduler.service.

import Agenda from "agenda";
import { schedulerConfig } from "./scheduler.config";
import { payoutConfig } from "../payout/payout.config";
import { createLogger } from "../../utils/logger.utils";
import { registerJobs, JOB_NAMES } from "./jobs";

const log = createLogger("scheduler.service");

const MONGODB_URI = process.env.MONGODB_URI;

let agendaInstance = null;
let startPromise = null;

function buildAgenda() {
  // For fast dev intervals (e.g. CDO_PAYOUT_INTERVAL=30 seconds), Agenda's
  // default processEvery of 5s is fine. For minute-or-longer intervals we
  // tune down to reduce DB chatter.
  const processEvery = schedulerConfig.payoutIntervalOverride ? "5 seconds" : "1 minute";
  const agenda = new Agenda({
    // Dedicated collection — ns-retail shares the wholesale workspace's
    // MongoDB (see db/mongo.server.js), whose scheduler owns `agenda_jobs`.
    // Use our own collection so the two apps' job queues never collide.
    db: { address: MONGODB_URI, collection: "cdo_agenda_jobs" },
    processEvery,
    maxConcurrency: 5,
    defaultConcurrency: 2,
    defaultLockLifetime: 10 * 60 * 1000,
  });

  agenda.on("error", (err) => {
    console.error("[scheduler] error:", err.stack || err);
    log.error("agenda.error", { err });
  });
  agenda.on("start", (job) => log.info("job.start", { name: job.attrs.name }));
  agenda.on("success", (job) => log.info("job.success", { name: job.attrs.name }));
  agenda.on("fail", (err, job) => {
    console.error(`[scheduler] job ${job.attrs.name} failed:`, err.stack || err);
    log.error("job.fail", { name: job.attrs.name, err });
  });

  registerJobs(agenda);
  return agenda;
}

async function ensureRecurring(agenda) {
  // Dev override: CDO_PAYOUT_INTERVAL replaces the production cron with a
  // fast interval so the automated payout pipeline can be exercised
  // locally (the requirement: "every 3 minutes" in dev/test). Cancel the
  // production tick first so a switch from cron → interval doesn't leave
  // both registered.
  // ── Payout job (accrue → batch → [approve/execute]) ──
  if (schedulerConfig.payoutIntervalOverride) {
    await agenda.cancel({ name: JOB_NAMES.PROCESS_COMMISSION_PAYOUTS });
    await agenda.every(
      schedulerConfig.payoutIntervalOverride,
      JOB_NAMES.PROCESS_COMMISSION_PAYOUTS,
      { tick: "dev" },
    );
    log.info("scheduler.recurring_registered", {
      mode: "dev-interval",
      interval: schedulerConfig.payoutIntervalOverride,
    });
    console.log(
      `\n[scheduler] DEV MODE — process-commission-payouts running every ${schedulerConfig.payoutIntervalOverride}\n`,
    );
  } else {
    // Production: monthly cron from config (default 00:30 on the 25th).
    // `every` is idempotent on (interval, name) so re-running doesn't duplicate.
    await agenda.every(
      schedulerConfig.payoutCron,
      JOB_NAMES.PROCESS_COMMISSION_PAYOUTS,
      { tick: "monthly" },
      { timezone: schedulerConfig.scheduleTimezone },
    );
    log.info("scheduler.recurring_registered", {
      mode: "cron",
      timezone: schedulerConfig.scheduleTimezone,
      cron: schedulerConfig.payoutCron,
    });
  }

  // ── Settlement reconciliation job (poll provider for in-flight transfers) ──
  // Runs regardless of payout cadence so awaiting_settlement payouts always get
  // reconciled. Dev override mirrors the payout interval pattern.
  if (payoutConfig.settlementIntervalOverride) {
    await agenda.cancel({ name: JOB_NAMES.PROCESS_PAYOUT_SETTLEMENTS });
    await agenda.every(
      payoutConfig.settlementIntervalOverride,
      JOB_NAMES.PROCESS_PAYOUT_SETTLEMENTS,
      { tick: "dev" },
    );
    log.info("scheduler.settlement_registered", {
      mode: "dev-interval",
      interval: payoutConfig.settlementIntervalOverride,
    });
    console.log(
      `\n[scheduler] DEV MODE — process-payout-settlements running every ${payoutConfig.settlementIntervalOverride}\n`,
    );
  } else {
    await agenda.every(
      payoutConfig.settlementCron,
      JOB_NAMES.PROCESS_PAYOUT_SETTLEMENTS,
      { tick: "scheduled" },
      { timezone: schedulerConfig.scheduleTimezone },
    );
    log.info("scheduler.settlement_registered", {
      mode: "cron",
      timezone: schedulerConfig.scheduleTimezone,
      cron: payoutConfig.settlementCron,
    });
  }

  // ── Vendor-bill reconciliation job (mark retail bill paid once the mapped
  //    wholesale dropship invoice settles) ── Runs regardless of payout cadence
  //    so paid wholesale invoices always get reconciled. Dev override mirrors
  //    the payout/settlement interval pattern.
  if (schedulerConfig.billReconcileIntervalOverride) {
    await agenda.cancel({ name: JOB_NAMES.PROCESS_BILL_RECONCILIATION });
    await agenda.every(
      schedulerConfig.billReconcileIntervalOverride,
      JOB_NAMES.PROCESS_BILL_RECONCILIATION,
      { tick: "dev" },
    );
    log.info("scheduler.bill_reconcile_registered", {
      mode: "dev-interval",
      interval: schedulerConfig.billReconcileIntervalOverride,
    });
    console.log(
      `\n[scheduler] DEV MODE — reconcile-vendor-bills running every ${schedulerConfig.billReconcileIntervalOverride}\n`,
    );
  } else {
    await agenda.every(
      schedulerConfig.billReconcileCron,
      JOB_NAMES.PROCESS_BILL_RECONCILIATION,
      { tick: "scheduled" },
      { timezone: schedulerConfig.scheduleTimezone },
    );
    log.info("scheduler.bill_reconcile_registered", {
      mode: "cron",
      timezone: schedulerConfig.scheduleTimezone,
      cron: schedulerConfig.billReconcileCron,
    });
  }
}

export async function getAgenda() {
  if (agendaInstance) return agendaInstance;
  if (!startPromise) {
    startPromise = (async () => {
      const agenda = buildAgenda();
      await agenda.start();
      await ensureRecurring(agenda);
      agendaInstance = agenda;
      log.info("scheduler.started");
      return agenda;
    })().catch((err) => {
      startPromise = null;
      log.error("scheduler.start_failed", { err });
      throw err;
    });
  }
  return startPromise;
}

// Convenience for one-off enqueues (e.g. an admin "run payouts now" action).
export async function scheduleNow(jobName, data) {
  const agenda = await getAgenda();
  return agenda.now(jobName, data);
}

export { JOB_NAMES };

export async function shutdownAgenda() {
  if (agendaInstance) {
    await agendaInstance.stop();
    agendaInstance = null;
    startPromise = null;
  }
}
