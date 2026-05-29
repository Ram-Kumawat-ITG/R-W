import * as yup from 'yup'

// ABA routing-number checksum. NMI validates this server-side and rejects
// invalid numbers with "Invalid ABA number". Catching it here gives faster
// feedback and avoids creating an orphan NMI vault on submit.
//
// The check digit (9th digit) is computed so that:
//   (3*d1 + 7*d2 + d3 + 3*d4 + 7*d5 + d6 + 3*d7 + 7*d8 + d9) mod 10 == 0
function isValidABA(routing) {
  if (!/^\d{9}$/.test(String(routing || ''))) return false
  const d = String(routing).split('').map(Number)
  const sum =
    3 * d[0] + 7 * d[1] + d[2] +
    3 * d[3] + 7 * d[4] + d[5] +
    3 * d[6] + 7 * d[7] + d[8]
  return sum % 10 === 0
}

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
          .matches(/^\d{9}$/, 'Must be exactly 9 digits')
          .test('aba-checksum', 'Invalid routing number', (v) => isValidABA(v)),
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
