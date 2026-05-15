import { useState } from 'react'
import { Controller, useWatch } from 'react-hook-form'
import { CREDENTIALS, REFERRALS } from '../constants'
import CredentialCard from './CredentialCard'

export default function Step1AboutYou({ control, errors, setValue }) {
  const [showPassword, setShowPassword] = useState(false)
  const credentials = useWatch({ control, name: 'credentials' }) || {}
  const referrals = useWatch({ control, name: 'referrals' }) || {}
  const selectedCreds = CREDENTIALS.filter((c) => credentials[c.id]?.selected)

  const onToggleCredential = (id, checked) => {
    setValue(`credentials.${id}.selected`, checked, { shouldDirty: true })
  }

  const onToggleReferral = (id, checked) => {
    if (id === 'none' && checked) {
      // None is exclusive — clear everything else
      REFERRALS.forEach((r) => {
        if (r.id !== 'none') setValue(`referrals.${r.id}.selected`, false)
      })
    } else if (checked) {
      setValue('referrals.none.selected', false)
    }
    setValue(`referrals.${id}.selected`, checked, { shouldDirty: true })
  }

  return (
    <section className="rf-step">
      <h1 className="rf-step-title">Let's get to know you</h1>
      <p className="rf-step-subtitle">
        A few quick details about you and your practice. Takes about 90 seconds.
      </p>

      <div className="rf-field rf-row rf-row-2">
        <div>
          <label className="rf-label">First name <span className="rf-req">*</span></label>
          <Controller
            name="firstName"
            control={control}
            render={({ field }) => (
              <input
                {...field}
                type="text"
                placeholder="Jane"
                className={`rf-input ${errors.firstName ? 'error' : ''}`}
              />
            )}
          />
          {errors.firstName && <p className="rf-help error">{errors.firstName.message}</p>}
        </div>
        <div>
          <label className="rf-label">Last name <span className="rf-req">*</span></label>
          <Controller
            name="lastName"
            control={control}
            render={({ field }) => (
              <input
                {...field}
                type="text"
                placeholder="Smith"
                className={`rf-input ${errors.lastName ? 'error' : ''}`}
              />
            )}
          />
          {errors.lastName && <p className="rf-help error">{errors.lastName.message}</p>}
        </div>
      </div>

      <div className="rf-field">
        <label className="rf-label">
          Email <span className="rf-req">*</span>
          <span className="rf-hint">We'll save your progress here</span>
        </label>
        <Controller
          name="email"
          control={control}
          render={({ field }) => (
            <input
              {...field}
              type="email"
              placeholder="jane@yourpractice.com"
              className={`rf-input ${errors.email ? 'error' : ''}`}
            />
          )}
        />
        {errors.email && <p className="rf-help error">{errors.email.message}</p>}
      </div>

      <div className="rf-field rf-row rf-row-2">
        <div>
          <label className="rf-label">Phone <span className="rf-req">*</span></label>
          <div className="rf-prefix">
            <span className="prefix-text">+1</span>
            <Controller
              name="phone"
              control={control}
              render={({ field }) => (
                <input
                  {...field}
                  type="tel"
                  placeholder="(555) 123-4567"
                  className={`rf-input ${errors.phone ? 'error' : ''}`}
                />
              )}
            />
          </div>
          {errors.phone && <p className="rf-help error">{errors.phone.message}</p>}
        </div>
        <div>
          <label className="rf-label">Create a password <span className="rf-req">*</span></label>
          <div className="rf-password-wrap">
            <Controller
              name="password"
              control={control}
              render={({ field }) => (
                <input
                  {...field}
                  type={showPassword ? 'text' : 'password'}
                  placeholder="At least 8 characters"
                  className={`rf-input ${errors.password ? 'error' : ''}`}
                />
              )}
            />
            <button
              type="button"
              className="rf-password-toggle"
              onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? (
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
          {errors.password && <p className="rf-help error">{errors.password.message}</p>}
        </div>
      </div>

      <div className="rf-divider">
        <h2 className="rf-section-label">Your practice</h2>
        <p className="rf-section-hint">Helps us tailor your wholesale catalog and pricing.</p>
      </div>

      <div className="rf-field">
        <label className="rf-label">Business name <span className="rf-opt">Optional</span></label>
        <Controller
          name="businessName"
          control={control}
          render={({ field }) => (
            <input
              {...field}
              type="text"
              placeholder="Smith Wellness Clinic"
              className="rf-input"
            />
          )}
        />
      </div>

      <div className="rf-field">
        <label className="rf-label">
          Your credentials <span className="rf-req">*</span>
          <span className="rf-hint">Select all that apply</span>
        </label>
        <div className="rf-checkbox-grid">
          {CREDENTIALS.map((cred) => {
            const selected = credentials[cred.id]?.selected
            return (
              <label
                key={cred.id}
                className={`rf-check-item ${selected ? 'checked' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={Boolean(selected)}
                  onChange={(e) => onToggleCredential(cred.id, e.target.checked)}
                />
                <span>{cred.name}</span>
              </label>
            )
          })}
        </div>
        {errors.credentials?.message && (
          <p className="rf-help error" style={{ marginTop: 8 }}>{errors.credentials.message}</p>
        )}
      </div>

      {selectedCreds.length > 0 && (
        <div className="rf-conditional open">
          <div style={{ marginTop: 20 }}>
            <div className="rf-cred-docs-header">
              <h3>Required documents &amp; details</h3>
              <span className="rf-cred-counter">{selectedCreds.length} selected</span>
            </div>
            <p className="rf-section-hint" style={{ marginBottom: 14 }}>
              A quick verification step for each credential. Files are encrypted and reviewed by our team only.
            </p>
            {selectedCreds.map((cred) => (
              <CredentialCard
                key={cred.id}
                cred={cred}
                control={control}
                errors={errors}
                onRemove={() => onToggleCredential(cred.id, false)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="rf-field">
        <label className="rf-label">
          How did you hear about us? <span className="rf-req">*</span>
          <span className="rf-hint">Select all that apply</span>
        </label>
        <div className="rf-referral-list">
          {REFERRALS.map((ref) => {
            const selected = referrals[ref.id]?.selected
            const fieldError = errors.referrals?.[ref.id]?.value?.message
            return (
              <div key={ref.id} className="rf-referral-item">
                <label className={`rf-check-item ${selected ? 'checked' : ''}`}>
                  <input
                    type="checkbox"
                    checked={Boolean(selected)}
                    onChange={(e) => onToggleReferral(ref.id, e.target.checked)}
                  />
                  <span>{ref.name}</span>
                </label>
                {ref.field && (
                  <div className={`rf-referral-followup ${selected ? 'open' : ''}`}>
                    <Controller
                      name={`referrals.${ref.id}.value`}
                      control={control}
                      defaultValue=""
                      render={({ field }) => (
                        <input
                          {...field}
                          type="text"
                          placeholder={ref.field.placeholder}
                          className={`rf-input ${fieldError ? 'error' : ''}`}
                        />
                      )}
                    />
                    {fieldError ? (
                      <p className="rf-help error">{fieldError}</p>
                    ) : (
                      <p className="rf-help">{ref.field.hint}</p>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {errors.referrals?.message && (
          <p className="rf-help error" style={{ marginTop: 8 }}>{errors.referrals.message}</p>
        )}
      </div>
    </section>
  )
}
