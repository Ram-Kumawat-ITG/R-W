// CDO commission-payout DISBURSEMENT configuration.
//
// Separate from scheduler.config.js (which owns cron cadence) — this owns
// the real-money disbursement concerns: which provider moves the funds, the
// human-approval gate, the settlement-reconciliation cadence, and the
// sandbox adapter's simulation knobs. All env reads go through readEnv (no
// raw process.env outside config).

import { readEnv, readBool, readInt, readNumber } from "../../utils/env.utils";

export const payoutConfig = {
  // ── Safety guard — transaction size ceiling (ACH / bank-transfer ONLY) ──
  // Never applies to check payouts — a human reviews, signs, and mails every
  // check, so there's no automated-runaway-transfer risk to guard against.
  // Used in two places against the same cap, both scoped to ACH-bound
  // commissions/payouts:
  //   1) Batch build (buildPayoutBatch) — resolves each practitioner group's
  //      payout method FIRST (preference + live banking probe), then runs a
  //      commission-level running total over ONLY the ACH-bound commissions
  //      (oldest-first). The first commission that would push that total past
  //      the ceiling stops inclusion outright — it and everything after it
  //      are deferred (left unreserved, no payoutId set) and picked up
  //      automatically by the next scheduled run. Check-bound groups are
  //      created in full regardless of amount. An ACH group whose own total
  //      alone exceeds the ceiling is deferred every run until an admin
  //      intervenes (raise the ceiling, or have the practitioner switch to
  //      check).
  //   2) Execution (executeApprovedPayout) — a final per-payout check, gated
  //      on `payout.method === "ach"`, right before the real bank→bank
  //      transfer is initiated, as defense-in-depth against a payout amount
  //      changing between batch build and execution. Blocks real-money edge
  //      cases — e.g. a data bug or a corrupted `amount` field causing a
  //      payout meant to be ~$10 to attempt to transfer $10,000 — by failing
  //      the payout (no transfer attempted) and firing the existing
  //      admin+practitioner failure alert.
  // Tune to comfortably exceed your largest expected legitimate single ACH
  // payout while still bounding how much money a single automated run can
  // wire-transfer.
  maxTransferAmount: readNumber("CDO_PAYOUT_MAX_TRANSFER_AMOUNT", 2000),
  // Disbursement provider that actually moves money bank→bank.
  //   "sandbox"          — in-process simulator (default; safe, no real money)
  //   "dwolla" | "stripe" | "modern_treasury" — real rails (adapter not yet
  //                        implemented; the factory throws a clear error until
  //                        its adapter + credentials are wired — see Commission.md §9.1)
  provider: readEnv("CDO_PAYOUT_PROVIDER", { fallback: "sandbox" }),

  // Require an explicit human approval before any real money moves. Default ON.
  // When true the automated CRON accrues + auto-approves commissions + builds
  // payouts that WAIT in `awaiting_approval` — an admin must Approve + Execute
  // to disburse. When false the CRON disburses end-to-end (legacy; risky with
  // real money).
  requireApproval: readBool("CDO_PAYOUT_REQUIRE_APPROVAL", false),

  // Settlement reconciliation cadence — how often we poll the provider for the
  // status of in-flight transfers (awaiting_settlement → paid / failed).
  // Production cron default: every 6 hours. Dev override: a short interval.
  settlementCron: readEnv("CDO_SETTLEMENT_CRON", { fallback: "0 */6 * * *" }),
  settlementIntervalOverride: readEnv("CDO_SETTLEMENT_INTERVAL"),

  // Flag a transfer as "stuck" if it hasn't settled after this many days
  // (surfaced for operator attention; ACH normally settles in 1–3 business days).
  settlementStuckDays: readInt("CDO_SETTLEMENT_STUCK_DAYS", 5),

  // ── Sandbox adapter knobs ──
  // How long (seconds) until a sandbox transfer transitions out of "pending".
  // Keep small in dev so the full lifecycle can be exercised quickly.
  sandboxSettleSeconds: readInt("CDO_PAYOUT_SANDBOX_SETTLE_SECONDS", 60),

  // ── Dwolla adapter (real ACH) ──
  // ACH payouts to practitioners. The business funds transfers from
  // `fundingSource` (a verified bank funding source on your Dwolla account);
  // each practitioner becomes a receive-only Customer with their bank as a
  // funding source. See app/services/payout/provider/dwollaProvider.js.
  dwolla: {
    environment: readEnv("DWOLLA_ENVIRONMENT", { fallback: "sandbox" }), // sandbox | production
    key: readEnv("DWOLLA_KEY"),
    secret: readEnv("DWOLLA_SECRET"),
    // The SOURCE (business) funding source — full URL or bare id. Money is
    // pulled from here and credited to the practitioner's bank.
    fundingSource: readEnv("DWOLLA_FUNDING_SOURCE"),
  },
};
