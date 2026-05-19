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

// Project our normalized customer profile shape into QBO's customer payload.
// Throws if there's nothing usable to populate DisplayName — QBO requires it.
export function toCustomerPayload(profile) {
  const { firstName, lastName, companyName, email, phone, billingAddress } = profile
  const displayName =
    companyName?.trim() ||
    [firstName, lastName].filter(Boolean).join(' ').trim() ||
    email
  if (!displayName) throw new Error('Cannot create QBO customer without a name or email')

  const payload = {
    DisplayName: displayName,
    GivenName: firstName || undefined,
    FamilyName: lastName || undefined,
    CompanyName: companyName || undefined,
    PrimaryEmailAddr: email ? { Address: email } : undefined,
    PrimaryPhone: phone ? { FreeFormNumber: phone } : undefined,
  }
  if (billingAddress) {
    payload.BillAddr = {
      Line1: billingAddress.line1 || undefined,
      Line2: billingAddress.line2 || undefined,
      City: billingAddress.city || undefined,
      CountrySubDivisionCode: billingAddress.state || undefined,
      PostalCode: billingAddress.zip || undefined,
      Country: billingAddress.country || undefined,
    }
  }
  return payload
}

// Project an invoice line (our shape) into QBO's SalesItemLineDetail shape.
// `defaultItemId` is required because every QBO line must reference an Item.
export function toInvoiceLine(item, defaultItemId) {
  const amount = Number(item.amount)
  if (!Number.isFinite(amount)) {
    throw new Error(`Invoice line amount is not numeric: ${item.amount}`)
  }
  return {
    DetailType: 'SalesItemLineDetail',
    Amount: amount,
    Description: item.description || item.name || 'Item',
    SalesItemLineDetail: {
      ItemRef: { value: item.qboItemId || defaultItemId },
      Qty: item.quantity ?? 1,
      UnitPrice: item.unitPrice ?? amount,
    },
  }
}
