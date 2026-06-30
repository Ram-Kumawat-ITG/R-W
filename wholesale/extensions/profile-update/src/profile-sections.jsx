// @ts-nocheck
/* global shopify */
// Practitioner profile-update form (Customer Account UI extension).
//
// Mirrors the registration form's data model: every field collected at
// signup is editable here, EXCEPT:
//   • email, password           → managed by Shopify's native account UI
//   • signature, termsAccepted  → one-time legal artifacts (W-9 signature
//                                  is its own field below — IRS requires
//                                  re-signing on every W-9 save)
//   • referrals                 → one-time "where did you hear about us"
//
// State model: the parent <ProfileSections> owns ONE big `form` object
// + a `pendingFiles` object. Sections are pure presentation — they read
// the slice they care about and call setters to update. A single Save
// button at the bottom builds the multipart payload once and POSTs to
// api.updateProfileWithFiles.
//
// The "Card on file" section is the one exception: card updates need
// Collect.js's iframe which the customer-account sandbox can't host,
// so that section opens a popup window and has its own action. The
// main Save button doesn't touch the card vault.

import { useEffect, useState } from 'preact/hooks'
import ApiService from '../../services/FullPageApi.jsx'

// ── Constants (mirror registration-form/src/constants.js) ──────────────

const TAX_ID_TYPES = [
  { value: 'ein', label: 'EIN (Employer Identification Number)' },
  { value: 'ssn', label: 'SSN (Social Security Number)' },
]

const PAYMENT_METHODS = [
  { value: 'check', label: 'Check', fee: 'No fees' },
  { value: 'ach', label: 'ACH / Bank transfer', fee: '1% fee' },
  { value: 'card', label: 'Credit card', fee: '3% fee' },
]

const TAX_CLASSIFICATIONS = [
  { value: 'individual', label: 'Individual / sole proprietor' },
  { value: 'c_corp', label: 'C Corporation' },
  { value: 's_corp', label: 'S Corporation' },  
  { value: 'partnership', label: 'Partnership' },
  { value: 'trust_estate', label: 'Trust / estate' },
  { value: 'llc', label: 'Limited liability company (LLC)' },
  { value: 'other', label: 'Other' },
]

const LLC_CLASSIFICATIONS = [
  { value: '', label: '—' },
  { value: 'C', label: 'C (C-Corp election)' },
  { value: 'S', label: 'S (S-Corp election)' },
  { value: 'P', label: 'P (Partnership)' },
]

const PROPERTY_TYPES = [
  { value: 'Residential', label: 'Residential' },
  { value: 'Commercial', label: 'Commercial' },
]

const QEST4_SYSTEM_TYPES = ['Bluetooth (Mobile)', 'Hardwire (Original)']

// Inlined to avoid pulling the registration-form data files across the
// extension boundary (Vite/esbuild can't traverse out of the extension
// root in the Customer Account UI sandbox). Mirrors registration-form/
// src/data/states.json — US only.
const US_STATES = [
  { code: 'AL', name: 'Alabama' }, { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' }, { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' }, { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' }, { code: 'DE', name: 'Delaware' },
  { code: 'FL', name: 'Florida' }, { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' }, { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' }, { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' }, { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' }, { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' }, { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' }, { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' }, { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' }, { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' }, { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' }, { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' }, { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' }, { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' }, { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' }, { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' }, { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' }, { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' }, { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' }, { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' }, { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' }, { code: 'WY', name: 'Wyoming' },
  { code: 'DC', name: 'District of Columbia' },
]

// Practitioner base is US-heavy; international addresses fall through to
// "Other" → free-text. Expand this list when you start onboarding more
// non-US territories.
const COUNTRIES = [
  'United States',
  'Canada',
  'Mexico',
  'United Kingdom',
  'Australia',
  'New Zealand',
  'Germany',
  'France',
  'Ireland',
  'Other',
]

// Mirrors registration-form/src/constants.js REFERRALS. Displayed read-only —
// "How did you hear about us?" is captured once at registration and not
// editable here (backend treats it as a one-time onboarding artifact).
const REFERRALS = [
  { id: 'ihha', label: 'IHHA' },
  { id: 'qest4-ref', label: 'QEST4', hasField: true },
  { id: 'practitioner', label: 'Practitioner', hasField: true },
  { id: 'other-ref', label: 'Other', hasField: true },
  { id: 'none', label: 'None' },
]

// Canonical credential list — mirrors registration-form/src/constants.js
// so a practitioner's selected credential (whatever it is) always renders
// here and its custom fields autofill from the saved profile.
const CREDENTIALS = [
  { id: 'acupuncturist', label: 'Acupuncturist (Cert./Licensed)', hasFile: true, fields: [] },
  {
    id: 'bio-energetic',
    label: 'Bio-Energetic Practitioner',
    hasFile: false,
    fields: [
      { key: 'systemName', label: 'System name', type: 'text' },
      { key: 'systemSerial', label: 'System serial number', type: 'text' },
    ],
  },
  { id: 'chiropractor', label: 'Chiropractor (DC)', hasFile: true, fields: [] },
  { id: 'health-coach', label: 'Health Coach (Certified)', hasFile: true, fields: [] },
  {
    id: 'medical',
    label: 'Licensed Medical Professional',
    hasFile: true,
    fields: [{ key: 'professionalCredentials', label: 'Credentials (MD, DO, RN, PA)', type: 'text' }],
  },
  { id: 'massage', label: 'Licensed Massage Therapist', hasFile: true, fields: [] },
  { id: 'naturopath-doctor', label: 'Naturopathic Doctor (ND)', hasFile: true, fields: [] },
  { id: 'nutritionist', label: 'Nutritionist', hasFile: true, fields: [] },
  {
    id: 'qest4',
    label: 'QEST4 User',
    hasFile: false,
    fields: [
      { key: 'serialNumber', label: 'Serial number', type: 'text' },
      { key: 'systemType', label: 'System type', type: 'select', options: QEST4_SYSTEM_TYPES },
    ],
  },
  { id: 'reflexologist', label: 'Reflexologist', hasFile: true, fields: [] },
  { id: 'traditional-naturopath', label: 'Traditional Naturopath', hasFile: true, fields: [] },
  { id: 'veterinarian', label: 'Veterinarian (DVM)', hasFile: true, fields: [] },
  {
    id: 'other',
    label: 'Other',
    hasFile: true,
    fields: [{ key: 'description', label: 'Describe your credentials', type: 'text' }],
  },
]

// ── Helpers ─────────────────────────────────────────────────────────────

async function getToken() {
  return await shopify?.sessionToken?.get()
}

// Derive the card network from the leading digits of a card number.
// Returns one of: 'visa' | 'mastercard' | 'amex' | 'discover' | 'jcb' |
// 'diners' | 'unionpay' | '' (unknown). Mirrors the rules in the
// PaymentCardForm of the registration flow so brand display stays
// consistent across the two surfaces.
function detectCardBrand(num) {
  const n = String(num || '').replace(/\D/g, '')
  if (!n) return ''
  if (/^4/.test(n)) return 'visa'
  if (/^(5[1-5]|2[2-7])/.test(n)) return 'mastercard'
  if (/^3[47]/.test(n)) return 'amex'
  if (/^(6011|65|64[4-9])/.test(n)) return 'discover'
  if (/^35/.test(n)) return 'jcb'
  if (/^(30[0-5]|36|38)/.test(n)) return 'diners'
  if (/^62/.test(n)) return 'unionpay'
  return ''
}

function isValidABA(routing) {
  if (!/^\d{9}$/.test(String(routing || ''))) return false
  const d = String(routing).split('').map(Number)
  const sum =
    3 * d[0] + 7 * d[1] + d[2] + 3 * d[3] + 7 * d[4] + d[5] + 3 * d[6] + 7 * d[7] + d[8]
  return sum % 10 === 0
}

// Build the initial form state from the masked profile fetched by the parent.
function initialForm(profile) {
  const p = profile || {}
  const billing = p.billingAddress || {}
  const shipping = p.shippingAddress || {}
  const tax = p.tax || {}
  const ach = p.payment?.ach || {}
  const commission = p.commission || {}
  const w9 = p.w9 || {}

  // Credentials: re-build the local shape from existing data so the
  // checkboxes start in the right state.
  const credentialsState = {}
  CREDENTIALS.forEach((c) => {
    const existing = (p.credentials || {})[c.id] || {}
    const fields = { selected: !!existing.selected }
    c.fields.forEach((f) => {
      fields[f.key] = existing[f.key] || existing.license?.[f.key] || ''
    })
    credentialsState[c.id] = fields
  })

  return {
    firstName: p.firstName || '',
    lastName: p.lastName || '',
    email: p.email || '',
    phone: p.phone || '',
    businessName: p.businessName || '',
    resellsProducts: p.resellsProducts !== false,
    credentials: credentialsState,
    billingAddress: {
      line1: billing.line1 || '',
      line2: billing.line2 || '',
      city: billing.city || '',
      state: billing.state || '',
      zip: billing.zip || '',
      country: billing.country || 'United States',
    },
    shippingSameAsBilling: p.shippingSameAsBilling !== false,
    shippingAddress: {
      line1: shipping.line1 || '',
      line2: shipping.line2 || '',
      city: shipping.city || '',
      state: shipping.state || '',
      zip: shipping.zip || '',
      country: shipping.country || 'United States',
    },
    shippingPropertyType: p.shippingPropertyType || 'Residential',
    tax: {
      taxIdType: tax.taxIdType || 'ein',
      taxId: tax.taxId || '',
      salesPermit: tax.salesPermit || '',
      exemptState: tax.exemptState || '',
      itemsToResell: tax.itemsToResell || '',
      businessActivity: tax.businessActivity || '',
    },
    payment: {
      method: p.payment?.method || 'check',
    },
    card: {
      // Display fields (pre-filled from current card on file)
      cardholderName: p.payment?.card?.cardholderName || '',
      cardBrand: p.payment?.card?.cardBrand || '',
      cardLast4: p.payment?.card?.cardLast4 || '',
      // Raw entry fields — start blank every time. ONLY sent to backend
      // on save; backend forwards to NMI and never persists raw values.
      cardNumber: '',
      cardExpiry: '',
      cardCvv: '',
    },
    ach: {
      achAccountName: ach.achAccountName || '',
      achRoutingNumber: ach.achRoutingNumber || '',
      achAccountNumber: '', // never pre-fill the full number
      achAccountLast4: ach.achAccountLast4 || '',
      achAccountType: ach.achAccountType || 'Checking',
    },
    commission: {
      enabled: commission.enabled ?? true,
      bankAccountName: commission.bankAccountName || '',
      bankRoutingNumber: commission.bankRoutingNumber || '',
      bankAccountNumber: '', // never pre-fill
      bankAccountLast4: commission.bankAccountLast4 || '',
      bankAccountType: commission.bankAccountType || 'Checking',
      sourcedFromPaymentAch: !!commission.sourcedFromPaymentAch,
    },
    w9: {
      legalName: w9.legalName || '',
      taxClassification: w9.taxClassification || '',
      llcClassification: w9.llcClassification || '',
      otherClassification: w9.otherClassification || '',
      exemptPayeeCode: w9.exemptPayeeCode || '',
      fatcaCode: w9.fatcaCode || '',
      typedSignature: '', // always blank — re-sign required on every save
    },
    subscribeNews: !!p.subscribeNews,
  }
}

// ── Section components (presentation) ──────────────────────────────────

function SectionHeader({ title, description }) {
  return (
    <s-stack direction="block" gap="small-300">
      <s-heading>{title}</s-heading>
      {description && <s-text color="subdued">{description}</s-text>}
    </s-stack>
  )
}

// Collapsible section wrapper. Replaces `<s-section>` + <SectionHeader />
// for every form section that the customer should be able to expand /
// collapse independently. The header (title + description + chevron) is
// a single clickable region — tap anywhere on it to toggle.
//
// `defaultOpen` controls the initial state. Only the first section
// (About you) opens by default; all others start collapsed so the
// customer can step through them at their own pace.
function Collapsible({ title, description, defaultOpen = false, children }) {
  const [open, setOpen] = useState(!!defaultOpen)
  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-clickable
          onclick={() => setOpen(!open)}
          background="transparent"
          padding="none"
          accessibilityLabel={open ? `Collapse ${title}` : `Expand ${title}`}
        >
          <s-stack
            direction="inline"
            justifyContent="space-between"
            alignItems="center"
            gap="base"
          >
            <s-stack direction="block" gap="small-300">
              <s-heading>{title}</s-heading>
              {description && <s-text color="subdued">{description}</s-text>}
            </s-stack>
            <s-text type="strong" color="subdued">
              {open ? '▲' : '▼'}
            </s-text>
          </s-stack>
        </s-clickable>
        {open && children}
      </s-stack>
    </s-section>
  )
}

