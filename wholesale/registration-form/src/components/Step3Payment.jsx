import { Controller, useWatch } from 'react-hook-form'
import { getStatesForCountry, PAYMENT_METHODS } from '../constants'
import PaymentCardForm from './PaymentCardForm'
import SignaturePad from './SignaturePad'

function BillingSummary({ control, onEdit }) {
  const firstName = useWatch({ control, name: 'firstName' }) || ''
  const lastName = useWatch({ control, name: 'lastName' }) || ''
  const businessName = useWatch({ control, name: 'businessName' }) || ''
  const ba = useWatch({ control, name: 'billingAddress' }) || {}

  const name = `${firstName} ${lastName}`.trim()
  const streetLine = [ba.line1, ba.line2].filter(Boolean).join(', ')
  const states = getStatesForCountry(ba.country) || []
  const stateName = states.find((s) => s.code === ba.state)?.name || ba.state || ''
  const cityLine = [ba.city, [stateName, ba.zip].filter(Boolean).join(' ').trim()]
    .filter(Boolean)
    .join(', ')

  const hasContent = ba.line1 || ba.city || ba.zip

  return (
    <div className="rf-billing-summary">
      <div className="rf-billing-head">
        <span className="rf-billing-label">Using your billing address from Step 2</span>
        <button type="button" className="rf-billing-edit" onClick={onEdit}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
          Edit
        </button>
      </div>
      <div className="rf-billing-body">
        {hasContent ? (
          <>
            {name && (
              <div className="name">
                {name}{businessName ? ` · ${businessName}` : ''}
              </div>
            )}
            {streetLine && <div>{streetLine}</div>}
            {cityLine && <div>{cityLine}</div>}
            {ba.country && <div>{ba.country}</div>}
          </>
        ) : (
          <div className="rf-billing-empty">Complete Step 2 to populate this address</div>
        )}
      </div>
    </div>
  )
}

export default function Step3Payment({ control, errors, onEditBilling, isSubmitted, collectTokenResolverRef }) {
  return (
    <section className="rf-step">
      <h1 className="rf-step-title">Payment &amp; authorization</h1>
      <p className="rf-step-subtitle">
        Choose how you'd like to pay invoices. A card on file is required for all accounts.
      </p>

      <div className="rf-field">
        <label className="rf-label">Preferred payment method <span className="rf-req">*</span></label>
        <Controller
          name="payment.method"
          control={control}
          defaultValue="check"
          render={({ field }) => (
            <div className="rf-pay-options">
              {PAYMENT_METHODS.map((pm) => (
                <label
                  key={pm.id}
                  className={`rf-pay-card ${field.value === pm.id ? 'selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="paymentMethod"
                    checked={field.value === pm.id}
                    onChange={() => field.onChange(pm.id)}
                  />
                  <div style={{ flex: 1 }}>
                    <div className="rf-pay-card-title">
                      {pm.name}
                      <span className={`rf-fee-tag ${pm.fee ? '' : 'free'}`}>{pm.feeLabel}</span>
                    </div>
                    <p className="rf-pay-card-desc">{pm.desc}</p>
                  </div>
                </label>
              ))}
            </div>
          )}
        />
      </div>

      <div className="rf-divider">
        <h2 className="rf-section-label">Card on file</h2>
        <p className="rf-section-hint">
          Required for all accounts. Used as a backup if payment isn't received on time.
        </p>
      </div>

      <div className="rf-trust">
        <svg className="rf-icon-svg" viewBox="0 0 24 24" style={{ width: 16, height: 16 }}>
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <span>Only the last 4 digits and card brand are stored. We never persist the full card number or CVV.</span>
      </div>

      <PaymentCardForm control={control} tokenResolverRef={collectTokenResolverRef} showAllErrors={isSubmitted} />

      <div className="rf-field" style={{ marginTop: 4 }}>
        <label className="rf-label">Card billing address</label>
        <BillingSummary control={control} onEdit={onEditBilling} />
      </div>

      <div className="rf-divider">
        <h2 className="rf-section-label">Authorization</h2>
        <p className="rf-section-hint">
          Your e-signature below covers payment, card-on-file, and resale certificate (if applicable).
        </p>
      </div>

      <div className="rf-auth-block">
        <div className="rf-auth-section">
          <p className="rf-auth-heading">I authorize Natural Solutions Wholesale, LLC to:</p>
          <ul>
            <li>Charge my selected payment method for approved purchases and outstanding invoices</li>
            <li>Store my card information on file for future transactions related to my account</li>
            <li>Accept my resale certificate for non-taxable purchases (if applicable)</li>
          </ul>
        </div>
        <div className="rf-auth-section">
          <p className="rf-auth-heading">I understand:</p>
          <ul>
            <li>Credit card payments incur a 3% processing fee; ACH transfers incur 1%</li>
            <li>Check payments must be received within 10 business days of the balance email</li>
            <li>If payment is not received on time, the credit card on file will be charged</li>
          </ul>
        </div>
        <p className="rf-auth-footer">
          This authorization remains in effect until canceled in writing. Cancel anytime by emailing{' '}
          <strong>wholesale@naturalsolutionsphc.com</strong>.
        </p>
      </div>

      <div className="rf-field" style={{ marginTop: 18 }}>
        <Controller
          name="signature"
          control={control}
          render={({ field, fieldState }) => (
            <SignaturePad
              value={field.value}
              onChange={(v) => {
                field.onChange(v)
                field.onBlur()
              }}
              error={
                (fieldState.isTouched || isSubmitted) && fieldState.error
                  ? fieldState.error.message
                  : null
              }
            />
          )}
        />
      </div>

      <label className="rf-tc-row">
        <Controller
          name="subscribeNews"
          control={control}
          render={({ field }) => (
            <input
              type="checkbox"
              checked={Boolean(field.value)}
              onChange={(e) => field.onChange(e.target.checked)}
            />
          )}
        />
        <span>Send me updates &amp; upcoming news.</span>
      </label>

      <label className="rf-tc-row">
        <Controller
          name="termsAccepted"
          control={control}
          render={({ field }) => (
            <input
              type="checkbox"
              checked={Boolean(field.value)}
              onChange={(e) => field.onChange(e.target.checked)}
            />
          )}
        />
        <span>
          I agree to the <a href="#" target="_blank" rel="noreferrer">Terms &amp; Conditions</a> and{' '}
          <a href="#" target="_blank" rel="noreferrer">Privacy Policy</a>, and confirm the information above is accurate.
        </span>
      </label>
    </section>
  )
}
