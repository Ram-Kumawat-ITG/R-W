// Job registry. Each job module exposes a register*Job function + its
// name. Add a new job here so the scheduler picks it up at boot.

import {
  registerProcessCommissionPayoutsJob,
  PROCESS_COMMISSION_PAYOUTS_JOB,
} from "./processCommissionPayouts.job";

export const JOB_NAMES = {
  PROCESS_COMMISSION_PAYOUTS: PROCESS_COMMISSION_PAYOUTS_JOB,
};

export function registerJobs(agenda) {
  registerProcessCommissionPayoutsJob(agenda);
}
