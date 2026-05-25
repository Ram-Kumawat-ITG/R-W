import * as yup from 'yup'

export const step3Schema = yup.object({
  payment: yup.object({
    method: yup
      .string()
      .required('Required')
      .oneOf(['check', 'ach', 'card']),
    cardholderName: yup.string().trim().required('Required'),
    // cardNumber, cardExpiry, cardCvv, cardBrand removed — Collect.js handles validation
  }),
  signature: yup
    .object({ drawn: yup.mixed().nullable() })
    .test('signature-present', 'Please sign before submitting', (s) => Boolean(s?.drawn)),
  subscribeNews: yup.boolean().notRequired(),
  termsAccepted: yup.boolean().notRequired(),
})

export const step3Fields = ['payment', 'signature', 'subscribeNews', 'termsAccepted']
