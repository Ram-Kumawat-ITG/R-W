import { useEffect, useState } from 'react'
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

const ACH_ACCOUNT_TYPES = ['Checking', 'Savings', 'Business Checking']

function AchForm({ control, errors }) {
  const [showAccountNumber, setShowAccountNumber] = useState(false)
  const e = errors?.payment || {}
  return (
    <div style={{ marginTop: 16 }}>
      <div className="rf-field">
        <label className="rf-label">Account holder name <span className="rf-req">*</span></label>
        <Controller
          name="payment.achAccountName"
          control={control}
          render={({ field }) => (
            <input
              {...field}
              type="text"
              placeholder="Name on bank account"
              className={`rf-input ${e.achAccountName ? 'error' : ''}`}
            />
          )}
        />
        {e.achAccountName && <p className="rf-help error">{e.achAccountName.message}</p>}
      </div>

      <div className="rf-field rf-row rf-row-2">
        <div>
          <label className="rf-label">Routing number <span className="rf-req">*</span></label>
          <Controller
            name="payment.achRoutingNumber"
            control={control}
            render={({ field }) => (
              <input
                {...field}
                type="text"
                placeholder="9-digit ABA routing number"
                maxLength={9}
                className={`rf-input ${e.achRoutingNumber ? 'error' : ''}`}
              />
            )}
          />
          {e.achRoutingNumber && <p className="rf-help error">{e.achRoutingNumber.message}</p>}
        </div>
        <div>
          <label className="rf-label">Account number <span className="rf-req">*</span></label>
          <div className="rf-password-wrap">
            <Controller
              name="payment.achAccountNumber"
              control={control}
              render={({ field }) => (
                <input
                  {...field}
                  type={showAccountNumber ? 'text' : 'password'}
                  placeholder="Bank account number"
                  maxLength={17}
                  autoComplete="off"
                  className={`rf-input ${e.achAccountNumber ? 'error' : ''}`}
                />
              )}
            />
            <button
              type="button"
              className="rf-password-toggle"
              onClick={() => setShowAccountNumber((s) => !s)}
              aria-label={showAccountNumber ? 'Hide account number' : 'Show account number'}
            >
              {showAccountNumber ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                  <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </div>
          {e.achAccountNumber && <p className="rf-help error">{e.achAccountNumber.message}</p>}
        </div>
      </div>

      <div className="rf-field">
        <label className="rf-label">Account type <span className="rf-req">*</span></label>
        <Controller
          name="payment.achAccountType"
          control={control}
          render={({ field }) => (
            <select {...field} className={`rf-select ${e.achAccountType ? 'error' : ''}`}>
              <option value="">Select account type</option>
              {ACH_ACCOUNT_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          )}
        />
        {e.achAccountType && <p className="rf-help error">{e.achAccountType.message}</p>}
      </div>
    </div>
  )
}

const COMMISSION_ACCOUNT_TYPES = ['Checking', 'Savings', 'Business Checking']

// Collapsible section for the practitioner's commission bank details.
// Hidden behind a button by default — only shown when the user opts in
// (matches the design decision from the registration spec). If their
// payment method is ACH, a checkbox lets them re-use the same account
// for commission payouts in one click.
function CommissionBankSection({ control, errors, setValue }) {
  const enabled = useWatch({ control, name: 'commission.enabled' })
  const useSame = useWatch({ control, name: 'commission.useSamePaymentAccount' })
  const paymentMethod = useWatch({ control, name: 'payment.method' })
  const achAccountName = useWatch({ control, name: 'payment.achAccountName' })
  const achRoutingNumber = useWatch({ control, name: 'payment.achRoutingNumber' })
  const achAccountNumber = useWatch({ control, name: 'payment.achAccountNumber' })
  const achAccountType = useWatch({ control, name: 'payment.achAccountType' })
  const [showAccountNumber, setShowAccountNumber] = useState(false)
  const e = errors?.commission || {}

  // When user ticks "use same as payment ACH", copy values forward.
  // When they untick, leave whatever is there so they can edit freely.
  useEffect(() => {
    if (!enabled || !useSame || paymentMethod !== 'ach') return
    setValue('commission.bankAccountName', achAccountName || '', { shouldValidate: true })
    setValue('commission.bankRoutingNumber', achRoutingNumber || '', { shouldValidate: true })
    setValue('commission.bankAccountNumber', achAccountNumber || '', { shouldValidate: true })
    setValue('commission.bankAccountType', achAccountType || '', { shouldValidate: true })
  }, [enabled, useSame, paymentMethod, achAccountName, achRoutingNumber, achAccountNumber, achAccountType, setValue])

  if (!enabled) {
    return (
      <>
        <div className="rf-divider">
          <h2 className="rf-section-label">Commission payouts (optional)</h2>
          <p className="rf-section-hint">
            If you earn commissions on referred patient orders, we'll deposit
            them to a bank account you provide. You can add this now or later.
          </p>
        </div>
        <button
          type="button"
          className="rf-btn rf-btn-secondary"
          style={{ marginTop: 4 }}
          onClick={() => setValue('commission.enabled', true, { shouldValidate: false })}
        >
          <svg className="rf-icon-svg" viewBox="0 0 24 24">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add commission bank details
        </button>
      </>
    )
  }

  const fieldsLocked = useSame && paymentMethod === 'ach'

  return (
    <>
      <div className="rf-divider">
        <h2 className="rf-section-label">Commission payouts</h2>
        <p className="rf-section-hint">
          Bank account that will receive commission deposits when patients you
          refer place orders. Stored separately from your payment method.
        </p>
      </div>

      {paymentMethod === 'ach' && (
        <label className="rf-tc-row" style={{ marginTop: 8 }}>
          <Controller
            name="commission.useSamePaymentAccount"
            control={control}
            render={({ field }) => (
              <input
                type="checkbox"
                checked={Boolean(field.value)}
                onChange={(ev) => field.onChange(ev.target.checked)}
              />
            )}
          />
          <span>Use the same ACH account I entered for payments above.</span>
        </label>
      )}

      <div className="rf-field" style={{ marginTop: 12 }}>
        <label className="rf-label">
          Account holder name <span className="rf-req">*</span>
        </label>
        <Controller
          name="commission.bankAccountName"
          control={control}
          render={({ field }) => (
            <input
              {...field}
              type="text"
              placeholder="Name on bank account"
              disabled={fieldsLocked}
              className={`rf-input ${e.bankAccountName ? 'error' : ''}`}
            />
          )}
        />
        {e.bankAccountName && <p className="rf-help error">{e.bankAccountName.message}</p>}
      </div>

      <div className="rf-field rf-row rf-row-2">
        <div>
          <label className="rf-label">
            Routing number <span className="rf-req">*</span>
          </label>
          <Controller
            name="commission.bankRoutingNumber"
            control={control}
            render={({ field }) => (
              <input
                {...field}
                type="text"
                placeholder="9-digit ABA routing number"
                maxLength={9}
                disabled={fieldsLocked}
                className={`rf-input ${e.bankRoutingNumber ? 'error' : ''}`}
              />
            )}
          />
          {e.bankRoutingNumber && <p className="rf-help error">{e.bankRoutingNumber.message}</p>}
        </div>
        <div>
          <label className="rf-label">
            Account number <span className="rf-req">*</span>
          </label>
          <div className="rf-password-wrap">
            <Controller
              name="commission.bankAccountNumber"
              control={control}
              render={({ field }) => (
                <input
                  {...field}
                  type={showAccountNumber ? 'text' : 'password'}
                  placeholder="Bank account number"
                  maxLength={17}
                  autoComplete="off"
                  disabled={fieldsLocked}
                  className={`rf-input ${e.bankAccountNumber ? 'error' : ''}`}
                />
              )}
            />
            <button
              type="button"
              className="rf-password-toggle"
              onClick={() => setShowAccountNumber((s) => !s)}
              aria-label={showAccountNumber ? 'Hide account number' : 'Show account number'}
            >
              {showAccountNumber ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                  <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </div>
          {e.bankAccountNumber && <p className="rf-help error">{e.bankAccountNumber.message}</p>}
        </div>
      </div>

      <div className="rf-field">
        <label className="rf-label">
          Account type <span className="rf-req">*</span>
        </label>
        <Controller
          name="commission.bankAccountType"
          control={control}
          render={({ field }) => (
            <select
              {...field}
              disabled={fieldsLocked}
              className={`rf-select ${e.bankAccountType ? 'error' : ''}`}
            >
              <option value="">Select account type</option>
              {COMMISSION_ACCOUNT_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          )}
        />
        {e.bankAccountType && <p className="rf-help error">{e.bankAccountType.message}</p>}
      </div>

      <button
        type="button"
        className="rf-btn rf-btn-secondary"
        style={{ marginTop: 4 }}
        onClick={() => {
          setValue('commission.enabled', false, { shouldValidate: false })
          setValue('commission.useSamePaymentAccount', false, { shouldValidate: false })
        }}
      >
        Remove commission bank details
      </button>
    </>
  )
}

export default function Step3Payment({ control, errors, onEditBilling, isSubmitted, collectTokenResolverRef, setValue }) {
  const paymentMethod = useWatch({ control, name: 'payment.method' })
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

      {paymentMethod === 'ach' && (
        <div>
          <div className="rf-divider">
            <h2 className="rf-section-label">Bank account details</h2>
            <p className="rf-section-hint">Your bank account information for ACH transfers.</p>
          </div>
          <AchForm control={control} errors={errors} />
        </div>
      )}

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

      <CommissionBankSection
        control={control}
        errors={errors}
        setValue={setValue}
      />

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
      {errors.termsAccepted && (
        <p className="rf-help error">{errors.termsAccepted.message}</p>
      )}
    </section>
  )
}
