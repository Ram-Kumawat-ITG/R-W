// Configuration for the dedicated Drop-ship Payment CRON
// (`process-dropship-payments`). Kept in its own file (separate from
// dropship.config.js) so this feature's `process.env` reads stay isolated to
// a server-only module that is imported ONLY by the dropship-payment service +
// the scheduler — never by a route render path.
//
// SERVER-ONLY: reads process.env at init.
//
// The CRON collects every UNPAID drop-ship invoice (Invoice.isDropship=true,
// paymentStatus='pending') by charging a SINGLE configured NMI customer vault
// — the synthetic retail drop-ship customer has no per-registration vault.

import { readEnv } from '../../utils/env.utils'

export const dropshipPaymentConfig = {
  // The NMI customer vault charged for ALL drop-ship invoices. Provision one
  // vault (card on file) for the drop-ship account and put its id here. When
  // unset, the CRON skips every invoice with a clear "no DROPSHIP_NMI_VAULT_ID
  // configured" reason (recorded on the PaymentAttempt + a remark) — it never
  // silently no-ops.
  vaultId: readEnv('DROPSHIP_NMI_VAULT_ID'),

  // NOTE on NMI "Duplicate transaction" rejections: because every drop-ship
  // invoice charges the SAME shared vault, two distinct orders of the same
  // amount look identical to NMI's gateway-level duplicate check and the second
  // is rejected with "Duplicate transaction REFID:…". We CANNOT fix this from
  // code — this processor forbids the per-transaction `dup_seconds` override
  // ("Overriding Duplicate Threshold is not allowed for this processor",
  // code 300), so any attempt to pass it fails EVERY charge. The fix is
  // operational: in the NMI control panel adjust "Duplicate Transaction
  // Checking" for this MID — disable it, shorten the window, or set it to key
  // on order id (we send a unique `orderid` per order in `chargeCustomerVault`).

  // Production cron — "once per month" per the requirement. Default 00:30 on
  // the 1st of each month (in `timezone`). Fully overridable via
  // DROPSHIP_PAYMENT_CRON without a code change. Independent of the wholesale
  // payment cron (15th + last day).
  cron: readEnv('DROPSHIP_PAYMENT_CRON', { fallback: '30 0 1 * *' }),

  // Testing/dev override — replaces the cron with an Agenda "every <interval>"
  // schedule. Per the requirement the testing cadence is every 2 minutes:
  //   DROPSHIP_PAYMENT_INTERVAL="2 minutes"
  // Leave unset in production to fall back to the monthly `cron` above.
  intervalOverride: readEnv('DROPSHIP_PAYMENT_INTERVAL'),

  // Timezone for the cron — reuse the shared payment schedule tz.
  timezone: readEnv('PAYMENT_SCHEDULE_TZ', { fallback: 'America/Los_Angeles' }),
}