// 1. About you — merged personal contact, business identity, and address
function PersonalAndAddressSection({ form, setForm, profile, errorMap = {} }) {
  // Helper to read a field's error from the validation map. The key in
  // errorMap matches the dotted path of the field (e.g. 'billingAddress.zip').
  const err = (k) => errorMap[k] || undefined
  function setBilling(patch) {
    setForm({ ...form, billingAddress: { ...form.billingAddress, ...patch } })
  }
  function setShipping(patch) {
    setForm({ ...form, shippingAddress: { ...form.shippingAddress, ...patch } })
  }
  return (
    <Collapsible
      title="About you"
      description="Your personal contact info, business identity, and address. Email is managed in your Shopify account settings."
      defaultOpen={true}
    >
      <s-stack direction="block" gap="large">
        {/* Personal */}
        <s-stack direction="block" gap="base">
          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            <s-text-field
              id="field-firstName"
              label="First name"
              value={form.firstName}
              oninput={(e) => setForm({ ...form, firstName: e.target.value })}
              autocomplete="given-name"
              maxLength={50}
              required
              error={err('firstName')}
            />
            <s-text-field
              id="field-lastName"
              label="Last name"
              value={form.lastName}
              oninput={(e) => setForm({ ...form, lastName: e.target.value })}
              autocomplete="family-name"
              maxLength={50}
              required
              error={err('lastName')}
            />
          </s-grid>
          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            <s-text-field label="Email" value={form.email} disabled />
            <s-text-field
              id="field-phone"
              label="Phone"
              placeholder="+15146669999"
              value={form.phone}
              oninput={(e) => setForm({ ...form, phone: e.target.value })}
              autocomplete="tel"
              inputMode="tel"
              maxLength={16}
              required
              error={err('phone')}
            />
          </s-grid>
        </s-stack>

        <s-divider />

        {/* Business — merged from the old standalone Business section */}
        <s-stack direction="block" gap="base">
          <s-text type="strong">Business</s-text>
          <s-text-field
            label="Business name"
            value={form.businessName}
            oninput={(e) => setForm({ ...form, businessName: e.target.value })}
          />
          <s-checkbox
            label="I resell products to my patients"
            accessibilityLabel="I resell products to my patients"
            checked={!!form.resellsProducts}
            onchange={(e) => setForm({ ...form, resellsProducts: e.target.checked })}
          />

          {/* Referrals — read-only display of how the practitioner heard
              about us (captured at registration, not editable here). */}
          <ReferralsReadOnly profile={profile} />
        </s-stack>

        <s-divider />

        {/* Billing address */}
        <s-stack direction="block" gap="base">
          <s-text type="strong">Billing address</s-text>
          <s-text-field
            id="field-billingAddress.line1"
            label="Street address"
            value={form.billingAddress.line1}
            oninput={(e) => setBilling({ line1: e.target.value })}
            required
            error={err('billingAddress.line1')}
          />
          <s-text-field
            label="Suite / apartment (optional)"
            value={form.billingAddress.line2}
            oninput={(e) => setBilling({ line2: e.target.value })}
          />
          <s-grid gridTemplateColumns="2fr 1fr 1fr" gap="base">
            <s-text-field
              id="field-billingAddress.city"
              label="City"
              value={form.billingAddress.city}
              oninput={(e) => setBilling({ city: e.target.value })}
              required
              error={err('billingAddress.city')}
            />
            <s-select
              id="field-billingAddress.state"
              label="State"
              value={form.billingAddress.state}
              onchange={(e) => setBilling({ state: e.target.value })}
              required
              error={err('billingAddress.state')}
            >
              <s-option value="">Select…</s-option>
              {US_STATES.map((s) => (
                <s-option key={s.code} value={s.code}>{s.name}</s-option>
              ))}
            </s-select>
            <s-text-field
              id="field-billingAddress.zip"
              label="ZIP"
              placeholder="90210"
              value={form.billingAddress.zip}
              oninput={(e) => setBilling({ zip: e.target.value })}
              autocomplete="postal-code"
              inputMode="numeric"
              maxLength={10}
              required
              error={err('billingAddress.zip')}
            />
          </s-grid>
          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            <s-select
              label="Country"
              value={form.billingAddress.country}
              onchange={(e) => setBilling({ country: e.target.value })}
            >
              {COUNTRIES.map((c) => (
                <s-option key={c} value={c}>{c}</s-option>
              ))}
            </s-select>
            <s-select
              label="Shipping property type"
              value={form.shippingPropertyType}
              onchange={(e) => setForm({ ...form, shippingPropertyType: e.target.value })}
            >
              {PROPERTY_TYPES.map((o) => (
                <s-option key={o.value} value={o.value}>{o.label}</s-option>
              ))}
            </s-select>
          </s-grid>

          <s-checkbox
            label="Shipping address is the same as billing"
            accessibilityLabel="Shipping address is the same as billing"
            checked={!!form.shippingSameAsBilling}
            onchange={(e) =>
              setForm({ ...form, shippingSameAsBilling: e.target.checked })
            }
          />
        </s-stack>

        {/* Shipping address — only when different from billing */}
        {!form.shippingSameAsBilling && (
          <>
            <s-divider />
            <s-stack direction="block" gap="base">
              <s-text type="strong">Shipping address</s-text>
              <s-text-field
                label="Street address"
                value={form.shippingAddress.line1}
                oninput={(e) => setShipping({ line1: e.target.value })}
              />
              <s-text-field
                label="Suite / apartment (optional)"
                value={form.shippingAddress.line2}
                oninput={(e) => setShipping({ line2: e.target.value })}
              />
              <s-grid gridTemplateColumns="2fr 1fr 1fr" gap="base">
                <s-text-field
                  label="City"
                  value={form.shippingAddress.city}
                  oninput={(e) => setShipping({ city: e.target.value })}
                />
                <s-select
                  label="State"
                  value={form.shippingAddress.state}
                  onchange={(e) => setShipping({ state: e.target.value })}
                >
                  <s-option value="">Select…</s-option>
                  {US_STATES.map((s) => (
                    <s-option key={s.code} value={s.code}>{s.name}</s-option>
                  ))}
                </s-select>
                <s-text-field
                  label="ZIP"
                  placeholder="90210"
                  value={form.shippingAddress.zip}
                  oninput={(e) => setShipping({ zip: e.target.value })}
                  autocomplete="postal-code"
                  inputMode="numeric"
                  maxLength={10}
                  required
                />
              </s-grid>
              <s-select
                label="Country"
                value={form.shippingAddress.country}
                onchange={(e) => setShipping({ country: e.target.value })}
              >
                {COUNTRIES.map((c) => (
                  <s-option key={c} value={c}>{c}</s-option>
                ))}
              </s-select>
            </s-stack>
          </>
        )}
      </s-stack>
    </Collapsible>
  )
}

