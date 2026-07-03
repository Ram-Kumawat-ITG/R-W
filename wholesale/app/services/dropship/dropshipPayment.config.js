// Configuration for drop-ship invoice collection. Kept in its own file
// (separate from dropship.config.js) so this feature's `process.env` reads
// stay isolated to a server-only module.
//
// SERVER-ONLY: reads process.env at init.
//
// Historically this backed a dedicated `process-dropship-payments` CRON that
// auto-charged a single configured NMI vault on a monthly schedule. That CRON
// was removed in favor of the manual Admin Order Batch Payment flow
// (/app/admin-orders/batch, services/adminOrderBatch/adminOrderBatch.service.js)
// — the admin now reviews unpaid drop-ship invoices and marks them paid via a
// cheque/bank-transfer reference instead of an automated NMI charge. `vaultId`
// is kept here because it's still used for the on-demand "Collect payment now"
// admin action (api/admin/retry-payment.js) on an individual drop-ship invoice.

import { readEnv } from '../../utils/env.utils'

export const dropshipPaymentConfig = {
  // The NMI customer vault used to collect an individual drop-ship invoice
  // on demand (admin "Collect payment now" action). Provision one vault
  // (card on file) for the drop-ship account and put its id here. When
  // unset, that action fails with a clear "no DROPSHIP_NMI_VAULT_ID
  // configured" reason rather than silently no-oping.
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
}
