// Job registry. Each job module exposes a register*Job function + its
// name. Add a new job here so the scheduler picks it up at boot.

import { registerProcessOrderJob, PROCESS_ORDER_JOB } from './processOrder.job'
import { registerProcessPendingPaymentsJob, PROCESS_PENDING_PAYMENTS_JOB } from './processPendingPayments.job'

export const JOB_NAMES = {
  PROCESS_ORDER: PROCESS_ORDER_JOB,
  PROCESS_PENDING_PAYMENTS: PROCESS_PENDING_PAYMENTS_JOB,
}

export function registerJobs(agenda) {
  registerProcessOrderJob(agenda)
  registerProcessPendingPaymentsJob(agenda)
}
