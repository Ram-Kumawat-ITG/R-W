// US states (50 + DC)
export const US_STATES = [
  { code: 'AL', name: 'Alabama' }, { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' }, { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' }, { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' }, { code: 'DE', name: 'Delaware' },
  { code: 'DC', name: 'District of Columbia' }, { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' }, { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' }, { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' }, { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' }, { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' }, { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' }, { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' }, { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' }, { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' }, { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' }, { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' }, { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' }, { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' }, { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' }, { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' }, { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' }, { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' }, { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' }, { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' }, { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' }, { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' },
]

export const COUNTRIES = ['United States', 'Canada', 'Mexico']

export const PROPERTY_TYPES = ['Residential', 'Commercial']

export const QEST4_SYSTEM_TYPES = ['QEST4 PRO', 'QEST4 Classic', 'QEST4 Lite', 'Other']

// Credentials grid (matches the HTML prototype's config)
export const CREDENTIALS = [
  { id: 'acupuncturist',          name: 'Acupuncturist (Cert./Licensed)', docs: [{ type: 'file', label: 'License or certificate' }] },
  { id: 'bio-energetic',          name: 'Bio-Energetic Practitioner',     docs: [
    { type: 'text', key: 'systemName',   label: 'System name',          placeholder: 'e.g., AvaSense, ZYTO', hint: 'Brand or name of system' },
    { type: 'text', key: 'systemSerial', label: 'System serial number', placeholder: 'Enter serial number' },
  ]},
  { id: 'chiropractor',           name: 'Chiropractor (DC)',              docs: [{ type: 'file', label: 'License' }] },
  { id: 'health-coach',           name: 'Health Coach (Certified)',       docs: [{ type: 'file', label: 'License or certificate' }] },
  { id: 'medical',                name: 'Licensed Medical Professional',  docs: [
    { type: 'text', key: 'professionalCredentials', label: 'Professional credentials', placeholder: 'e.g., MD, DO, RN, PA' },
    { type: 'file', label: 'License' },
  ]},
  { id: 'massage',                name: 'Licensed Massage Therapist',     docs: [{ type: 'file', label: 'License' }] },
  { id: 'naturopath-doctor',      name: 'Naturopathic Doctor (ND)',       docs: [{ type: 'file', label: 'License' }] },
  { id: 'nutritionist',           name: 'Nutritionist',                   docs: [{ type: 'file', label: 'License or certificate' }] },
  { id: 'qest4',                  name: 'QEST4 User',                     docs: [
    { type: 'text',   key: 'serialNumber', label: 'Serial number', placeholder: 'Enter QEST4 serial' },
    { type: 'select', key: 'systemType',   label: 'System type',   options: QEST4_SYSTEM_TYPES },
  ]},
  { id: 'reflexologist',          name: 'Reflexologist',                  docs: [{ type: 'file', label: 'License or certificate' }] },
  { id: 'traditional-naturopath', name: 'Traditional Naturopath',         docs: [{ type: 'file', label: 'Diploma' }] },
  { id: 'veterinarian',           name: 'Veterinarian (DVM)',             docs: [{ type: 'file', label: 'License' }] },
  { id: 'other',                  name: 'Other',                          docs: [
    { type: 'text', key: 'description', label: 'Describe your credentials', placeholder: 'e.g., Wellness coach, energy practitioner' },
    { type: 'file', label: 'Supporting document' },
  ]},
]

// Referral sources (matches HTML; "none" is mutually exclusive with the rest)
export const REFERRALS = [
  { id: 'ihha',         name: 'IHHA' },
  { id: 'qest4-ref',    name: 'QEST4',        field: { placeholder: 'Name of who referred you',        hint: 'List name of who referred you' } },
  { id: 'practitioner', name: 'Practitioner', field: { placeholder: 'e.g., Dr. Jane Smith',             hint: "List referred practitioner's name" } },
  { id: 'other-ref',    name: 'Other',        field: { placeholder: 'Tell us briefly where you heard',  hint: 'List referral source' } },
  { id: 'none',         name: 'None',         exclusive: true },
]

export const PAYMENT_METHODS = [
  { id: 'check', name: 'Check',              fee: null,    feeLabel: 'No fees', desc: 'Balances emailed 1st & 15th. Check due within 10 business days.' },
  { id: 'ach',   name: 'ACH / Bank transfer', fee: '1% fee', feeLabel: '1% fee', desc: 'Paid upon receipt of each invoice. No bi-monthly billing option.' },
  { id: 'card',  name: 'Credit card',         fee: '3% fee', feeLabel: '3% fee', desc: 'Card on file charged automatically. Most flexible option.' },
]

export const CARD_BRANDS = ['visa', 'mastercard', 'discover', 'amex', 'other']
export const CARD_BRAND_LABELS = {
  visa: 'Visa',
  mastercard: 'MasterCard',
  discover: 'Discover',
  amex: 'AMEX',
  other: 'Other',
}

export const TAX_ID_TYPES = ['ein', 'ssn']

export const MAX_FILE_SIZE = 20 * 1024 * 1024
export const ACCEPTED_FILE_TYPES = '.pdf,.jpg,.jpeg,.png'
export const ACCEPTED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
]
