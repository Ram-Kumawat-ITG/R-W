import mongoose from 'mongoose'

// Append-only history of process-pending-payments CRON runs (the
// wholesale card/ACH auto-charge batch). One document is written per
// tick — by processPendingPayments.job.js, right after PASS 1/1.5/2
// complete — so the Orders page's "CRON Batch" section can show a
// history of what each scheduled run actually did.
//
// Distinct from Agenda's own `agenda_jobs` collection: Agenda persists
// only the LATEST run's timestamps per recurring job (each tick
// overwrites the same document), so it can answer "when does this run
// next" but not "what happened on every past run". This collection is
// the append-only log Agenda doesn't provide.
//
// Started 2026-07-06 — there is no historical backfill; batches run
// before this model existed are not represented here.
const cronBatchRunSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },

    jobName: { type: String, required: true, index: true },
    // Agenda's `data.tick` label for this run: 'primary' | 'secondary'
    // (production cron slots) | 'dev' (PAYMENT_RETRY_INTERVAL override)
    // | 'manual' (agenda.now / no tick data).
    tick: { type: String, default: 'manual' },
    // Last 6 chars of the Agenda job _id — cheap cross-reference to the
    // agenda_jobs collection for deeper debugging, not a foreign key.
    tickId: String,

    startedAt: { type: Date, required: true, index: true },
    finishedAt: { type: Date, required: true },
    durationMs: { type: Number, required: true },

    // Rolled up from the pass-level counts below:
    //   success — nothing errored/failed
    //   partial — some invoices succeeded, some errored/failed
    //   failed  — everything attempted errored/failed (and at least one was attempted)
    status: { type: String, enum: ['success', 'partial', 'failed'], required: true, index: true },

    // PASS 1 (card/ACH auto-charge) counts.
    totalInvoicesProcessed: { type: Number, default: 0 },
    totalApproved: { type: Number, default: 0 },
    totalDeclined: { type: Number, default: 0 },
    totalErrored: { type: Number, default: 0 },
    totalSkipped: { type: Number, default: 0 },
    // Sum of the outstanding (amountDue - amountPaid) amount attempted
    // across PASS 1's invoices — "how much money this batch tried to
    // collect", regardless of approve/decline outcome.
    totalInvoiceAmount: { type: Number, default: 0 },
    // Distinct customerEmail count among PASS 1's invoices — the
    // practitioners this batch actually attempted to charge.
    totalPractitioners: { type: Number, default: 0 },

    // PASS 1.5 (failed-invoice follow-up log) + PASS 2 (sync-retry) —
    // kept for completeness/debugging; not surfaced as headline numbers
    // in the UI but available on the batch detail.
    followupsLogged: { type: Number, default: 0 },
    sweepProcessed: { type: Number, default: 0 },
    sweepOk: { type: Number, default: 0 },
    sweepFailed: { type: Number, default: 0 },

    // Short human-readable rollup of what went wrong, e.g. "2 declined,
    // 1 errored (NMI timeout)". Empty for a clean run.
    errorSummary: { type: String, default: '' },
    // Capped detail list (first N) for admins who want specifics without
    // opening every invoice's remarks. Not exhaustive on a large batch.
    // Named `errorDetails`, NOT `errors` — Mongoose reserves `errors` as
    // a schema pathname (collides with document validation internals).
    errorDetails: [
      {
        _id: false,
        invoiceId: String,
        qboInvoiceId: String,
        message: String,
      },
    ],
  },
  { collection: 'cron_batch_runs', timestamps: true, strict: true },
)

export default mongoose.models.CronBatchRun ||
  mongoose.model('CronBatchRun', cronBatchRunSchema)
