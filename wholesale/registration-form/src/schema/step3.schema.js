import * as yup from 'yup'

// Card on file is mandatory for every account (per the prototype's rule).
// All card fields are required regardless of which payment method is preferred.
export const step3Schema = yup.object({
  payment: yup.object({
    method: yup
      .string()
      .required('Required')
      .oneOf(['check', 'ach', 'card']),
    cardholderName: yup.string().required('Required'),
    cardBrand: yup
      .string()
      .required('Card brand could not be detected — enter a Visa, Mastercard, Discover, or AMEX card number')
      .oneOf(['visa', 'mastercard', 'discover', 'amex'], 'Only Visa, Mastercard, Discover, and AMEX are accepted'),
    cardNumber: yup
      .string()
      .required('Required')
      .test('digit-count', 'Enter a valid card number', (v) => {
        const digits = (v || '').replace(/\D/g, '')
        return digits.length >= 13 && digits.length <= 19
      }),
    cardExpiry: yup
      .string()
      .required('Required')
      .test('valid-expiry', 'Use MM / YY in the future', (v) => {
        const m = (v || '').match(/^(\d{2})\s*\/?\s*(\d{2})$/)
        if (!m) return false
        const month = Number(m[1])
        const year = 2000 + Number(m[2])
        if (month < 1 || month > 12) return false
        const now = new Date()
        const endOfMonth = new Date(year, month, 0, 23, 59, 59)
        return endOfMonth >= now
      }),
    cardCvv: yup
      .string()
      .required('Required')
      .matches(/^\d{3,4}$/, 'CVV must be 3 or 4 digits'),
  }),
  signature: yup
    .object({
      type: yup.string().required().oneOf(['draw', 'type']),
      drawn: yup.mixed().nullable(),
      typed: yup.string(),
    })
    .test('signature-present', 'Please sign before submitting', (s) => {
      if (!s) return false
      if (s.type === 'draw') return Boolean(s.drawn)
      if (s.type === 'type') return Boolean(s.typed && s.typed.trim())
      return false
    }),
  subscribeNews: yup.boolean().notRequired(),
  termsAccepted: yup.boolean().notRequired(),
})

export const step3Fields = ['payment', 'signature', 'subscribeNews', 'termsAccepted']
