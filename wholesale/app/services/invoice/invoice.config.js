// Invoice service configuration — terms, per-method due dates, and
// processing-fee rates. Kept in its own file so future additions
// (late-fee schedules, etc.) have a natural home.

import { readInt, readNumber } from '../../utils/env.utils'
import { computeDueDateForMethod } from './invoice.utils'

// Generic default terms (days) — the fallback used by any payment method
// that has no method-specific override configured below.
const DEFAULT_TERMS_DAYS = readInt('INVOICE_TERMS_DAYS', 15)

export const invoiceConfig = {
  // Days from order date to invoice due date. Sent to QBO as `DueDate`
  // on createInvoice, which makes our value the source of truth and
  // overrides any customer-level `SalesTerm` configured in QBO.
  //
  // 15 is the wholesale default per project decision. Override via
  // INVOICE_TERMS_DAYS env var. NOTE: this is the GENERIC fallback —
  // the active terms are selected PER PAYMENT METHOD via
  // `dueDaysByMethod` (see below) and resolved with `dueDaysForMethod`.
  termsDays: DEFAULT_TERMS_DAYS,

  // Per-payment-method due-date RULES (not a flat day-count — see
  // `computeDueDateForMethod` in invoice.utils.js for the actual math):
  //   - ach   → billing-cycle date: orders placed the 1st–15th are due the
  //     15th of that month; orders placed the 16th–end-of-month are due
  //     the last day of that month. Same rule as card. No env knob — this
  //     is a fixed business rule, not a day-count.
  //   - card  → billing-cycle date: orders placed the 1st–15th are due the
  //     15th of that month; orders placed the 16th–end-of-month are due
  //     the last day of that month. No env knob — this is a fixed
  //     business rule, not a day-count.
  //   - check → CHEQUE_DUE_DATE **business days** (Mon–Fri, no holiday
  //     calendar) after the order date. Default 10 (per the production
  //     requirement: "Check: 10 business days").
  // `dueDaysByMethod` below is only consulted as the generic calendar-day
  // fallback for methods with no dedicated rule above (currently just
  // `dropship`) — resolved via `dueDaysForMethod`.
  checkDueBusinessDays: readInt('CHEQUE_DUE_DATE', 10),

  dueDaysByMethod: {
    // Drop-ship — invoices for the retail drop-ship customer, collected by
    // the dedicated process-dropship-payments CRON (production: once per
    // month). The due window is independent of the wholesale terms; defaults
    // to INVOICE_TERMS_DAYS unless DROPSHIP_DUE_DATE is set.
    dropship: readInt('DROPSHIP_DUE_DATE', DEFAULT_TERMS_DAYS),
  },

  // Additional minutes added to the due date — primarily a TESTING aid
  // so admins can watch the Overdue indicator + cheque reminders fire
  // without waiting whole days. Drives the full-datetime `dueAt` field
  // on the Invoice doc; QBO's `DueDate` (date-only) still uses
  // `termsDays` rounded to the nearest day. Default 0 (no offset).
  // Set INVOICE_TERMS_MINUTES=1 to make every new invoice flag as
  // overdue ~1 minute after order creation.
  termsMinutes: readInt('INVOICE_TERMS_MINUTES', 0),

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
  // Immediate Payment is a card-based hosted charge, so it carries the
  // card-style rate by default (override via INVOICE_FEE_RATE_IMMEDIATE).
  // The fee is baked into the invoice at creation (like card) so the
  // hosted pay-link collects the full fee-inclusive outstanding amount.
  processingFeeRates: {
    card: readNumber('INVOICE_FEE_RATE_CARD', 0.03),
    ach: readNumber('INVOICE_FEE_RATE_ACH', 0.01),
    check: readNumber('INVOICE_FEE_RATE_CHECK', 0),
  },
}

// Resolve the due-date terms (days) for a given payment method, falling
// back to the generic INVOICE_TERMS_DAYS when the method is unknown or
// has no configured override. `paymentMethod` values are 'check' / 'ach'
// / 'card' (the locked Invoice.paymentMethod).
export function dueDaysForMethod(paymentMethod) {
  const byMethod = invoiceConfig.dueDaysByMethod
  const days = byMethod?.[paymentMethod]
  return Number.isFinite(days) ? days : invoiceConfig.termsDays
}

// Resolve { dueDate, dueAt } for an invoice given its locked payment
// method + order-date basis, per the production billing rules (see
// `dueDaysByMethod` comment above / `computeDueDateForMethod` in
// invoice.utils.js). This is the one call site every creation / realign
// path should use — it wires in the configured business-day count +
// testing `termsMinutes` offset so the rules stay centralized here.
export function resolveInvoiceDueDate(baseDate, paymentMethod) {
  return computeDueDateForMethod(baseDate, paymentMethod, {
    businessDays: invoiceConfig.checkDueBusinessDays,
    termsDays: dueDaysForMethod(paymentMethod),
    termsMinutes: invoiceConfig.termsMinutes,
  })
}