// Read-only render of the registration-time "How did you hear about us?"
// answers. Shows each referral source as a disabled checkbox + the optional
// follow-up text (e.g. referring practitioner's name) when present.
function ReferralsReadOnly({ profile }) {
  const referrals = profile?.referrals || {}
  const anySelected = REFERRALS.some((r) => referrals[r.id]?.selected)
  if (!anySelected) return null
  return (
    <s-stack direction="block" gap="small-300">
      <s-text type="strong">How you heard about us</s-text>
      <s-text color="subdued">
        Captured during registration. Contact support if this needs to change.
      </s-text>
      <s-stack direction="block" gap="small-200">
        {REFERRALS.map((r) => {
          const entry = referrals[r.id] || {}
          if (!entry.selected) return null
          const display = `${r.label}${r.hasField && entry.value ? ` — ${entry.value}` : ''}`
          return (
            <s-checkbox
              key={r.id}
              label={display}
              accessibilityLabel={`Referral source on file: ${display}`}
              checked
              disabled
            />
          )
        })}
      </s-stack>
    </s-stack>
  )
}

// (BusinessSection merged into PersonalAndAddressSection above —
//  see the inserted business block between Personal and Billing sections.)
// eslint-disable-next-line no-unused-vars
function _UNUSED_BusinessSection({ form, setForm }) {
  return (
    <s-section>
      <SectionHeader title="Business" />
      <s-stack direction="block" gap="base">
        <s-text-field
          label="Business name"
          value={form.businessName}
          oninput={(e) => setForm({ ...form, businessName: e.target.value })}
        />
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-checkbox
            checked={!!form.resellsProducts}
            onchange={(e) => setForm({ ...form, resellsProducts: e.target.checked })}
          />
          <s-text>I resell products to my patients</s-text>
        </s-stack>
      </s-stack>
    </s-section>
  )
}

// 3. Credentials — list + file uploads
function CredentialsSection({ form, setForm, pendingFiles, setPendingFiles, profile }) {
  function updateCred(id, patch) {
    setForm({
      ...form,
      credentials: {
        ...form.credentials,
        [id]: { ...form.credentials[id], ...patch },
      },
    })
  }
  function pickFile(id, event) {
    const files = event?.target?.files || []
    const file = files[0]
    if (file) {
      setPendingFiles({
        ...pendingFiles,
        credentialFiles: { ...(pendingFiles.credentialFiles || {}), [id]: file },
      })
    }
  }
  const initial = profile?.credentials || {}

  // Split into selected (full cards with fields/dropzones) and unselected
  // (compact checkbox tiles). CSS Grid sets row-height = tallest cell, so
  // mixing them in one grid leaves big empty gaps under unchecked cards.
  // Two separate grids of uniform-height cells fixes that.
  const selected = CREDENTIALS.filter((c) => form.credentials[c.id]?.selected)
  const unselected = CREDENTIALS.filter((c) => !form.credentials[c.id]?.selected)

  function renderFullCard(c) {
    const s = form.credentials[c.id] || {}
    const existingUrl = initial[c.id]?.license?.fileUrl
    const newFile = pendingFiles.credentialFiles?.[c.id]
    return (
      <s-box key={c.id} padding="base" borderRadius="base" border="base">
        <s-stack direction="block" gap="small-400">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-checkbox
              checked
              onchange={(e) => updateCred(c.id, { selected: e.target.checked })}
            />
            <s-text type="strong">{c.label}</s-text>
          </s-stack>
          <s-stack direction="block" gap="small-300">
            {c.fields.map((f) =>
              f.type === 'select' ? (
                <s-select
                  key={f.key}
                  label={f.label}
                  value={s[f.key] || ''}
                  onchange={(e) => updateCred(c.id, { [f.key]: e.target.value })}
                >
                  <s-option value="">Select…</s-option>
                  {(f.options || []).map((opt) => (
                    <s-option key={opt} value={opt}>{opt}</s-option>
                  ))}
                </s-select>
              ) : (
                <s-text-field
                  key={f.key}
                  label={f.label}
                  value={s[f.key] || ''}
                  oninput={(e) => updateCred(c.id, { [f.key]: e.target.value })}
                />
              ),
            )}
            {c.hasFile && (
              <>
                {existingUrl && !newFile && (
                  <s-text color="subdued">
                    On file:{' '}
                    <s-link href={existingUrl} target="_blank">View</s-link>
                  </s-text>
                )}
                <s-drop-zone
                  label="Upload license document"
                  accept="image/*,application/pdf"
                  onchange={(e) => pickFile(c.id, e)}
                />
                {newFile && (
                  <s-text color="subdued">Staged: {newFile.name}</s-text>
                )}
              </>
            )}
          </s-stack>
        </s-stack>
      </s-box>
    )
  }

  // Compact "tap to add" tile — no border, no individual card chrome.
  // Reads as a checklist instead of a stack of card-sized boxes; matches
  // the registration form's `rf-checkbox-grid` density.
  function renderCompactTile(c) {
    return (
      <s-clickable
        key={c.id}
        onclick={() => updateCred(c.id, { selected: true })}
        background="transparent"
        padding="small-200"
        accessibilityLabel={`Add ${c.label}`}
      >
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-checkbox
            checked={false}
            onchange={(e) => updateCred(c.id, { selected: e.target.checked })}
          />
          <s-text>{c.label}</s-text>
        </s-stack>
      </s-clickable>
    )
  }

  return (
    <Collapsible
      title="Credentials & licenses"
      description="Your professional credentials. Upload a new file to replace what's on record."
    >
      <s-stack direction="block" gap="large">
        {selected.length > 0 && (
          <s-grid gridTemplateColumns="1fr 1fr" gap="base" alignItems="start">
            {selected.map(renderFullCard)}
          </s-grid>
        )}
        {unselected.length > 0 && (
          <s-stack direction="block" gap="small-200">
            {selected.length > 0 && (
              <s-text color="subdued">
                Other credentials — tap to add another to your record.
              </s-text>
            )}
            <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="small-200">
              {unselected.map(renderCompactTile)}
            </s-grid>
          </s-stack>
        )}
      </s-stack>
    </Collapsible>
  )
}

