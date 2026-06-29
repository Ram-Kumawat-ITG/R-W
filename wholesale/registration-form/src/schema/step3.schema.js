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

// Commission payout — practitioner chooses between ACH bank transfer
// and paper check. Fields are conditionally required based on
// `commission.payoutMethod`. `useSamePaymentAccount` is a UI-only
// shortcut: when payment method AND payout method are both ACH,
// ticking the box copies values from payment.ach into commission
// fields client-side so the fields still receive valid input and
// validate normally.
//
// ACH-only fields (siblings of `payoutMethod`) use `reqWhenPayoutAch`,
// which works because yup .when looks up `payoutMethod` at the same
// object level. Check fields are nested under `commission.check.*`,
// so their siblings can't see `payoutMethod` directly — we validate
// those via a parent-level `.test()` that walks the whole
// `commission` value and emits per-field errors via ValidationError.

const reqWhenPayoutAch = (msg) =>
  yup.string().when('payoutMethod', {
    is: 'ach',
    then: (s) => s.required(msg),
    otherwise: (s) => s.notRequired(),
  })

export const step3Schema = yup.object({
  payment: yup.object({
    method: yup
      .string()
      .required('Required')
      .oneOf(['check', 'ach', 'card', 'immediate']),
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
  commission: yup.object({
    // `enabled` retained for back-compat with existing docs in Mongo,
    // but always saved as `true` now (no opt-out at signup).
    enabled: yup.boolean(),
    payoutMethod: yup
      .string()
      .required('Choose a payout method')
      .oneOf(['ach', 'check']),
    useSamePaymentAccount: yup.boolean(),
    // ── ACH-only fields (required when payoutMethod === 'ach') ──────
    bankAccountName: reqWhenPayoutAch('Required'),
    bankRoutingNumber: yup.string().when('payoutMethod', {
      is: 'ach',
      then: (s) =>
        s
          .required('Required')
          .matches(/^\d{9}$/, 'Must be exactly 9 digits')
          .test('aba-checksum', 'Invalid routing number', (v) => isValidABA(v)),
      otherwise: (s) => s.notRequired(),
    }),
    bankAccountNumber: yup.string().when('payoutMethod', {
      is: 'ach',
      then: (s) =>
        s
          .required('Required')
          .matches(/^\d{4,17}$/, 'Must be 4 – 17 digits'),
      otherwise: (s) => s.notRequired(),
    }),
    bankAccountType: reqWhenPayoutAch('Required'),
    // ── Check-only fields (required when payoutMethod === 'check') ──
    //
    // Structure is permissive at the field level; required-ness is
    // enforced by the parent `.test()` below so paths land on the
    // exact field that's missing.
    check: yup.object({
      payableTo: yup.string(),
      useBillingAddress: yup.boolean(),
      mailingAddress: yup.object({
        line1: yup.string(),
        line2: yup.string(),
        city: yup.string(),
        state: yup.string(),
        zip: yup
          .string()
          .test('zip-shape', 'Invalid ZIP / postal code', (v) =>
            !v ? true : /^[A-Za-z0-9 -]{3,10}$/.test(v),
          ),
        country: yup.string(),
      }),
    }),
  }).test('commission-check-required', null, function (val) {
    if (val?.payoutMethod !== 'check') return true
    const errs = []
    const push = (path, message) =>
      errs.push(this.createError({ path: `commission.${path}`, message }))
    if (!val?.check?.payableTo?.trim()) push('check.payableTo', 'Required')
    if (!val?.check?.useBillingAddress) {
      const m = val?.check?.mailingAddress || {}
      if (!m.line1?.trim()) push('check.mailingAddress.line1', 'Required')
      if (!m.city?.trim()) push('check.mailingAddress.city', 'Required')
      if (!m.state?.trim()) push('check.mailingAddress.state', 'Required')
      if (!m.zip?.trim()) push('check.mailingAddress.zip', 'Required')
      if (!m.country?.trim()) push('check.mailingAddress.country', 'Required')
    }
    return errs.length === 0 ? true : new yup.ValidationError(errs)
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

export const step3Fields = ['payment', 'commission', 'signature', 'subscribeNews', 'termsAccepted']
