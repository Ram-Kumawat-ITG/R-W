import * as yup from 'yup'

const reqWhenAch = (msg) =>
  yup.string().when('method', {
    is: 'ach',
    then: (s) => s.required(msg),
    otherwise: (s) => s.notRequired(),
  })

export const step3Schema = yup.object({
  payment: yup.object({
    method: yup
      .string()
      .required('Required')
      .oneOf(['check', 'ach', 'card']),
    cardholderName: yup.string().trim().required('Required'),
    achAccountName: reqWhenAch('Required'),
    achRoutingNumber: yup.string().when('method', {
      is: 'ach',
      then: (s) =>
        s
          .required('Required')
          .matches(/^\d{9}$/, 'Must be exactly 9 digits'),
      otherwise: (s) => s.notRequired(),
    }),
    achAccountNumber: yup.string().when('method', {
      is: 'ach',
      then: (s) =>
        s
          .required('Required')
          .matches(/^\d{4,17}$/, 'Must be 4 – 17 digits'),
      otherwise: (s) => s.notRequired(),
    }),
    achAccountType: reqWhenAch('Required'),
    // cardNumber, cardExpiry, cardCvv, cardBrand removed — Collect.js handles validation
  }),
  signature: yup
    .object({ drawn: yup.mixed().nullable() })
    .test('signature-present', 'Please sign before submitting', (s) => Boolean(s?.drawn)),
  subscribeNews: yup.boolean().notRequired(),
  termsAccepted: yup
    .boolean()
    .oneOf([true], 'Please accept the Terms & Conditions')
    .required('Please accept the Terms & Conditions'),
})

export const step3Fields = ['payment', 'signature', 'subscribeNews', 'termsAccepted']
