// Disbursement provider factory.
//
// Returns the configured PayoutProvider adapter. The payout-execution path
// (cdo.service.executeApprovedPayout) and the settlement poll
// (cdo.service.checkPayoutSettlement) talk ONLY to this interface, so adding
// a real rail is a single new adapter file — no changes to the payout logic.
//
// ── PayoutProvider adapter contract ──────────────────────────────────
//
//   name: string
//
//   initiateTransfer({
//     amount, currency,
//     destination: { accountName, routingNumber, accountNumber, accountType },
//     idempotencyKey,   // stable per attempt — provider must dedupe on this
//     reference,        // human ref (payout.reference)
//     metadata,         // { practitionerId, periodEnd, ... }
//   }) → {
//     transferId,                       // provider's id (null if rejected)
//     status: "pending" | "settled" | "failed",
//     returnCode?, returnReason?,       // when status === "failed"
//   }
//
//   getTransferStatus(transferId) → {
//     status: "pending" | "settled" | "returned" | "failed",
//     returnCode?, returnReason?, settledAt?,
//   }
//
//   processPendingTransfers?() → { advanced: boolean, skipped?: boolean }   (OPTIONAL)
//     Advance any provider-side transfers that need an explicit processing
//     trigger before they can settle. A no-op on real rails (production ACH
//     settles via the banking network). Implemented for TEST/sandbox envs that
//     require an API call to simulate settlement (Dwolla Sandbox's
//     `POST /sandbox-simulations` — the API form of the dashboard's
//     "Process Bank Transfers"), so the settlement CRON closes the loop with NO
//     manual dashboard step. The settlement sweep calls it once per tick before
//     polling; omit it and the sweep just polls.
//
// A real adapter (Dwolla / Stripe / Modern Treasury) implements exactly this
// surface — initiate an ACH credit, then report settlement. It MUST be
// idempotent on idempotencyKey so a retried initiation never double-sends.

import { payoutConfig } from "../payout.config";
import { sandboxProvider } from "./sandboxProvider";
import { dwollaProvider } from "./dwollaProvider";

export function getPayoutProvider() {
  switch (payoutConfig.provider) {
    case "sandbox":
      return sandboxProvider;
    case "dwolla":
      return dwollaProvider;
    case "stripe":
    case "modern_treasury":
      throw new Error(
        `CDO_PAYOUT_PROVIDER="${payoutConfig.provider}" is selected but no adapter is implemented yet. ` +
          `Add app/services/payout/provider/${payoutConfig.provider}Provider.js implementing the ` +
          `PayoutProvider contract (initiateTransfer / getTransferStatus) + its credentials, then register it here. ` +
          `See Commission.md §9.1.`,
      );
    default:
      throw new Error(`Unknown CDO_PAYOUT_PROVIDER: "${payoutConfig.provider}"`);
  }
}