// (Address logic merged into PersonalAndAddressSection above)
// Keeping the helper functions in case of future split — but no
// standalone section component is rendered.
// eslint-disable-next-line no-unused-vars
function _UNUSED_AddressSection({ form, setForm }) {
  function setBilling(patch) {
    setForm({ ...form, billingAddress: { ...form.billingAddress, ...patch } })
  }
  function setShipping(patch) {
    setForm({ ...form, shippingAddress: { ...form.shippingAddress, ...patch } })
  }

  return (
    <s-section>
      <SectionHeader
        title="Address"
        description="Your business mailing address. Used on invoices and W-9 forms."
      />
      <s-stack direction="block" gap="base">
        <s-text type="strong">Billing address</s-text>
        <s-text-field
          label="Street address"
          value={form.billingAddress.line1}
          oninput={(e) => setBilling({ line1: e.target.value })}
        />
        <s-text-field
          label="Suite / apartment (optional)"
          value={form.billingAddress.line2}
          oninput={(e) => setBilling({ line2: e.target.value })}
        />
        <s-grid gridTemplateColumns="2fr 1fr 1fr" gap="base">
          <s-text-field
            label="City"
            value={form.billingAddress.city}
            oninput={(e) => setBilling({ city: e.target.value })}
          />
          <s-text-field
            label="State"
            value={form.billingAddress.state}
            oninput={(e) => setBilling({ state: e.target.value })}
          />
          <s-text-field
            label="ZIP"
            value={form.billingAddress.zip}
            oninput={(e) => setBilling({ zip: e.target.value })}
          />
        </s-grid>
        <s-text-field
          label="Country"
          value={form.billingAddress.country}
          oninput={(e) => setBilling({ country: e.target.value })}
        />

        <s-stack direction="inline" gap="small" alignItems="center">
          <s-checkbox
            checked={!!form.shippingSameAsBilling}
            onchange={(e) =>
              setForm({ ...form, shippingSameAsBilling: e.target.checked })
            }
          />
          <s-text>Shipping address is the same as billing</s-text>
        </s-stack>

        {!form.shippingSameAsBilling && (
          <>
            <s-text type="strong">Shipping address</s-text>
            <s-text-field
              label="Street address"
              value={form.shippingAddress.line1}
              oninput={(e) => setShipping({ line1: e.target.value })}
            />
            <s-text-field
              label="Suite / apartment (optional)"
              value={form.shippingAddress.line2}
              oninput={(e) => setShipping({ line2: e.target.value })}
            />
            <s-grid gridTemplateColumns="2fr 1fr 1fr" gap="base">
              <s-text-field
                label="City"
                value={form.shippingAddress.city}
                oninput={(e) => setShipping({ city: e.target.value })}
              />
              <s-text-field
                label="State"
                value={form.shippingAddress.state}
                oninput={(e) => setShipping({ state: e.target.value })}
              />
              <s-text-field
                label="ZIP"
                value={form.shippingAddress.zip}
                oninput={(e) => setShipping({ zip: e.target.value })}
              />
            </s-grid>
            <s-text-field
              label="Country"
              value={form.shippingAddress.country}
              oninput={(e) => setShipping({ country: e.target.value })}
            />
          </>
        )}

        <s-select
          label="Shipping property type"
          value={form.shippingPropertyType}
          onchange={(e) => setForm({ ...form, shippingPropertyType: e.target.value })}
        >
          {PROPERTY_TYPES.map((o) => (
            <s-option key={o.value} value={o.value}>{o.label}</s-option>
          ))}
        </s-select>
      </s-stack>
    </s-section>
  )
}

// 5. Tax info
function TaxSection({ form, setForm, errorMap = {} }) {
  const err = (k) => errorMap[k] || undefined
  function setTax(patch) {
    setForm({ ...form, tax: { ...form.tax, ...patch } })
  }
  // BUG-06: switching between EIN ↔ SSN must clear the prior value
  // (EIN format and SSN format are different — leaving the old value
  // in place causes silent validation pass on the wrong format).
  function changeTaxIdType(nextType) {
    if (nextType !== form.tax.taxIdType) {
      setTax({ taxIdType: nextType, taxId: '' })
    }
  }
  const isSsn = form.tax.taxIdType === 'ssn'
  return (
    <Collapsible title="Tax information">
      <s-stack direction="block" gap="base">
        <s-grid gridTemplateColumns="1fr 2fr" gap="base">
          <s-select
            label="Tax ID type"
            value={form.tax.taxIdType}
            onchange={(e) => changeTaxIdType(e.target.value)}
          >
            {TAX_ID_TYPES.map((o) => (
              <s-option key={o.value} value={o.value}>{o.label}</s-option>
            ))}
          </s-select>
          <s-text-field
            id="field-tax.taxId"
            label={isSsn ? 'SSN number' : 'EIN number'}
            placeholder={isSsn ? '123-45-6789' : '12-3456789'}
            value={form.tax.taxId}
            oninput={(e) => setTax({ taxId: e.target.value })}
            type="password"
            autocomplete="off"
            maxLength={11}
            required
            error={err('tax.taxId')}
          />
        </s-grid>
        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          <s-text-field
            label="Sales permit / resale certificate (optional)"
            value={form.tax.salesPermit}
            oninput={(e) => setTax({ salesPermit: e.target.value })}
          />
          <s-select
            id="field-tax.exemptState"
            label="Tax-exempt state"
            value={form.tax.exemptState}
            onchange={(e) => setTax({ exemptState: e.target.value })}
            required
            error={err('tax.exemptState')}
          >
            <s-option value="">Select…</s-option>
            {US_STATES.map((s) => (
              <s-option key={s.code} value={s.code}>{s.name}</s-option>
            ))}
          </s-select>
        </s-grid>
        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          <s-text-field
            id="field-tax.itemsToResell"
            label="Items you intend to resell"
            value={form.tax.itemsToResell}
            oninput={(e) => setTax({ itemsToResell: e.target.value })}
            required
            error={err('tax.itemsToResell')}
          />
          <s-text-field
            id="field-tax.businessActivity"
            label="Primary business activity"
            value={form.tax.businessActivity}
            oninput={(e) => setTax({ businessActivity: e.target.value })}
            required
            error={err('tax.businessActivity')}
          />
        </s-grid>
      </s-stack>
    </Collapsible>
  )
}

// 6. Payment method preference — 2-column selectable card grid
function PaymentMethodSection({ form, setForm }) {
  return (
    <Collapsible
      title="Payment method"
      description="Changing your preferred method realigns every open invoice's processing fee and due date."
    >
      <s-grid gridTemplateColumns="1fr 1fr" gap="base">
        {PAYMENT_METHODS.map((pm) => {
          const selected = form.payment.method === pm.value
          return (
            <s-clickable
              key={pm.value}
              accessibilityLabel={pm.label}
              onclick={() =>
                setForm({ ...form, payment: { ...form.payment, method: pm.value } })
              }
              background="transparent"
              padding="none"
            >
              <s-box
                padding="base"
                borderRadius="base"
                border={selected ? 'large strong' : 'base'}
                background={selected ? 'subdued' : 'transparent'}
              >
                <s-stack direction="block" gap="small-300">
                  <s-stack
                    direction="inline"
                    gap="small"
                    alignItems="center"
                    justifyContent="space-between"
                  >
                    <s-text type="strong">{pm.label}</s-text>
                    <s-badge tone={selected ? 'success' : 'neutral'}>{pm.fee}</s-badge>
                  </s-stack>
                </s-stack>
              </s-box>
            </s-clickable>
          )
        })}
      </s-grid>
    </Collapsible>
  )
}

