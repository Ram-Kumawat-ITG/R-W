import { useState, useRef } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { yupResolver } from '@hookform/resolvers/yup'
import { signupSchema } from './schema/signup.schema'
import ApiService from './services/ApiService'

// The wholesale store's storefront URL is where practitioners get redirected
// to fill the registration form. Hardcoded so the form works without the
// patient knowing the wholesale store domain.
const WHOLESALE_REGISTRATION_URL =
  'https://ns-wholesale-stagging-1.myshopify.com/pages/contact'

export default function SignupForm({ onSuccess }) {
  const {
    control,
    handleSubmit,
    formState: { errors },
    setError,
    clearErrors,
    watch,
    getValues,
  } = useForm({
    mode: 'onTouched',
    reValidateMode: 'onChange',
    resolver: yupResolver(signupSchema),
    defaultValues: {
      firstName: '',
      lastName: '',
      email: '',
      practitionerCode: '',
    },
  })

  const [submitting, setSubmitting] = useState(false)
  const [topError, setTopError] = useState(null)
  const [emailCheckState, setEmailCheckState] = useState({
    status: 'idle', // 'idle' | 'checking' | 'available' | 'taken'
  })
  const [codeState, setCodeState] = useState({
    status: 'idle', // 'idle' | 'verifying' | 'verified' | 'invalid'
    verifiedValue: null, // the exact code string that was confirmed by backend
    message: null,
  })

  // Track the email value at the moment of the last successful check, so we
  // can invalidate the green check if the user edits the field afterwards.
  const lastCheckedEmail = useRef(null)

  // ── Display rule: empty field on blur = no error shown ─────────────
  // RHF's reValidateMode:'onChange' fires "Required" the moment a touched
  // field becomes empty. The submit handler still runs full validation,
  // so this only hides the error from the UI while the field is empty.
  const handleBlurClearIfEmpty = (fieldName) => (e) => {
    const value = String(e?.target?.value ?? '').trim()
    if (!value) clearErrors(fieldName)
  }

  // ── Email blur check ────────────────────────────────────────────────
  const onEmailBlur = async (value) => {
    const email = String(value || '').trim().toLowerCase()
    if (!email) {
      // Empty on blur — clear both the duplicate-email state AND any
      // RHF error left over (e.g. "Already registered" from a previous
      // check, or "Required" from RHF's re-validation on clear).
      setEmailCheckState({ status: 'idle' })
      clearErrors('email')
      return
    }
    // Only check if the field passes basic format — the schema's regex
    // catches obvious typos so we don't waste API calls.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setEmailCheckState({ status: 'idle' })
      return
    }
    setEmailCheckState({ status: 'checking' })
    try {
      const { exists } = await ApiService.checkEmail(email)
      lastCheckedEmail.current = email
      if (exists) {
        setEmailCheckState({ status: 'taken' })
        setError('email', {
          type: 'server',
          message: 'Already registered — please sign in instead.',
        })
      } else {
        setEmailCheckState({ status: 'available' })
        clearErrors('email')
      }
    } catch (err) {
      console.warn('[signup] email check failed:', err)
      // Don't block the user on transient API failures. They'll see the
      // duplicate-email error from Shopify on submit if it's a real issue.
      setEmailCheckState({ status: 'idle' })
    }
  }

  const onEmailChange = (field, e) => {
    field.onChange(e)
    const next = String(e.target.value || '').trim().toLowerCase()
    // Reset the check state if the user edits after a check fired.
    // Also drop the "Already registered" server error so it doesn't
    // linger after the user starts fixing the input.
    if (
      lastCheckedEmail.current &&
      lastCheckedEmail.current !== next
    ) {
      setEmailCheckState({ status: 'idle' })
      lastCheckedEmail.current = null
      clearErrors('email')
    }
  }

  // ── Verify Practitioner Code ────────────────────────────────────────
  const onVerifyCode = async () => {
    const code = String(getValues('practitionerCode') || '').trim()
    if (!code) {
      setCodeState({
        status: 'invalid',
        verifiedValue: null,
        message: 'Enter a code first',
      })
      return
    }
    setCodeState({ status: 'verifying', verifiedValue: null, message: null })
    try {
      const { valid, code: confirmedCode, practitionerName } =
        await ApiService.verifyCode(code)
      if (valid) {
        setCodeState({
          status: 'verified',
          verifiedValue: confirmedCode || code,
          message: practitionerName
            ? `Verified — ${practitionerName}`
            : 'Verified',
        })
      } else {
        setCodeState({
          status: 'invalid',
          verifiedValue: null,
          message: 'Code not found',
        })
      }
    } catch (err) {
      console.warn('[signup] code verify failed:', err)
      setCodeState({
        status: 'invalid',
        verifiedValue: null,
        message: err?.message || 'Could not verify code',
      })
    }
  }

  // If the user edits the code field, reset whatever stuck state we have:
  //   - 'verified' → 'idle' so they have to re-verify before submit
  //   - 'invalid'  → 'idle' so the "Code not found" error disappears
  //                  the moment they start fixing the value
  //   - empty value → always idle (no error for an empty optional field)
  const watchedCode = watch('practitionerCode')
  const watchedCodeTrimmed = String(watchedCode || '').trim()
  if (
    codeState.status === 'verified' &&
    codeState.verifiedValue !== null &&
    watchedCodeTrimmed !== codeState.verifiedValue
  ) {
    setCodeState({ status: 'idle', verifiedValue: null, message: null })
  } else if (codeState.status === 'invalid' && watchedCodeTrimmed === '') {
    setCodeState({ status: 'idle', verifiedValue: null, message: null })
  }

  // ── Submit ──────────────────────────────────────────────────────────
  const onValid = async (values) => {
    setTopError(null)

    // Gate: if email check is in-flight or has flagged duplicate, block.
    if (emailCheckState.status === 'checking') {
      setTopError('Still checking your email — try again in a second.')
      return
    }
    if (emailCheckState.status === 'taken') {
      setTopError('That email is already registered. Please sign in instead.')
      return
    }

    // Gate: if practitionerCode is filled but not verified, block.
    const code = String(values.practitionerCode || '').trim()
    if (code && codeState.status !== 'verified') {
      setTopError(
        'Please verify the practitioner code (click "Verify"), or remove it before submitting.',
      )
      return
    }

    setSubmitting(true)
    try {
      const payload = {
        firstName: values.firstName.trim(),
        lastName: values.lastName.trim(),
        email: values.email.trim().toLowerCase(),
        practitionerCode: code && codeState.status === 'verified'
          ? codeState.verifiedValue
          : null,
      }
      const result = await ApiService.submitSignup(payload)
      onSuccess?.(result)
    } catch (err) {
      // Map structured field errors back to the inputs when possible.
      const fieldErrors = err?.responseData?.result?.fieldErrors
      if (Array.isArray(fieldErrors) && fieldErrors.length) {
        fieldErrors.forEach(({ field, message }) => {
          setError(field, { type: 'server', message })
        })
        setTopError('A few fields need your attention.')
      } else {
        setTopError(err?.message || 'Sign up failed. Please try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const onInvalid = () => {
    setTopError('Oops! A few fields need your attention.')
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  return (
    <div className="ns-signup-page">
      <div className="ns-signup-card">
        <h1>Sign Up</h1>
        <p className="ns-signup-subtitle">
          Already a member?{' '}
          <a href="/account/login" className="ns-signup-link">
            <strong>Log In</strong>
          </a>
        </p>

        {topError && <div className="ns-signup-banner ns-error">{topError}</div>}

        <form onSubmit={handleSubmit(onValid, onInvalid)} noValidate>
          <div className="ns-row ns-row-2">
            <div className="ns-field">
              <Controller
                name="firstName"
                control={control}
                render={({ field }) => (
                  <input
                    {...field}
                    type="text"
                    placeholder="First Name"
                    autoComplete="given-name"
                    onBlur={(e) => {
                      field.onBlur()
                      handleBlurClearIfEmpty('firstName')(e)
                    }}
                    className={`ns-input ${errors.firstName ? 'error' : ''}`}
                  />
                )}
              />
              {errors.firstName && (
                <p className="ns-help error">{errors.firstName.message}</p>
              )}
            </div>

            <div className="ns-field">
              <Controller
                name="lastName"
                control={control}
                render={({ field }) => (
                  <input
                    {...field}
                    type="text"
                    placeholder="Last Name"
                    autoComplete="family-name"
                    onBlur={(e) => {
                      field.onBlur()
                      handleBlurClearIfEmpty('lastName')(e)
                    }}
                    className={`ns-input ${errors.lastName ? 'error' : ''}`}
                  />
                )}
              />
              {errors.lastName && (
                <p className="ns-help error">{errors.lastName.message}</p>
              )}
            </div>
          </div>

          <div className="ns-field">
            <Controller
              name="email"
              control={control}
              render={({ field }) => (
                <div className="ns-email-wrap">
                  <input
                    {...field}
                    type="email"
                    placeholder="Email"
                    autoComplete="email"
                    onChange={(e) => onEmailChange(field, e)}
                    onBlur={(e) => {
                      field.onBlur()
                      onEmailBlur(e.target.value)
                    }}
                    className={`ns-input ${errors.email ? 'error' : ''}`}
                  />
                  {emailCheckState.status === 'checking' && (
                    <span className="ns-input-status ns-checking">Checking…</span>
                  )}
                  {emailCheckState.status === 'available' && (
                    <span className="ns-input-status ns-ok">✓</span>
                  )}
                </div>
              )}
            />
            {errors.email && (
              <p className="ns-help error">{errors.email.message}</p>
            )}
          </div>

          <div className="ns-field">
            <label className="ns-label">Practitioner Code (optional)</label>
            <div className="ns-code-row">
              <Controller
                name="practitionerCode"
                control={control}
                render={({ field }) => (
                  <input
                    {...field}
                    type="text"
                    placeholder="e.g. john_xysnke25"
                    autoComplete="off"
                    spellCheck={false}
                    className={`ns-input ns-code-input ${
                      codeState.status === 'invalid' ? 'error' : ''
                    } ${codeState.status === 'verified' ? 'verified' : ''}`}
                  />
                )}
              />
              <button
                type="button"
                onClick={onVerifyCode}
                disabled={codeState.status === 'verifying'}
                className="ns-verify-btn"
              >
                {codeState.status === 'verifying' ? 'Verifying…' : 'Verify'}
              </button>
            </div>
            {codeState.status === 'invalid' && (
              <p className="ns-help error">{codeState.message}</p>
            )}
            {codeState.status === 'verified' && (
              <p className="ns-help ok">{codeState.message}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="ns-submit"
          >
            {submitting ? 'Signing up…' : 'Sign up'}
          </button>
        </form>

        <p className="ns-signup-footer">
          Are you a practitioner?{' '}
          <a href={WHOLESALE_REGISTRATION_URL} className="ns-signup-link">
            <strong>Sign up as a practitioner →</strong>
          </a>
        </p>
      </div>
    </div>
  )
}
