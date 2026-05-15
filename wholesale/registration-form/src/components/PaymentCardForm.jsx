import { Controller, useWatch } from 'react-hook-form'
import { CARD_BRANDS, CARD_BRAND_LABELS } from '../constants'

// Detect card brand from the first digits (mirrors the prototype HTML)
function detectCardBrand(num) {
  const n = (num || '').replace(/\s/g, '')
  if (!n) return null
  if (/^4/.test(n)) return 'visa'
  if (/^(?:5[1-5]|2[2-7])/.test(n)) return 'mastercard'
  if (/^3[47]/.test(n)) return 'amex'
  if (/^6(?:011|5)/.test(n)) return 'discover'
  return null
}

// 4-4-4-4 grouping (Amex is 4-6-5). Strips any non-digits.
function formatCardNumber(num) {
  const raw = (num || '').replace(/\D/g, '')
  if (/^3[47]/.test(raw)) {
    const a = raw.slice(0, 4)
    const b = raw.slice(4, 10)
    const c = raw.slice(10, 15)
    return [a, b, c].filter(Boolean).join(' ')
  }
  const clipped = raw.slice(0, 19)
  return clipped.replace(/(\d{4})(?=\d)/g, '$1 ')
}

function formatExpiry(value) {
  const raw = (value || '').replace(/\D/g, '').slice(0, 4)
  if (raw.length >= 3) return raw.slice(0, 2) + ' / ' + raw.slice(2)
  return raw
}

export default function PaymentCardForm({ control, errors, setValue }) {
  const cardNumber = useWatch({ control, name: 'payment.cardNumber' })
  const detectedBrand = detectCardBrand(cardNumber)
  const selectedBrand = useWatch({ control, name: 'payment.cardBrand' })

  // Auto-pick the chip when the card number prefix matches a known brand
  // (but don't overwrite a manual "Other" pick or once the user has typed a known card brand).
  if (detectedBrand && detectedBrand !== selectedBrand) {
    setValue('payment.cardBrand', detectedBrand, { shouldDirty: false })
  }

  return (
    <div>
      <div className="rf-field">
        <label className="rf-label">Card type <span className="rf-req">*</span></label>
        <Controller
          name="payment.cardBrand"
          control={control}
          defaultValue=""
          render={({ field }) => (
            <div className="rf-card-type-selector">
              {CARD_BRANDS.map((brand) => (
                <button
                  type="button"
                  key={brand}
                  className={`rf-card-chip ${field.value === brand ? 'active' : ''}`}
                  onClick={() => field.onChange(brand)}
                >
                  {CARD_BRAND_LABELS[brand]}
                </button>
              ))}
            </div>
          )}
        />
        {errors?.payment?.cardBrand?.message && (
          <p className="rf-help error">{errors.payment.cardBrand.message}</p>
        )}
        <p className="rf-help">Auto-selects when you enter your card number — or pick manually.</p>
      </div>

      <div className="rf-field">
        <label className="rf-label">Cardholder name <span className="rf-req">*</span></label>
        <Controller
          name="payment.cardholderName"
          control={control}
          defaultValue=""
          render={({ field }) => (
            <input
              {...field}
              type="text"
              placeholder="Name on card"
              autoComplete="cc-name"
              className={`rf-input ${errors?.payment?.cardholderName ? 'error' : ''}`}
            />
          )}
        />
        {errors?.payment?.cardholderName?.message && (
          <p className="rf-help error">{errors.payment.cardholderName.message}</p>
        )}
      </div>

      <div className="rf-field">
        <label className="rf-label">Card number <span className="rf-req">*</span></label>
        <Controller
          name="payment.cardNumber"
          control={control}
          defaultValue=""
          render={({ field }) => (
            <input
              type="text"
              placeholder="1234 5678 9012 3456"
              inputMode="numeric"
              autoComplete="cc-number"
              maxLength={23}
              value={field.value || ''}
              onChange={(e) => field.onChange(formatCardNumber(e.target.value))}
              onBlur={field.onBlur}
              className={`rf-input ${errors?.payment?.cardNumber ? 'error' : ''}`}
              style={{ fontVariantNumeric: 'tabular-nums', letterSpacing: '0.02em' }}
            />
          )}
        />
        {errors?.payment?.cardNumber?.message && (
          <p className="rf-help error">{errors.payment.cardNumber.message}</p>
        )}
      </div>

      <div className="rf-field rf-row rf-row-2">
        <div>
          <label className="rf-label">Expiry <span className="rf-req">*</span></label>
          <Controller
            name="payment.cardExpiry"
            control={control}
            defaultValue=""
            render={({ field }) => (
              <input
                type="text"
                placeholder="MM / YY"
                inputMode="numeric"
                autoComplete="cc-exp"
                maxLength={7}
                value={field.value || ''}
                onChange={(e) => field.onChange(formatExpiry(e.target.value))}
                onBlur={field.onBlur}
                className={`rf-input ${errors?.payment?.cardExpiry ? 'error' : ''}`}
              />
            )}
          />
          {errors?.payment?.cardExpiry?.message && (
            <p className="rf-help error">{errors.payment.cardExpiry.message}</p>
          )}
        </div>
        <div>
          <label className="rf-label">CVV <span className="rf-req">*</span></label>
          <Controller
            name="payment.cardCvv"
            control={control}
            defaultValue=""
            render={({ field }) => (
              <input
                {...field}
                type="text"
                placeholder="123"
                inputMode="numeric"
                autoComplete="cc-csc"
                maxLength={4}
                onChange={(e) => field.onChange((e.target.value || '').replace(/\D/g, '').slice(0, 4))}
                className={`rf-input ${errors?.payment?.cardCvv ? 'error' : ''}`}
              />
            )}
          />
          {errors?.payment?.cardCvv?.message && (
            <p className="rf-help error">{errors.payment.cardCvv.message}</p>
          )}
        </div>
      </div>
    </div>
  )
}
