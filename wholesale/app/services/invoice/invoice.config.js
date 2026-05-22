// Invoice service configuration. Currently just terms — kept in its own
// file so future additions (per-method terms, late-fee schedules, etc.)
// have a natural home.

import { readInt, readNumber } from '../../utils/env.utils'

export const invoiceConfig = {
  // Days from order date to invoice due date. Sent to QBO as `DueDate`
  // on createInvoice, which makes our value the source of truth and
  // overrides any customer-level `SalesTerm` configured in QBO.
  //
  // 15 is the wholesale default per project decision. Override via
  // INVOICE_TERMS_DAYS env var.
  termsDays: readInt('INVOICE_TERMS_DAYS', 15),

  // Processing-fee rates by settlement method. Decimal (0.03 = 3%).
  // The fee is decided per-settlement, not per-preference: an invoice
  // settled via card carries the card rate even if the customer's
  // preferred method was cheque (e.g. cheque → card admin fallback).
  // The fee line is appended to the QBO invoice at the moment the
  // payment is processed — see services/invoice/invoice.service.
  // propagateSuccessfulPayment and services/payment/payment.service.
  // chargeInvoice. Set any rate to 0 to disable for that method.
  //
  // Override via INVOICE_FEE_RATE_CARD / INVOICE_FEE_RATE_ACH /
  // INVOICE_FEE_RATE_CHECK env vars.
  processingFeeRates: {
    card: readNumber('INVOICE_FEE_RATE_CARD', 0.03),
    ach: readNumber('INVOICE_FEE_RATE_ACH', 0.01),
    check: readNumber('INVOICE_FEE_RATE_CHECK', 0),
  },
}
