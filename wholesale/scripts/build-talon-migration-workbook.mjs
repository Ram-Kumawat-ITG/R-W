/* eslint-env node */
// One-off: transform the raw Talon Commerce export + Shopify customers export
// into the Practitioner Migration template workbook (docs/2Practitioner_Migration_FILLED.xlsx).
import * as XLSXModule from 'xlsx'
const XLSX = XLSXModule.default || XLSXModule
import fs from 'fs'

const DOCS = 'D:/projects/shopify-apps/natural-solutions/naturalsolutionsphc.com-Natural-Solution-App/docs'
const OUT = `${DOCS}/2Practitioner_Migration_FILLED.xlsx`

const blankVals = new Set(['', 'none', 'null', 'n/a', 'na', 'undefined'])
const val = (v) => {
  if (v === null || v === undefined) return ''
  const str = String(v).trim()
  return blankVals.has(str.toLowerCase()) ? '' : str
}
const isTrue = (v) => String(v).trim().toLowerCase() === 'true' || v === true

function readCsv(path) {
  const wb = XLSX.read(fs.readFileSync(path, 'utf8'), { type: 'string', raw: true })
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' })
}

// 1. Shopify customers: email -> full record (id + address + metafields).
// Used to (a) LINK via existing_shopify_customer_id, and (b) FALL BACK to
// Shopify data when the Talon export is missing a field.
const customers = readCsv(`${DOCS}/customers_export.csv`)
const emailToCustomer = new Map()
for (const c of customers) {
  const email = String(c['Email'] || '').trim().toLowerCase()
  if (!email) continue
  emailToCustomer.set(email, c)
}
const custId = (c) => (c ? String(c['Customer ID'] || '').replace(/^'/, '').trim() : '')
const cleanPhone = (v) => String(v || '').replace(/^'/, '').trim()

// 2. Talon rows
const talon = readCsv(`${DOCS}/practiitoner_applicaiton_telan_commerce.csv`)

const CREDS = [
  { id: 'acupuncturist', name: 'Acupuncturist', flag: 'Acupuncturist', fileCol: 'Acupuncturist-License' },
  { id: 'bio-energetic', name: 'Bio-Energetic Practitioner', flag: 'Bio-Energetic_Practitioner', d1: ['System name', 'Bio-System-Information'], d2: ['Serial number', 'Serial_Number'] },
  { id: 'chiropractor', name: 'Chiropractor', flag: 'Chiropractor', fileCol: 'ChiropractorLicense' },
  { id: 'health-coach', name: 'Health Coach', flag: 'HealthCoach', fileCol: 'Health-Coach-doc' },
  { id: 'medical', name: 'Licensed Medical Professional', flag: 'LicensedMedicalProfessional', fileCol: 'MedicalDoctorLicense', d1: ['Professional credentials', 'Professional-Credentials'] },
  { id: 'massage', name: 'Licensed Massage Therapist', flag: 'Licensed_Massage_Therapist', fileCol: 'Massage_Therapist_License' },
  { id: 'naturopath-doctor', name: 'Naturopathic Doctor', flag: 'NaturopathicDoctor', fileCol: 'Naturopathic-Doctor-License' },
  { id: 'nutritionist', name: 'Nutritionist', flag: 'Nutritionist', fileCol: 'Nutritionist-LicenseCert' },
  { id: 'qest4', name: 'QEST4 User', flag: 'QEST4_User', d1: ['Serial number', 'Q4_Serial_Number'], d2: ['System type', 'SystemType'] },
  { id: 'reflexologist', name: 'Reflexologist', flag: 'Reflexologist', fileCol: 'Reflex-License-Certificate' },
  { id: 'traditional-naturopath', name: 'Traditional Naturopath', flag: 'Traditional-Naturopath' },
  { id: 'veterinarian', name: 'Veterinarian', flag: 'Veterinarian', fileCol: 'Veterinarian-License' },
  { id: 'other', name: 'Other Credentials', flag: 'Other_Credientials', fileCol: 'Other_License_Certificate', d1: ['Description', 'Name_Other_Credientials'] },
]
const REFS = [
  { id: 'none', name: 'None', flag: 'Referred-None' },
  { id: 'ihha', name: 'IHHA', flag: 'Referred-IHHA' },
  { id: 'qest4-ref', name: 'QEST4', flag: 'Referred-Qest', detailCol: 'QEST4-Referral' },
  { id: 'practitioner', name: 'Practitioner', flag: 'Referred-Practitioner', detailCol: 'Other-Text' },
  { id: 'other-ref', name: 'Other', flag: 'Referred-Other', detailCol: 'Other-Text' },
]

const H_PRACT = ['row_id','talon_submission_id','match_status','first_name','last_name','email','phone','business_name','billing_line1','billing_line2','billing_city','billing_state','billing_zip','billing_country','shipping_same_as_billing','shipping_line1','shipping_line2','shipping_city','shipping_state','shipping_zip','shipping_country','shipping_property_type','resells_products','tax_id_type','tax_id','sales_permit','exempt_state','items_to_resell','business_activity','terms_accepted','subscribe_news','status','submitted_at','reviewed_at','blocked_at','existing_shopify_customer_id','referred_by_practitioner_email','talon_form_url','notes']
const H_CRED = ['row_id','practitioner_email','credential_id','credential_name','detail_label_1','detail_value_1','detail_label_2','detail_value_2','file_url','notes']
const H_REF = ['row_id','practitioner_email','referral_id','referral_name','detail_value','notes']

const practRows = [], credRows = [], refRows = [], payRows = []
const stats = { talonRows: talon.length, mapped: 0, dupEmail: 0, noEmail: 0, linkedToShopify: 0, credentialRows: 0, referralRows: 0,
  missingRequired: { first_name: 0, last_name: 0, phone: 0, billing_line1: 0, billing_city: 0, billing_state: 0, billing_zip: 0, shipping_property_type: 0 },
  notInSource: { tax_id_type: 0, tax_id: 0, exempt_state: 0, items_to_resell: 0, business_activity: 0 } }
const seen = new Set()
let rid = 0, cidn = 0, fidn = 0

for (const r of talon) {
  const email = String(r['email'] || '').trim().toLowerCase()
  if (!email) { stats.noEmail++; continue }
  if (seen.has(email)) { stats.dupEmail++; continue }
  seen.add(email)
  rid++; stats.mapped++

  const cust = emailToCustomer.get(email)
  const cid = custId(cust)
  if (cid) stats.linkedToShopify++
  // pick: Talon value first, else Shopify customer fallback
  const pick = (talonVal, custVal) => val(talonVal) || val(custVal)
  const countryOf = (v) => { const s = val(v); return /^us$/i.test(s) ? 'United States' : s }

  const sameAsBilling = isTrue(r['Yes_Same_As_Billing']) || (!isTrue(r['No_Same_As_Billing']) && !val(r['shipping-address']))
  const statusRaw = val(r['status']).toLowerCase()
  const status = ['pending','approved','rejected','blocked'].includes(statusRaw) ? statusRaw : 'approved'
  const propType = /commercial/i.test(val(r['Residental-Commercial'])) ? 'Commercial'
    : /residential/i.test(val(r['Residental-Commercial'])) ? 'Residential' : ''

  const phone = pick(cleanPhone(r['phoneNumber']), cust && (cleanPhone(cust['Phone']) || cleanPhone(cust['Default Address Phone'])))
  const bl1 = pick(r['addressLine1'], cust && cust['Default Address Address1'])
  const bcity = pick(r['addressCity'], cust && cust['Default Address City'])
  const bstate = pick(r['addressState'], cust && cust['Default Address Province Code'])
  const bzip = pick(r['addressZip'], cust && cust['Default Address Zip'])
  const bcountry = pick(r['addressCountry'], cust && countryOf(cust['Default Address Country Code']))
  const bizName = pick(r['addressCompany'], cust && cust['Default Address Company'])
  const bizActivity = pick('', cust && cust['Type of Business/Practice (customer.metafields.custom.type_of_businesspractice)'])

  for (const [f, v] of [['first_name',val(r['firstName'])],['last_name',val(r['lastName'])],['phone',phone],['billing_line1',bl1],['billing_city',bcity],['billing_state',bstate],['billing_zip',bzip]])
    if (!v) stats.missingRequired[f]++
  if (!propType) stats.missingRequired.shipping_property_type++
  stats.notInSource.tax_id_type++; stats.notInSource.tax_id++; stats.notInSource.exempt_state++; stats.notInSource.items_to_resell++
  if (!bizActivity) stats.notInSource.business_activity++

  practRows.push({
    row_id: rid, talon_submission_id: val(r['id']), match_status: 'NEW',
    first_name: val(r['firstName']), last_name: val(r['lastName']), email, phone,
    business_name: bizName,
    billing_line1: bl1, billing_line2: pick(r['addressLine2'], cust && cust['Default Address Address2']), billing_city: bcity,
    billing_state: bstate, billing_zip: bzip, billing_country: bcountry,
    shipping_same_as_billing: sameAsBilling ? 'TRUE' : 'FALSE',
    shipping_line1: sameAsBilling ? '' : val(r['shipping-address']), shipping_line2: sameAsBilling ? '' : val(r['Shipping-Address-Line-2']),
    shipping_city: sameAsBilling ? '' : val(r['ShippingCity']), shipping_state: sameAsBilling ? '' : val(r['State-Province']),
    shipping_zip: sameAsBilling ? '' : val(r['Shipping-Zip']), shipping_country: sameAsBilling ? '' : countryOf(r['shippingCountry']),
    shipping_property_type: propType, resells_products: '',
    tax_id_type: '', tax_id: '', sales_permit: '', exempt_state: '', items_to_resell: '', business_activity: bizActivity,
    terms_accepted: 'TRUE', subscribe_news: isTrue(r['acceptsMarketing']) ? 'TRUE' : 'FALSE', status,
    submitted_at: val(r['created']), reviewed_at: val(r['updated']), blocked_at: '',
    existing_shopify_customer_id: cid ? `gid://shopify/Customer/${cid}` : '',
    referred_by_practitioner_email: '', talon_form_url: '', notes: 'Migrated from Talon Commerce export' + (cust ? ' (enriched from Shopify customer)' : ''),
  })

  // Placeholder payment setup — default method "check", no card/bank data
  // (not available in any export). Importer sets needs_card_capture=true;
  // practitioner supplies their real method + details via the profile page.
  payRows.push({
    row_id: rid, practitioner_email: email, preferred_payment_method: 'check',
    cardholder_name: `${val(r['firstName'])} ${val(r['lastName'])}`.trim(),
    card_brand: '', card_last4: '', ach_account_name: '', ach_routing_number: '',
    ach_account_number: '', ach_account_type: '', needs_card_capture: 'TRUE',
    notes: 'Placeholder — practitioner to set real payment method/details via profile update',
  })

  for (const c of CREDS) {
    if (!isTrue(r[c.flag])) continue
    cidn++; stats.credentialRows++
    credRows.push({ row_id: cidn, practitioner_email: email, credential_id: c.id, credential_name: c.name,
      detail_label_1: c.d1 ? c.d1[0] : '', detail_value_1: c.d1 ? val(r[c.d1[1]]) : '',
      detail_label_2: c.d2 ? c.d2[0] : '', detail_value_2: c.d2 ? val(r[c.d2[1]]) : '',
      file_url: c.fileCol ? val(r[c.fileCol]) : '', notes: '' })
  }
  for (const rf of REFS) {
    if (!isTrue(r[rf.flag])) continue
    fidn++; stats.referralRows++
    refRows.push({ row_id: fidn, practitioner_email: email, referral_id: rf.id, referral_name: rf.name,
      detail_value: rf.detailCol ? val(r[rf.detailCol]) : '', notes: '' })
  }
}

function sheet(headers, rows) {
  const aoa = [headers, ...rows.map((o) => headers.map((h) => o[h] ?? ''))]
  return XLSX.utils.aoa_to_sheet(aoa)
}
const wb = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(wb, sheet(H_PRACT, practRows), 'Practitioners')
XLSX.utils.book_append_sheet(wb, sheet(H_CRED, credRows), 'Credentials')
XLSX.utils.book_append_sheet(wb, sheet(H_REF, refRows), 'Referral_Sources')
XLSX.utils.book_append_sheet(wb, sheet(['row_id','practitioner_email','preferred_payment_method','cardholder_name','card_brand','card_last4','ach_account_name','ach_routing_number','ach_account_number','ach_account_type','needs_card_capture','notes'], payRows), 'Payment_Setup')
XLSX.utils.book_append_sheet(wb, sheet(['row_id','practitioner_email','payout_method','bank_account_name','bank_routing_number','bank_account_number','bank_account_type','check_payable_to','check_use_billing_address','check_mailing_line1','check_mailing_line2','check_mailing_city','check_mailing_state','check_mailing_zip','check_mailing_country','notes'], []), 'Commission_Payout')
XLSX.utils.book_append_sheet(wb, sheet(['row_id','practitioner_email','legal_name','tax_classification','llc_classification','other_classification','exempt_payee_code','fatca_code','signature_type','signature_value_or_file_url','signed_at','notes'], []), 'W9_Tax_Certification')

const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
fs.writeFileSync(OUT, buf)
console.log('WROTE:', OUT)
stats.paymentRows = payRows.length
console.log(JSON.stringify(stats, null, 2))
