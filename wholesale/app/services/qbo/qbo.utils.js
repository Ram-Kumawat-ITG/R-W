// QBO-specific helpers — pure transforms with no I/O.

// QBO query language uses single quotes; backslash-escape embedded ones.
export function escapeQboQuery(value) {
  return String(value).replace(/'/g, "\\'")
}

// Truncate noisy response bodies for logging without losing visibility.
export function truncate(s, max) {
  if (!s) return s
  return s.length > max ? `${s.slice(0, max)}… (+${s.length - max} chars)` : s
}

// Our own QBO `Payment` records never set PaymentMethodRef (qbo.service's
// recordPayment only writes CustomerRef/TotalAmt/PaymentRefNum/Line), so
// that field is always blank for wholesale-created payments. The actual
// method is recoverable from the PaymentRefNum shape: manual receipts are
// tagged `<kind>:<ref>` (e.g. "cheque:985210", "ach:TX123" — see
// invoice.service.recordManualPayment), while CRON/admin card+ACH charges
// via NMI store the bare numeric gateway transaction id. Shared by the QBO
// Dashboard and Transactions tabs so both render the same derived label.
export function derivePaymentMethod(paymentMethodRefName, paymentRef) {
  if (paymentMethodRefName) return paymentMethodRefName
  if (!paymentRef) return null
  const prefixed = /^(cheque|check|ach|card)\s*:/i.exec(paymentRef)
  if (prefixed) {
    const kind = prefixed[1].toLowerCase()
    if (kind === 'ach') return 'ACH'
    if (kind === 'card') return 'Card'
    return 'Cheque'
  }
  if (/^\d+$/.test(paymentRef)) return 'Card / ACH (NMI)'
  return null
}

// A QBO Payment's "linked transactions" are the invoices it pays.
export function linkedInvoiceIds(payment) {
  if (!Array.isArray(payment?.Line)) return []
  return payment.Line.flatMap((l) =>
    (l.LinkedTxn || [])
      .filter((t) => t.TxnType === 'Invoice')
      .map((t) => t.TxnId),
  )
}

// Project our normalized address shape into QBO's PhysicalAddress shape.
// Returns undefined when there's nothing usable so callers can omit the
// field from the payload entirely (QBO rejects empty address objects).
// Used for both BillAddr (on Customer) and ShipAddr (on Customer / Invoice).
export function toQboAddress(addr) {
  if (!addr) return undefined
  const line1 = addr.line1 || undefined
  const line2 = addr.line2 || undefined
  const city = addr.city || undefined
  const state = addr.state || undefined
  const zip = addr.zip || undefined
  const country = addr.country || undefined
  if (!line1 && !line2 && !city && !state && !zip && !country) return undefined
  return {
    Line1: line1,
    Line2: line2,
    City: city,
    CountrySubDivisionCode: state,
    PostalCode: zip,
    Country: country,
  }
}

// Project our normalized customer profile shape into QBO's customer payload.
// Throws if there's nothing usable to populate DisplayName — QBO requires it.
// QBO has no "tags" concept on a Customer, so the referral tag lives in the
// Customer's `Notes` field (internal, admin-visible — never shown to the
// customer). Managed as a single marked line so a merge can replace OUR line
// without touching whatever an accountant typed there. Same marker used on the
// invoice's PrivateNote.
export const REFERRAL_NOTE_PREFIX = 'Referral:'
// Matches our managed line INCLUDING its trailing newline, so removing a line
// from the middle of a note doesn't leave a blank gap behind. (Collapsing blank
// lines afterwards instead would also destroy paragraph breaks the accountant
// typed deliberately.)
const REFERRAL_NOTE_LINE = /^Referral:.*(?:\r?\n)?/gim
// QBO caps Customer.Notes at 2000 chars.
const QBO_NOTES_MAX = 2000

// Merge our referral line into an existing free-text note: strip any previous
// `Referral: …` line, keep everything else, append the new line (when there is
// one). Returns the merged string — '' when nothing remains.
export function mergeReferralNote(existingNote, referralNote) {
  const base = String(existingNote || '')
    .replace(REFERRAL_NOTE_LINE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const line = String(referralNote || '').trim()
  const merged = [base, line].filter(Boolean).join(base && line ? '\n' : '')
  return merged.length > QBO_NOTES_MAX ? merged.slice(0, QBO_NOTES_MAX) : merged
}

export function toCustomerPayload(profile) {
  const { firstName, lastName, companyName, email, phone, billingAddress } = profile
  const displayName =
    companyName?.trim() ||
    [firstName, lastName].filter(Boolean).join(' ').trim() ||
    email
  if (!displayName) throw new Error('Cannot create QBO customer without a name or email')

  return {
    DisplayName: displayName,
    GivenName: firstName || undefined,
    FamilyName: lastName || undefined,
    CompanyName: companyName || undefined,
    PrimaryEmailAddr: email ? { Address: email } : undefined,
    PrimaryPhone: phone ? { FreeFormNumber: phone } : undefined,
    BillAddr: toQboAddress(billingAddress),
    // Referral source, when the caller supplied one (profile.referralNote is
    // built by utils/referralTag.formatReferralNote). Omitted otherwise so we
    // never blank out an existing note.
    Notes: profile.referralNote ? mergeReferralNote('', profile.referralNote) : undefined,
  }
}

// Project an invoice line (our shape) into a QBO line.
// `defaultItemId` is required because every QBO SalesItemLine must reference
// an Item.
//
// Two line shapes are produced:
//   - kind === 'discount' → a QBO DiscountLineDetail line (no ItemRef). The
//     `amount` is POSITIVE; QBO subtracts it from the running subtotal. This
//     is how Shopify order-level / coupon / referral discounts are reflected
//     on the invoice so the QBO total matches Shopify's post-discount total.
//   - everything else      → a SalesItemLineDetail (products, shipping, tax,
//     processing fee).
// `taxCode` (optional) — a QBO TaxCode id ("TAX" / "NON" / a group id) set on
// the SalesItemLineDetail. Supplied only when the order carries tax; marking
// the line taxable is what makes QBO honor the TotalTax override (see
// qbo.service.createInvoice). Omitted → QBO applies the customer/company
// default (unchanged behavior for tax-free orders). No effect on discount lines.
export function toInvoiceLine(item, defaultItemId, taxCode) {
  const amount = Number(item.amount)
  if (!Number.isFinite(amount)) {
    throw new Error(`Invoice line amount is not numeric: ${item.amount}`)
  }
  if (item.kind === 'discount') {
    return {
      DetailType: 'DiscountLineDetail',
      Amount: amount,
      Description: item.description || 'Discount',
      DiscountLineDetail: { PercentBased: false },
    }
  }
  return {
    DetailType: 'SalesItemLineDetail',
    Amount: amount,
    Description: item.description || item.name || 'Item',
    SalesItemLineDetail: {
      ItemRef: { value: item.qboItemId || defaultItemId },
      Qty: item.quantity ?? 1,
      UnitPrice: item.unitPrice ?? amount,
      ...(taxCode ? { TaxCodeRef: { value: taxCode } } : {}),
    },
  }
}
