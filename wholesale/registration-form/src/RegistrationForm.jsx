import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { yupResolver } from '@hookform/resolvers/yup'
import { fullSchema } from './schema/full.schema'
import { step1Fields } from './schema/step1.schema'
import { step2Fields } from './schema/step2.schema'
import { step3Fields } from './schema/step3.schema'
import { buildFormData } from './utils/buildFormData'
import ApiService from './services/ApiService'
import { useStepValidation } from './hooks/useStepValidation'
import StepIndicator from './components/StepIndicator'
import Step1AboutYou from './components/Step1AboutYou'
import Step2AddressTax from './components/Step2AddressTax'
import Step3Payment from './components/Step3Payment'
import { CREDENTIALS, REFERRALS } from './constants'
import './styles/variables.css'
import './styles/registration-form.css'

const credentialDefaults = {}
CREDENTIALS.forEach((cred) => {
  const fields = { selected: false }
  cred.docs.forEach((doc, i) => {
    if (doc.type === 'file') fields[`file${i}`] = null
    else if (doc.key) fields[doc.key] = ''
  })
  credentialDefaults[cred.id] = fields
})

const referralDefaults = {}
REFERRALS.forEach((ref) => {
  referralDefaults[ref.id] = ref.field ? { selected: false, value: '' } : { selected: false }
})

const defaultValues = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  password: '',
  businessName: '',
  credentials: credentialDefaults,
  referrals: referralDefaults,
  billingAddress: {
    line1: '', line2: '', city: '', state: '', zip: '', country: 'United States',
  },
  shippingSameAsBilling: true,
  shippingAddress: null,
  shippingPropertyType: '',
  resellsProducts: false,
  tax: {
    taxIdType: 'ein',
    taxId: '',
    salesPermit: '',
    exemptState: '',
    itemsToResell: '',
    businessActivity: '',
  },
  payment: {
    method: 'check',
    cardholderName: '',
    cardBrand: '',
    cardNumber: '',
    cardExpiry: '',
    cardCvv: '',
  },
  signature: { type: 'draw', drawn: null, typed: '' },
  subscribeNews: false,
  termsAccepted: false,
}

// Walk a react-hook-form errors tree and produce a flat list of { path, message, type }.
// Helpful for console output — the nested shape is hard to read at a glance.
function flattenErrors(node, prefix = '') {
  const out = []
  if (!node || typeof node !== 'object') return out
  // A leaf error has a `message` string.
  if (typeof node.message === 'string') {
    out.push({ path: prefix || '(root)', message: node.message, type: node.type })
    return out
  }
  for (const key of Object.keys(node)) {
    // Skip RHF internals
    if (key === 'ref' || key === 'types') continue
    const child = node[key]
    if (child && typeof child === 'object') {
      out.push(...flattenErrors(child, prefix ? `${prefix}.${key}` : key))
    }
  }
  return out
}

function Toast({ severity, message, onDismiss }) {
  // Auto-dismiss after 4s — but only register the timeout once on mount
  return (
    <div className={`rf-toast ${severity}`} onClick={onDismiss}>
      {message}
    </div>
  )
}