// 7. Card on file — INLINE Polaris inputs, server-side tokenization
//
// PCI WARNING: card data flows from these s-text-field inputs through
// the Customer Account API → our backend → NMI's transact.php. This
// EXPANDS the app's PCI compliance scope (SAQ-D required instead of
// SAQ-A). The trade-off was chosen explicitly over the Collect.js
// popup approach. See profile.service.js for backend handling.
function CardSection({ form, setForm }) {
  const card = form.card || {}
  function setCard(patch) {
    setForm({ ...form, card: { ...form.card, ...patch } })
  }
  return (
    <Collapsible
      title="Card on file"
      description="Card data is sent securely to our payment processor on Save. Only the last 4 digits are stored on our servers."
    >
      <s-stack direction="block" gap="base">
        {card.cardLast4 ? (
          <s-text>
            Current card on file:{' '}
            <s-text type="strong">
              {card.cardBrand || 'Card'} ending in {card.cardLast4}
            </s-text>
            {card.cardholderName ? ` · ${card.cardholderName}` : ''}
          </s-text>
        ) : (
          <s-text color="subdued">
            No card on file yet. Enter new card details below.
          </s-text>
        )}

        <s-text-field
          label="Cardholder name"
          value={card.cardholderName || ''}
          oninput={(e) => setCard({ cardholderName: e.target.value })}
        />
        <s-text-field
          label={
            card.cardLast4
              ? 'New card number (leave blank to keep current card)'
              : 'Card number'
          }
          value={card.cardNumber || ''}
          oninput={(e) => {
            const digits = String(e.target.value).replace(/\D/g, '').slice(0, 19)
            // Re-derive brand on every keystroke so it always matches the
            // currently-typed number (not whatever brand was on file).
            const brand = detectCardBrand(digits)
            setCard({ cardNumber: digits, cardBrand: brand || card.cardBrand || '' })
          }}
          inputMode="numeric"
          autocomplete="cc-number"
        />
        {card.cardNumber && card.cardBrand && (
          <s-text color="subdued">
            Detected: <s-text type="strong">{card.cardBrand}</s-text>
          </s-text>
        )}
        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          <s-text-field
            label="Expiry (MMYY)"
            value={card.cardExpiry || ''}
            oninput={(e) =>
              setCard({ cardExpiry: String(e.target.value).replace(/\D/g, '').slice(0, 4) })
            }
            inputMode="numeric"
            autocomplete="cc-exp"
            placeholder="MMYY"
          />
          <s-text-field
            label="CVV"
            value={card.cardCvv || ''}
            oninput={(e) =>
              setCard({ cardCvv: String(e.target.value).replace(/\D/g, '').slice(0, 4) })
            }
            inputMode="numeric"
            autocomplete="cc-csc"
          />
        </s-grid>
      </s-stack>
    </Collapsible>
  )
}

// 8. ACH bank
function ACHSection({ form, setForm }) {
  function setAch(patch) {
    setForm({ ...form, ach: { ...form.ach, ...patch } })
  }
  const last4 = form.ach.achAccountLast4
  return (
    <Collapsible
      title="ACH bank account"
      description={
        last4
          ? `Currently on file: ending in ${last4}. Enter a new account number to replace it.`
          : 'No ACH bank account on file yet. Add one to enable ACH invoice settlement.'
      }
    >
      <s-stack direction="block" gap="base">
        <s-grid gridTemplateColumns="2fr 1fr" gap="base">
          <s-text-field
            label="Account holder name"
            value={form.ach.achAccountName}
            oninput={(e) => setAch({ achAccountName: e.target.value })}
          />
          <s-select
            label="Account type"
            value={form.ach.achAccountType}
            onchange={(e) => setAch({ achAccountType: e.target.value })}
          >
            <s-option value="Checking">Checking</s-option>
            <s-option value="Savings">Savings</s-option>
          </s-select>
        </s-grid>
        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          <s-text-field
            label="Routing number (9 digits)"
            placeholder="123456789"
            value={form.ach.achRoutingNumber}
            oninput={(e) =>
              setAch({ achRoutingNumber: String(e.target.value).replace(/\D/g, '') })
            }
            autocomplete="off"
            inputMode="numeric"
            maxLength={9}
          />
          <s-text-field
            label="Account number (leave blank to keep current)"
            value={form.ach.achAccountNumber}
            oninput={(e) =>
              setAch({ achAccountNumber: String(e.target.value).replace(/\D/g, '') })
            }
            type="password"
            autocomplete="off"
            inputMode="numeric"
            maxLength={17}
          />
        </s-grid>
      </s-stack>
    </Collapsible>
  )
}

// 9. Commission payout bank
function CommissionSection({ form, setForm }) {
  function setComm(patch) {
    setForm({ ...form, commission: { ...form.commission, ...patch } })
  }
  // When "use my ACH" is on, pre-fill the commission inputs from the ACH
  // section (read-only mirror). Lets the practitioner avoid re-typing the
  // same routing+last4 they already provided for invoice settlement.
  function toggleSourcedFromAch(useAch) {
    if (useAch) {
      setForm({
        ...form,
        commission: {
          ...form.commission,
          sourcedFromPaymentAch: true,
          bankAccountName: form.ach.achAccountName || form.commission.bankAccountName,
          bankRoutingNumber: form.ach.achRoutingNumber || form.commission.bankRoutingNumber,
          bankAccountType: form.ach.achAccountType || form.commission.bankAccountType,
          bankAccountLast4: form.ach.achAccountLast4 || form.commission.bankAccountLast4,
        },
      })
    } else {
      setComm({ sourcedFromPaymentAch: false })
    }
  }
  const last4 = form.commission.bankAccountLast4
  const fromAch = !!form.commission.sourcedFromPaymentAch
  const hasAchOnFile = !!form.ach.achAccountLast4
  return (
    <Collapsible
      title="Commission payout bank"
      description="Where we deposit your commission payouts. Different from your ACH payment account."
    >
      <s-stack direction="block" gap="base">
        <s-checkbox
          label="Enable commission payouts to this account"
          accessibilityLabel="Enable commission payouts to this account"
          checked={!!form.commission.enabled}
          onchange={(e) => setComm({ enabled: e.target.checked })}
        />

        {form.commission.enabled && (
          <>
            {hasAchOnFile && (
              <s-checkbox
                label="Use my ACH payment account for commission payouts"
                accessibilityLabel="Use my ACH payment account for commission payouts"
                checked={fromAch}
                onchange={(e) => toggleSourcedFromAch(e.target.checked)}
              />
            )}
            {last4 && (
              <s-text color="subdued">
                Currently on file: ending in <s-text type="strong">{last4}</s-text>.
              </s-text>
            )}
            <s-grid gridTemplateColumns="2fr 1fr" gap="base">
              <s-text-field
                label="Account holder name"
                value={form.commission.bankAccountName}
                disabled={fromAch}
                oninput={(e) => setComm({ bankAccountName: e.target.value })}
              />
              <s-select
                label="Account type"
                value={form.commission.bankAccountType}
                disabled={fromAch}
                onchange={(e) => setComm({ bankAccountType: e.target.value })}
              >
                <s-option value="Checking">Checking</s-option>
                <s-option value="Savings">Savings</s-option>
              </s-select>
            </s-grid>
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-text-field
                label="Routing number"
                placeholder="123456789"
                value={form.commission.bankRoutingNumber}
                disabled={fromAch}
                oninput={(e) =>
                  setComm({ bankRoutingNumber: String(e.target.value).replace(/\D/g, '') })
                }
                autocomplete="off"
                inputMode="numeric"
                maxLength={9}
              />
              <s-text-field
                label="Account number (leave blank to keep current)"
                type="password"
                autocomplete="off"
                inputMode="numeric"
                maxLength={17}
                value={form.commission.bankAccountNumber}
                disabled={fromAch}
                oninput={(e) =>
                  setComm({ bankAccountNumber: String(e.target.value).replace(/\D/g, '') })
                }
              />
            </s-grid>
          </>
        )}
      </s-stack>
    </Collapsible>
  )
}

