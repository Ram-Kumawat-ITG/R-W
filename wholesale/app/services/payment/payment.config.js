// Payment orchestration configuration.
// Cron/interval scheduling lives in services/scheduler/scheduler.config.js —
// this file is about the payment behavior itself (charge timing, retry caps,
// HTTP retry tuning shared by QBO + NMI clients).

import { readEnv, readInt, readBool } from '../../utils/env.utils'

export const paymentConfig = {
  // Cap on NMI charge attempts before an invoice transitions to 'failed'.
  // After the cap, manual operator action is required to retry.
  maxRetryAttempts: readInt('PAYMENT_MAX_RETRY_ATTEMPTS', 6),
  // If true, the orchestrator attempts an immediate NMI charge right after
  // creating the QBO invoice. Recommended off in prod — let the scheduler
  // own all retry logic from a single place.
  chargeImmediately: readBool('PAYMENT_CHARGE_IMMEDIATELY', false),
  // HTTP-level retry tuning, shared by QBO + NMI HTTP clients.
  httpRetryAttempts: readInt('HTTP_RETRY_ATTEMPTS', 4),
  httpRetryBaseMs: readInt('HTTP_RETRY_BASE_MS', 500),
  httpRetryMaxMs: readInt('HTTP_RETRY_MAX_MS', 4000),
}
