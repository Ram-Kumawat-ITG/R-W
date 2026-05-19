import { registerProcessOrderJob, PROCESS_ORDER_JOB } from './processOrder.job.server'
import { registerProcessPendingPaymentsJob, PROCESS_PENDING_PAYMENTS_JOB } from './processPendingPayments.job.server'

export const JOB_NAMES = {
  PROCESS_ORDER: PROCESS_ORDER_JOB,
  PROCESS_PENDING_PAYMENTS: PROCESS_PENDING_PAYMENTS_JOB,
}

export function registerJobs(agenda) {
  registerProcessOrderJob(agenda)
  registerProcessPendingPaymentsJob(agenda)
}
