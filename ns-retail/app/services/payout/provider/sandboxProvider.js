// Sandbox / mock disbursement provider.
//
// Deterministically simulates the ACH lifecycle (pending → settled, or
// pending → returned) entirely in-process, so the full payout settlement
// flow — initiate, poll, settle, return, retry — is testable without a real
// bank rail or any real money. The eventual outcome + the initiation time are
// encoded into the transferId, so getTransferStatus is self-contained and the
// signature matches a real provider (status from the id, not from our DB).
//
// Magic destination values (for QA — pick a test bank account number):
//   • account number ending "9999" → REJECTED at initiation (status "failed",
//     R03) — simulates a bad/closed account caught up front.
//   • account number ending "0000" → RETURNS (R01) after the settle delay —
//     simulates an NSF / failed credit discovered post-submission.
//   • anything else                → SETTLES after CDO_PAYOUT_SANDBOX_SETTLE_SECONDS.

import { payoutConfig } from "../payout.config";

const PREFIX = "sbx";

function outcomeFor(destination) {
  const acct = String(destination?.accountNumber || "").replace(/\D/g, "");
  if (acct.endsWith("9999")) return "reject";
  if (acct.endsWith("0000")) return "return";
  return "settle";
}

export const sandboxProvider = {
  name: "sandbox",

  // Initiate a transfer. Returns { transferId, status, [returnCode, returnReason] }.
  async initiateTransfer({ destination, idempotencyKey, reference } = {}) {
    const outcome = outcomeFor(destination);
    if (outcome === "reject") {
      return {
        transferId: null,
        status: "failed",
        returnCode: "R03",
        returnReason: "No account / unable to locate account (sandbox)",
      };
    }
    // base36 ms initiation time + outcome + a short tail from the idempotency
    // key so retries produce distinct ids. Fully decodable by getTransferStatus.
    const tail = String(idempotencyKey || reference || "x").replace(/[^a-z0-9]/gi, "").slice(-8);
    const token = `${PREFIX}_${Date.now().toString(36)}_${outcome}_${tail}`;
    return { transferId: token, status: "pending" };
  },

  // Poll a transfer's status. Returns { status, [returnCode, returnReason, settledAt] }.
  async getTransferStatus(transferId) {
    const parts = String(transferId || "").split("_");
    if (parts[0] !== PREFIX || parts.length < 3) {
      return { status: "failed", returnReason: "Unrecognized sandbox transfer id" };
    }
    const initiatedMs = parseInt(parts[1], 36);
    const outcome = parts[2];
    const elapsedSec = (Date.now() - initiatedMs) / 1000;
    if (!Number.isFinite(initiatedMs) || elapsedSec < payoutConfig.sandboxSettleSeconds) {
      return { status: "pending" };
    }
    if (outcome === "return") {
      return {
        status: "returned",
        returnCode: "R01",
        returnReason: "Insufficient funds (sandbox return)",
      };
    }
    return { status: "settled", settledAt: new Date() };
  },
};
