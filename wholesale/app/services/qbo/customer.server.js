import { qbo } from './client.server'
import { createLogger } from '../logger.server'

const log = createLogger('qbo.customer')

function escapeQboQuery(value) {
  // QBO query language uses single quotes; backslash-escape embedded ones.
  return String(value).replace(/'/g, "\\'")
}

export async function findCustomerByEmail(email) {
  if (!email) return null
  const stmt = `SELECT * FROM Customer WHERE PrimaryEmailAddr = '${escapeQboQuery(email)}' MAXRESULTS 1`
  const res = await qbo.query(stmt)
  const customer = res?.QueryResponse?.Customer?.[0]
  return customer || null
}

function toCustomerPayload(profile) {
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

export async function createCustomer(profile) {
  const payload = toCustomerPayload(profile)
  log.info('create.request', { displayName: payload.DisplayName })
  const res = await qbo.post('/customer', payload)
  const created = res?.Customer
  if (!created?.Id) {
    throw new Error('QBO customer create returned no Id')
  }
  log.info('create.success', { qboId: created.Id })
  return created
}

export async function findOrCreateCustomer(profile) {
  console.log(`\n[customers] QBO lookup for ${profile.email}`)
  const existing = await findCustomerByEmail(profile.email)
  if (existing) {
    console.log(`[customers] QBO match found — Id=${existing.Id} DisplayName="${existing.DisplayName}"`)
    log.info('found.existing', { qboId: existing.Id, email: profile.email })
    return { customer: existing, created: false }
  }
  console.log(`[customers] QBO no match — creating new customer`)
  const created = await createCustomer(profile)
  console.log(`[customers] QBO customer created Id=${created.Id} DisplayName="${created.DisplayName}"`)
  return { customer: created, created: true }
}