// 10. W-9 form — typed signature only (sandbox has no <canvas>)
function W9Section({ form, setForm, profile, errorMap = {} }) {
  const err = (k) => errorMap[k] || undefined
  function setW9(patch) {
    setForm({ ...form, w9: { ...form.w9, ...patch } })
  }
  const sig = profile?.w9?.signature
  const sigUrl = sig?.type === 'drawn' && typeof sig.value === 'string' ? sig.value : ''
  const sigTyped = sig?.type === 'typed' ? sig.value : ''
  return (
    <Collapsible
      title="IRS Form W-9"
      description="A fresh signature is required on every W-9 save (IRS perjury statement)."
    >
      <s-stack direction="block" gap="base">
        {(sigUrl || sigTyped) && (
          <s-box padding="base" borderRadius="base" border="base">
            <s-stack direction="block" gap="small-300">
              <s-text type="strong">Signature on file</s-text>
              {sigUrl && (
                <s-link href={sigUrl} target="_blank">View saved signature</s-link>
              )}
              {sigTyped && <s-text>{sigTyped}</s-text>}
              <s-text color="subdued">
                Type your legal name below to re-sign and save changes.
              </s-text>
            </s-stack>
          </s-box>
        )}
        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          <s-text-field
            id="field-w9.legalName"
            label="Legal name (as on tax return)"
            value={form.w9.legalName}
            oninput={(e) => setW9({ legalName: e.target.value })}
            required
            error={err('w9.legalName')}
          />
          <s-select
            id="field-w9.taxClassification"
            label="Federal tax classification"
            value={form.w9.taxClassification}
            onchange={(e) => setW9({ taxClassification: e.target.value })}
            required
            error={err('w9.taxClassification')}
          >
            <s-option value="">Select classification…</s-option>
            {TAX_CLASSIFICATIONS.map((o) => (
              <s-option key={o.value} value={o.value}>{o.label}</s-option>
            ))}
          </s-select>
        </s-grid>

        {(form.w9.taxClassification === 'llc' ||
          form.w9.taxClassification === 'other') && (
          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            {form.w9.taxClassification === 'llc' && (
              <s-select
                id="field-w9.llcClassification"
                label="LLC tax classification"
                value={form.w9.llcClassification}
                onchange={(e) => setW9({ llcClassification: e.target.value })}
                required
                error={err('w9.llcClassification')}
              >
                {LLC_CLASSIFICATIONS.map((o) => (
                  <s-option key={o.value} value={o.value}>{o.label}</s-option>
                ))}
              </s-select>
            )}
            {form.w9.taxClassification === 'other' && (
              <s-text-field
                id="field-w9.otherClassification"
                label="Other classification (please specify)"
                value={form.w9.otherClassification}
                oninput={(e) => setW9({ otherClassification: e.target.value })}
                required
                error={err('w9.otherClassification')}
              />
            )}
          </s-grid>
        )}

        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          <s-text-field
            label="Exempt payee code (if any)"
            value={form.w9.exemptPayeeCode}
            oninput={(e) => setW9({ exemptPayeeCode: e.target.value })}
          />
          <s-text-field
            label="FATCA reporting exemption code (if any)"
            value={form.w9.fatcaCode}
            oninput={(e) => setW9({ fatcaCode: e.target.value })}
          />
        </s-grid>

        <s-box padding="base" borderRadius="base" background="subdued">
          <s-text>
            <s-text type="strong">Certification:</s-text> Under penalties of perjury, I
            certify that the information above is true, correct, and complete to the
            best of my knowledge. I am not subject to backup withholding except as
            indicated, and I am a U.S. person.
          </s-text>
        </s-box>
      </s-stack>
    </Collapsible>
  )
}

// (Communications merged into the save footer below — no standalone section.)

