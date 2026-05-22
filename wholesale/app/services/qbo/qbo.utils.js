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
  }
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
