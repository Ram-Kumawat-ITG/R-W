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
import {
  registerProcessWholesaleFulfillmentReconcileJob,
  PROCESS_WHOLESALE_FULFILLMENT_RECONCILE_JOB,
} from "./processWholesaleFulfillmentReconcile.job";
import { registerSendEmailJob, SEND_EMAIL_JOB } from "./sendEmail.job";
import {
  registerSendRetailInvoiceEmailJob,
  SEND_RETAIL_INVOICE_EMAIL_JOB,
} from "./sendRetailInvoiceEmail.job";

export const JOB_NAMES = {
  PROCESS_COMMISSION_PAYOUTS: PROCESS_COMMISSION_PAYOUTS_JOB,
  PROCESS_PAYOUT_SETTLEMENTS: PROCESS_PAYOUT_SETTLEMENTS_JOB,
  PROCESS_BILL_RECONCILIATION: PROCESS_BILL_RECONCILIATION_JOB,
  PROCESS_WHOLESALE_FULFILLMENT_RECONCILE: PROCESS_WHOLESALE_FULFILLMENT_RECONCILE_JOB,
  SEND_EMAIL: SEND_EMAIL_JOB,
  SEND_RETAIL_INVOICE_EMAIL: SEND_RETAIL_INVOICE_EMAIL_JOB,
};

export function registerJobs(agenda) {
  registerProcessCommissionPayoutsJob(agenda);
  registerProcessPayoutSettlementsJob(agenda);
  registerProcessBillReconciliationJob(agenda);
  registerProcessWholesaleFulfillmentReconcileJob(agenda);
  registerSendEmailJob(agenda);
  registerSendRetailInvoiceEmailJob(agenda);
}