// ════════════════════════════════════════════════════════════════════════
// Parent orchestrator — owns ALL state + ONE Save button
// ════════════════════════════════════════════════════════════════════════
export function ProfileSections({ api, customerId, profile, onSaved }) {
  const [form, setForm] = useState(() => initialForm(profile))
  const [pendingFiles, setPendingFiles] = useState({ credentialFiles: {} })
  const [saveStatus, setSaveStatus] = useState('idle') // idle | saving | saved | error
  const [errorMsg, setErrorMsg] = useState('')
  const [errors, setErrors] = useState([])
  const [warnings, setWarnings] = useState([])
  // BUG-07/08: field-keyed error map. Each s-text-field reads its own
  // error via `error={errorMap['<path>']}` — Polaris s-text-field renders
  // the error styling + sets aria-invalid automatically when this is truthy.
  const [errorMap, setErrorMap] = useState({})
  const [realignSummary, setRealignSummary] = useState(null)

  // Re-sync local state when the server-side profile prop changes
  // (e.g., after a save the parent passes us the fresh masked profile).
  useEffect(() => {
    if (profile) setForm(initialForm(profile))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile])

  // BUG-14: Clear stale save banners (success/error) the moment the user
  // edits any field. Without this, a "Couldn't save" or "Saved" banner
  // sits on screen until the next save click, which makes the form feel
  // out of sync with what the user is currently doing.
  //
  // saveStatus === 'idle' on mount → no clear fires on initial setForm.
  // Only clears AFTER a save has resolved (saved/error), so 'saving'
  // is unaffected.
  useEffect(() => {
    if (saveStatus === 'saved' || saveStatus === 'error') {
      setSaveStatus('idle')
      setErrors([])
      setWarnings([])
      setErrorMap({})
      setErrorMsg('')
      setRealignSummary(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form])

  async function refreshProfile() {
    try {
      const token = await getToken()
      const res = await api.fetchProfile(token, customerId)
      if (res?.status === 'success' && res?.result) onSaved?.(res.result)
    } catch {
      /* best-effort */
    }
  }

  function buildPayload() {
    // Collect every section into a single payload mirroring what the
    // service's updateProfileApplication consumes.
    const payload = {
      personal: {
        firstName: form.firstName,
        lastName: form.lastName,
        phone: form.phone,
      },
      business: { businessName: form.businessName },
      credentials: form.credentials,
      address: {
        billingAddress: form.billingAddress,
        shippingSameAsBilling: form.shippingSameAsBilling,
        shippingAddress: form.shippingSameAsBilling ? null : form.shippingAddress,
        shippingPropertyType: form.shippingPropertyType,
      },
      resellsProducts: form.resellsProducts,
      tax: form.tax,
      payment: { method: form.payment.method },
      // Card section — only include raw card fields when the user actually
      // typed a new card number. cardholderName updates flow regardless.
      card: form.card.cardNumber
        ? {
            cardholderName: form.card.cardholderName,
            cardNumber: form.card.cardNumber,
            cardExpiry: form.card.cardExpiry,
            cardCvv: form.card.cardCvv,
            cardBrand: form.card.cardBrand, // optional hint
          }
        : form.card.cardholderName &&
            form.card.cardholderName !== profile?.payment?.card?.cardholderName
          ? { cardholderName: form.card.cardholderName }
          : undefined,
      ach: {
        achAccountName: form.ach.achAccountName,
        achRoutingNumber: form.ach.achRoutingNumber,
        achAccountType: form.ach.achAccountType,
        // Only send full account number when retyped.
        ...(form.ach.achAccountNumber
          ? {
              achAccountNumber: form.ach.achAccountNumber,
              achAccountLast4: form.ach.achAccountNumber.slice(-4),
            }
          : {}),
      },
      commission: {
        enabled: form.commission.enabled,
        sourcedFromPaymentAch: !!form.commission.sourcedFromPaymentAch,
        bankAccountName: form.commission.bankAccountName,
        bankRoutingNumber: form.commission.bankRoutingNumber,
        bankAccountType: form.commission.bankAccountType,
        ...(form.commission.bankAccountNumber
          ? { bankAccountNumber: form.commission.bankAccountNumber }
          : {}),
      },
      w9: {
        legalName: form.w9.legalName,
        taxClassification: form.w9.taxClassification,
        llcClassification:
          form.w9.taxClassification === 'llc' ? form.w9.llcClassification : '',
        otherClassification:
          form.w9.taxClassification === 'other' ? form.w9.otherClassification : '',
        exemptPayeeCode: form.w9.exemptPayeeCode,
        fatcaCode: form.w9.fatcaCode,
      },
      subscribeNews: form.subscribeNews,
    }
    return payload
  }

  function validate() {
    const out = []
    // BUG-07/08: Field-keyed error map. Both updated together with `out`
    // so the banner summary AND the per-field inline error stay in sync.
    // Keys use dotted paths matching s-text-field id="field-<path>".
    const map = {}
    const setErr = (field, message, section = field.split('.')[0]) => {
      if (!map[field]) map[field] = message
      out.push({ section, field, message })
    }

    // ── Validation rules MIRROR the registration form's Yup schemas at
    //    registration-form/src/schema/step{1,2,4}.schema.js. Cross-bundle
    //    import is impossible (Customer Account UI extension is a separate
    //    Web Worker bundle), so they're re-implemented in plain JS here.
    //    If you change a rule on either side, change it on the OTHER side too.
    //    Regex patterns are copy-pasted verbatim from step*.schema.js.

    const NAME_REGEX = /^[A-Za-zÀ-ÖØ-öø-ÿ' -]+$/
    const PHONE_REGEX = /^\+?[0-9]+$/

    // BUG-11: Field labels shown to the user MUST match the visible UI
    // labels, not the internal model keys (`line1`, `state`, etc.).
    const ADDR_LABELS = {
      line1: 'Street address',
      city: 'City',
      state: 'State',
      zip: 'ZIP',
      country: 'Country',
    }

    // ── Personal (step1) ──────────────────────────────────────────────
    if (!form.firstName?.trim()) {
      setErr('firstName', 'First name is required.', 'personal')
    } else if (form.firstName.trim().length < 3) {
      setErr('firstName', 'First name must be at least 3 characters.', 'personal')
    } else if (!NAME_REGEX.test(form.firstName.trim())) {
      setErr('firstName', 'Only letters, spaces, hyphens, and apostrophes.', 'personal')
    }
    if (!form.lastName?.trim()) {
      setErr('lastName', 'Last name is required.', 'personal')
    } else if (form.lastName.trim().length < 3) {
      setErr('lastName', 'Last name must be at least 3 characters.', 'personal')
    } else if (!NAME_REGEX.test(form.lastName.trim())) {
      setErr('lastName', 'Only letters, spaces, hyphens, and apostrophes.', 'personal')
    }
    if (!form.phone?.trim()) {
      setErr('phone', 'Phone number is required.', 'personal')
    } else if (!PHONE_REGEX.test(form.phone.trim())) {
      setErr('phone', "Only digits and optional '+' at start (e.g., +15146669999).", 'personal')
    } else {
      const digits = String(form.phone).replace(/\D/g, '')
      if (digits.length < 11 || digits.length > 15) {
        setErr(
          'phone',
          'Phone must include country code (e.g., +15146669999 for US).',
          'personal',
        )
      }
    }

    // ── Address (step2) ───────────────────────────────────────────────
    const billingRequired = ['line1', 'city', 'state', 'zip', 'country']
    for (const k of billingRequired) {
      if (!form.billingAddress?.[k]?.trim()) {
        setErr(
          `billingAddress.${k}`,
          `${ADDR_LABELS[k]} is required.`,
          'address',
        )
      }
    }
    if (form.billingAddress?.country === 'United States' && form.billingAddress?.zip) {
      if (!/^\d{5}(-\d{4})?$/.test(form.billingAddress.zip.trim())) {
        setErr(
          'billingAddress.zip',
          'Enter a valid US ZIP (e.g. 90210 or 90210-1234).',
          'address',
        )
      }
    }
    if (!form.shippingSameAsBilling) {
      for (const k of billingRequired) {
        if (!form.shippingAddress?.[k]?.trim()) {
          setErr(
            `shippingAddress.${k}`,
            `Shipping ${ADDR_LABELS[k]} is required.`,
            'address',
          )
        }
      }
      if (form.shippingAddress?.country === 'United States' && form.shippingAddress?.zip) {
        if (!/^\d{5}(-\d{4})?$/.test(form.shippingAddress.zip.trim())) {
          setErr(
            'shippingAddress.zip',
            'Enter a valid US shipping ZIP (e.g. 90210).',
            'address',
          )
        }
      }
    }
    if (!form.shippingPropertyType || !['Residential', 'Commercial'].includes(form.shippingPropertyType)) {
      out.push({ section: 'address', message: 'Select a shipping property type.' })
    }

    // ── Tax (step2.tax) ───────────────────────────────────────────────
    if (!['ein', 'ssn'].includes(form.tax?.taxIdType)) {
      setErr('tax.taxIdType', 'Select a tax ID type.', 'tax')
    }
    if (!form.tax?.taxId?.trim()) {
      setErr('tax.taxId', 'Tax ID is required.', 'tax')
    } else if (form.tax.taxIdType === 'ein' && !/^\d{2}-?\d{7}$/.test(form.tax.taxId.trim())) {
      setErr('tax.taxId', 'Enter a valid 9-digit EIN (e.g. 12-3456789).', 'tax')
    } else if (form.tax.taxIdType === 'ssn' && !/^\d{3}-?\d{2}-?\d{4}$/.test(form.tax.taxId.trim())) {
      setErr('tax.taxId', 'Enter a valid 9-digit SSN (e.g. 123-45-6789).', 'tax')
    }
    if (!form.tax?.exemptState?.trim()) {
      setErr('tax.exemptState', 'Tax-exempt state is required.', 'tax')
    }
    if (!form.tax?.itemsToResell?.trim()) {
      setErr('tax.itemsToResell', 'Items to resell are required.', 'tax')
    }
    if (!form.tax?.businessActivity?.trim()) {
      setErr('tax.businessActivity', 'Business activity is required.', 'tax')
    }

    // ── ACH (step3) ───────────────────────────────────────────────────
    if (form.ach.achRoutingNumber && !isValidABA(form.ach.achRoutingNumber)) {
      out.push({ section: 'ach', message: 'ACH routing number failed checksum.' })
    }
    if (form.ach.achAccountNumber) {
      const acct = String(form.ach.achAccountNumber).replace(/\D/g, '')
      if (acct.length < 4 || acct.length > 17) {
        out.push({ section: 'ach', message: 'ACH account number must be 4–17 digits.' })
      }
    }

    // ── Card (step3) — only when user typed a new card ────────────────
    if (form.card.cardNumber) {
      const digits = String(form.card.cardNumber).replace(/\D/g, '')
      if (digits.length < 12 || digits.length > 19) {
        out.push({ section: 'card', message: 'Card number must be 12–19 digits.' })
      }
      const exp = String(form.card.cardExpiry || '').replace(/\D/g, '')
      if (exp.length !== 4) {
        out.push({ section: 'card', message: 'Expiry must be in MMYY format.' })
      } else {
        const mm = Number.parseInt(exp.slice(0, 2), 10)
        if (mm < 1 || mm > 12) {
          out.push({ section: 'card', message: 'Expiry month must be 01–12.' })
        }
      }
      const cvv = String(form.card.cardCvv || '').replace(/\D/g, '')
      if (cvv.length < 3 || cvv.length > 4) {
        out.push({ section: 'card', message: 'CVV must be 3 or 4 digits.' })
      }
    }

    // ── Commission (step3 ish) ────────────────────────────────────────
    if (
      form.commission.enabled &&
      form.commission.bankRoutingNumber &&
      !isValidABA(form.commission.bankRoutingNumber)
    ) {
      out.push({ section: 'commission', message: 'Commission routing number failed checksum.' })
    }
    if (form.commission.enabled && form.commission.bankAccountNumber) {
      const acct = String(form.commission.bankAccountNumber).replace(/\D/g, '')
      if (acct.length < 4 || acct.length > 17) {
        out.push({ section: 'commission', message: 'Commission account number must be 4–17 digits.' })
      }
    }

    // ── W-9 (step4) ───────────────────────────────────────────────────
    if (!form.w9?.legalName?.trim() || form.w9.legalName.trim().length < 2) {
      setErr('w9.legalName', 'Legal name is required (min 2 characters).', 'w9')
    }
    if (!form.w9?.taxClassification) {
      setErr('w9.taxClassification', 'Select a federal tax classification.', 'w9')
    }
    if (form.w9?.taxClassification === 'llc') {
      if (!form.w9.llcClassification || !['C', 'S', 'P'].includes(form.w9.llcClassification)) {
        setErr('w9.llcClassification', 'LLC classification (C, S, or P) is required.', 'w9')
      }
    }
    if (form.w9?.taxClassification === 'other') {
      if (!form.w9.otherClassification?.trim()) {
        setErr('w9.otherClassification', 'Describe your "Other" classification.', 'w9')
      }
    }

    return { out, map }
  }

  async function handleSave() {
    // Aggressively clear stale state BEFORE starting (BUG-14).
    setErrorMsg('')
    setErrors([])
    setWarnings([])
    setErrorMap({})
    setRealignSummary(null)
    setSaveStatus('saving')

    const { out: validationErrors, map: validationMap } = validate()
    if (validationErrors.length > 0) {
      setSaveStatus('error')
      setErrors(validationErrors)
      setErrorMap(validationMap)

      // BUG-07: scroll to the first error field so the user immediately
      // sees what's wrong, instead of needing to hunt above the banner.
      const firstField = Object.keys(validationMap)[0]
      if (firstField && typeof document !== 'undefined') {
        const el = document.getElementById(`field-${firstField}`)
        if (el) {
          // setTimeout deferred so the render with the error styling lands first.
          setTimeout(() => {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' })
            el.focus?.()
          }, 50)
        }
      }
      return
    }

    try {
      const token = await getToken()
      const payload = buildPayload()
      const hasFiles =
        Object.keys(pendingFiles.credentialFiles || {}).length > 0 ||
        !!pendingFiles.w9SignatureFile
      const callApi = hasFiles
        ? () => api.updateProfileWithFiles(token, customerId, payload, pendingFiles)
        : () => api.updateProfile(token, customerId, payload)
      const res = await callApi()

      // BUG-02 root cause: backend's sendResponse envelope sets status='partial'
      // (NOT 'error') when result.ok === false (i.e., the save was BLOCKED by
      // errors[]). The old check only treated status==='error' as failure, so
      // 'partial' fell into the success path and showed "Saved with warnings"
      // banner with "Could not save" body — logically contradictory.
      // 'partial' means errors[] is populated and the save did NOT persist —
      // treat as full error.
      const apiFailed = !res || res.status === 'error' || res.status === 'partial'
      if (apiFailed) {
        setSaveStatus('error')
        setErrors(Array.isArray(res?.result?.errors) ? res.result.errors : [])
        setErrorMsg(res?.message || 'Save failed.')
        return
      }

      // success path — only warnings[] should populate here; errors[] from
      // backend is reserved for blocked-save state and is handled above.
      const partial = Array.isArray(res?.result?.errors) ? res.result.errors : []
      const warns = Array.isArray(res?.result?.warnings) ? res.result.warnings : []
      setErrors(partial)
      setWarnings(warns)
      if (res?.result?.paymentMethodRealign) {
        setRealignSummary(res.result.paymentMethodRealign)
      }
      const fresh = res?.result?.profile
      if (fresh) onSaved?.(fresh)
      setPendingFiles({ credentialFiles: {} })
      // Clear raw card data from local state — don't keep CVV / PAN in
      // memory longer than needed. The display fields (last4 / brand)
      // come from `fresh` so the user still sees the new card on file.
      setForm((prev) => ({
        ...prev,
        card: {
          ...prev.card,
          cardNumber: '',
          cardExpiry: '',
          cardCvv: '',
        },
        ach: { ...prev.ach, achAccountNumber: '' },
        commission: { ...prev.commission, bankAccountNumber: '' },
      }))
      setSaveStatus('saved')
    } catch (err) {
      setSaveStatus('error')
      setErrorMsg(err?.message || 'Save failed.')
    }
  }

  return (
    <s-stack direction="block" gap="large">
      {/* About you — merged personal + business + address (open by default) */}
      <PersonalAndAddressSection form={form} setForm={setForm} profile={profile} errorMap={errorMap} />

      {/* Credentials — full-width grid of credential cards */}
      <CredentialsSection
        form={form}
        setForm={setForm}
        pendingFiles={pendingFiles}
        setPendingFiles={setPendingFiles}
        profile={profile}
      />

      {/* Tax info | Payment method — side by side.
          alignItems="start" prevents a collapsed/shorter card from being
          stretched to the height of its taller sibling. */}
      <s-grid gridTemplateColumns="1fr 1fr" gap="large" alignItems="start">
        <TaxSection form={form} setForm={setForm} errorMap={errorMap} />
        <PaymentMethodSection form={form} setForm={setForm} />
      </s-grid>

      {/* Card on file — inline card inputs, tokenized server-side on Save */}
      <CardSection form={form} setForm={setForm} />

      {/* ACH bank | Commission bank — side by side */}
      <s-grid gridTemplateColumns="1fr 1fr" gap="large" alignItems="start">
        <ACHSection form={form} setForm={setForm} />
        <CommissionSection form={form} setForm={setForm} />
      </s-grid>

      {/* W-9 form — full width (perjury text needs space) */}
      <W9Section form={form} setForm={setForm} profile={profile} errorMap={errorMap} />

      {/* ── Save footer: subscribe toggle + status banners + save button ── */}
      <SaveFooter
        form={form}
        setForm={setForm}
        saveStatus={saveStatus}
        errorMsg={errorMsg}
        errors={errors}
        warnings={warnings}
        realignSummary={realignSummary}
        onSave={handleSave}
      />
    </s-stack>
  )
}

// Save footer — one container that combines the communications toggle,
// any status/error banners, and the primary Save button. Sits at the
// bottom of the form. (True sticky position-fixed isn't available in
// the customer-account sandbox, but placing the bar at the natural end
// + s-divider above gives it visual prominence.)
function SaveFooter({
  form,
  setForm,
  saveStatus,
  errorMsg,
  errors,
  warnings = [],
  realignSummary,
  onSave,
}) {
  const savedClean =
    saveStatus === 'saved' && errors.length === 0 && warnings.length === 0
  const savedWithWarnings =
    saveStatus === 'saved' && (errors.length > 0 || warnings.length > 0)
  return (
    <s-section>
      <s-stack direction="block" gap="base">
        {/* Status banners — shown above the action row */}
        {savedClean && (
          <s-banner tone="success" heading="Profile saved">
            <s-text>Your changes have been saved to Shopify and our records.</s-text>
          </s-banner>
        )}
        {savedWithWarnings && (
          <s-banner tone="warning" heading="Saved with warnings">
            <s-stack direction="block" gap="small-300">
              {[...errors, ...warnings].map((e, i) => (
                <s-text key={i}>• {e.message || JSON.stringify(e)}</s-text>
              ))}
            </s-stack>
          </s-banner>
        )}
        {saveStatus === 'error' && (
          <s-banner tone="critical" heading="Couldn't save">
            <s-stack direction="block" gap="small-300">
              {errorMsg && <s-text>{errorMsg}</s-text>}
              {errors.map((e, i) => (
                <s-text key={i}>• {e.message || JSON.stringify(e)}</s-text>
              ))}
            </s-stack>
          </s-banner>
        )}
        {realignSummary && (
          <s-banner tone="info" heading="Open invoices realigned">
            <s-text>
              {realignSummary.invoiceCount || 0} open invoice
              {(realignSummary.invoiceCount || 0) === 1 ? '' : 's'} updated to the new method.
            </s-text>
          </s-banner>
        )}

        {/* Action row — subscribe toggle on the left, save button on the right */}
        <s-stack
          direction="inline"
          gap="base"
          alignItems="center"
          justifyContent="space-between"
        >
          <s-checkbox
            label="Subscribe to product news & educational updates"
            accessibilityLabel="Subscribe to product news and educational updates"
            checked={!!form.subscribeNews}
            onchange={(e) => setForm({ ...form, subscribeNews: e.target.checked })}
          />
          <s-button variant="primary" onclick={onSave} disabled={saveStatus === 'saving'}>
            {saveStatus === 'saving' ? 'Saving…' : 'Save all changes'}
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  )
}