function SuccessScreen() {
  return (
    <div className="rf-page">
      <main className="rf-main">
        <div className="rf-card">
          <div className="rf-success">
            <div className="check-circle">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" width="28" height="28">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </div>
            <h2>Application received</h2>
            <p>
              Thanks! We've sent a confirmation to your email. Our team will review your
              application and get back to you within 2 business days.
            </p>
            <div className="rf-next-steps">
              <h3>What happens next</h3>
              <ol>
                <li>We verify your credentials and tax information</li>
                <li>You'll receive an approval email with your wholesale login</li>
                <li>Start shopping at wholesale pricing</li>
              </ol>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}

function FormBody({ onBack }) {
  const [currentStep, setCurrentStep] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState(null)
  const [successView, setSuccessView] = useState(false)

  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitted },
    setValue,
    trigger,
    clearErrors,
  } = useForm({
    mode: 'onTouched',
    reValidateMode: 'onChange',
    resolver: yupResolver(fullSchema),
    defaultValues,
  })

  const validateStep = useStepValidation(trigger)

  // Log validation errors to the browser console any time they change.
  // Helps debug "why won't this step advance" without sprinkling logs everywhere.
  useEffect(() => {
    const flat = flattenErrors(errors)
    if (flat.length === 0) {
      console.log('[RegistrationForm] no validation errors')
    } else {
      console.group(`[RegistrationForm] validation errors (${flat.length})`)
      flat.forEach(({ path, message, type }) => {
        console.log(`  • ${path} — ${message}${type ? `  (rule: ${type})` : ''}`)
      })
      console.log('full errors object:', errors)
      console.groupEnd()
    }
  }, [errors])

  const showToast = (severity, message) => {
    setToast({ severity, message })
    setTimeout(() => setToast(null), 4000)
  }

  const next = async () => {
    const fields = currentStep === 1 ? step1Fields : step2Fields
    const ok = await validateStep(fields)
    if (!ok) {
      console.warn(`[RegistrationForm] Step ${currentStep} blocked — fix the errors above.`)
      showToast('error', 'Please fix the highlighted fields.')
      return
    }
    setToast(null)
    clearErrors()
    setCurrentStep((s) => Math.min(s + 1, 3))
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const prev = () => {
    setToast(null)
    clearErrors()
    setCurrentStep((s) => Math.max(s - 1, 1))
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const onValid = async (values) => {
    setSubmitting(true)
    try {
      // Send full digits to the backend so it can HMAC-hash them. CVV is
      // dropped entirely — PCI forbids storing it in any form, including hashed.
      const digits = (values.payment.cardNumber || '').replace(/\D/g, '')
      const expMatch = (values.payment.cardExpiry || '').match(/^(\d{2})\s*\/?\s*(\d{2})$/)
      const cardPayload = {
        method: values.payment.method,
        cardholderName: values.payment.cardholderName,
        cardBrand: values.payment.cardBrand,
        cardNumber: digits,                                  // hashed server-side, never persisted raw
        cardLast4: digits.slice(-4),
        cardExpMonth: expMatch ? Number(expMatch[1]) : null,
        cardExpYear: expMatch ? 2000 + Number(expMatch[2]) : null,
      }

      const payload = { ...values, payment: cardPayload }

      // Signature handled separately so we can attach the PNG as a File
      const fd = buildFormData({ ...payload, signature: undefined })
      if (values.signature?.type === 'draw' && values.signature.drawn) {
        fd.append('signatureFile', values.signature.drawn, 'signature.png')
      } else if (values.signature?.type === 'type' && values.signature.typed) {
        fd.append('signatureType', 'typed')
        fd.append('signatureValue', values.signature.typed)
      }

      const data = await ApiService.submitRegistration(fd)
      showToast('success', data.message || 'Application submitted!')
      setSuccessView(true)
    } catch (err) {
      showToast('error', err?.message || 'Submit failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (successView) return <SuccessScreen />

  return (
    <div className="rf-page">
      <header className="rf-topbar">
        <div className="rf-topbar-inner">
          <div>
            <span className="rf-brand">Natural Solutions</span>
            <span className="rf-brand-sub">Wholesale</span>
          </div>
          {/* <a href="#" className="rf-help-link">Need help?</a> */}
        </div>
      </header>

      <StepIndicator currentStep={currentStep} />

      <main className="rf-main">
        <div className="rf-card">
          <form onSubmit={handleSubmit(onValid, (errs) => {
            console.error('[RegistrationForm] submit blocked by validation:', errs)
            console.table(
              flattenErrors(errs).map(({ path, message, type }) => ({ path, message, type }))
            )
          })} noValidate>
            {currentStep === 1 && <Step1AboutYou control={control} errors={errors} setValue={setValue} trigger={trigger} />}
            {currentStep === 2 && <Step2AddressTax control={control} errors={errors} setValue={setValue} />}
            {currentStep === 3 && (
              <Step3Payment control={control} errors={errors} setValue={setValue} onEditBilling={prev} isSubmitted={isSubmitted} />
            )}

            <div className="rf-actions">
              {currentStep === 1 ? (
                <span />
              ) : (
                <button
                  type="button"
                  className="rf-btn rf-btn-secondary"
                  onClick={prev}
                  disabled={submitting}
                >
                  <svg className="rf-icon-svg" viewBox="0 0 24 24">
                    <path d="M19 12H5M11 19l-7-7 7-7" />
                  </svg>
                  Back
                </button>
              )}
              {currentStep < 3 ? (
                <button type="button" className="rf-btn rf-btn-primary" onClick={next}>
                  Continue
                  <svg className="rf-icon-svg" viewBox="0 0 24 24">
                    <path d="M5 12h14M13 5l7 7-7 7" />
                  </svg>
                </button>
              ) : (
                <button type="submit" className="rf-btn rf-btn-primary" disabled={submitting}>
                  {submitting ? 'Submitting…' : 'Submit application'}
                  {!submitting && (
                    <svg className="rf-icon-svg" viewBox="0 0 24 24">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </button>
              )}
            </div>
          </form>
        </div>
      </main>

      <footer className="rf-footer">
        © 2026 Natural Solutions Wholesale, LLC · <a href="#">Privacy</a> · <a href="#">Terms</a>
      </footer>

      {toast && (
        <Toast severity={toast.severity} message={toast.message} onDismiss={() => setToast(null)} />
      )}
    </div>
  )
}

export default function RegistrationForm({ onBack }) {
  return <FormBody onBack={onBack} />
}
