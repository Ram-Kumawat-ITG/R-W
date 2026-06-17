// Job registry. Each job module exposes a register*Job function + its
// name. Add a new job here so the scheduler picks it up at boot.

import {
  registerProcessCommissionPayoutsJob,
  PROCESS_COMMISSION_PAYOUTS_JOB,
} from "./processCommissionPayouts.job";
import {
  registerProcessPayoutSettlementsJob,
  PROCESS_PAYOUT_SETTLEMENTS_JOB,
} from "./processPayoutSettlements.job";
import {
  registerProcessBillReconciliationJob,
  PROCESS_BILL_RECONCILIATION_JOB,
} from "./processBillReconciliation.job";

export const JOB_NAMES = {
  PROCESS_COMMISSION_PAYOUTS: PROCESS_COMMISSION_PAYOUTS_JOB,
  PROCESS_PAYOUT_SETTLEMENTS: PROCESS_PAYOUT_SETTLEMENTS_JOB,
  PROCESS_BILL_RECONCILIATION: PROCESS_BILL_RECONCILIATION_JOB,
};

export function registerJobs(agenda) {
  registerProcessCommissionPayoutsJob(agenda);
  registerProcessPayoutSettlementsJob(agenda);
  registerProcessBillReconciliationJob(agenda);
}
