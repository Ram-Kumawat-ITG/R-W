// Invoice service configuration. Currently just terms — kept in its own
// file so future additions (per-method terms, late-fee schedules, etc.)
// have a natural home.

import { readInt } from '../../utils/env.utils'

export const invoiceConfig = {
  // Days from order date to invoice due date. Sent to QBO as `DueDate`
  // on createInvoice, which makes our value the source of truth and
  // overrides any customer-level `SalesTerm` configured in QBO.
  //
  // 15 is the wholesale default per project decision. Override via
  // INVOICE_TERMS_DAYS env var.
  termsDays: readInt('INVOICE_TERMS_DAYS', 15),
}
