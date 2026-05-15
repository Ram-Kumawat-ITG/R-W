import * as yup from 'yup'
import { MAX_FILE_SIZE, ACCEPTED_MIME_TYPES, CREDENTIALS, REFERRALS } from '../constants'

const fileTest = (selectedKey, message = 'File is required') =>
  yup
    .mixed()
    .when(selectedKey, {
      is: true,
      then: (s) =>
        s
          .required(message)
          .test('fileSize', 'File must be under 20MB', (f) => !f || f.size <= MAX_FILE_SIZE)
          .test('fileType', 'Allowed: PDF, JPG, PNG', (f) => !f || ACCEPTED_MIME_TYPES.includes(f.type)),
      otherwise: (s) => s.nullable().notRequired(),
    })

const reqWhen = (key, message = 'Required') =>
  yup.string().when(key, {
    is: true,
    then: (s) => s.required(message),
    otherwise: (s) => s.notRequired(),
  })

// Build the per-credential sub-field shape from the constants config
const credentialShape = {}
CREDENTIALS.forEach((cred) => {
  const fields = { selected: yup.boolean() }
  cred.docs.forEach((doc, i) => {
    if (doc.type === 'file') {
      fields[`file${i}`] = fileTest(`credentials.${cred.id}.selected`)
    } else if (doc.type === 'text' || doc.type === 'select') {
      fields[doc.key] = reqWhen(`credentials.${cred.id}.selected`, `${doc.label} required`)
    }
  })
  credentialShape[cred.id] = yup.object(fields)
})

// Referral shape with per-source follow-up text fields
const referralShape = {}
REFERRALS.forEach((ref) => {
  if (ref.exclusive) {
    referralShape[ref.id] = yup.object({ selected: yup.boolean() })
  } else if (ref.field) {
    referralShape[ref.id] = yup.object({
      selected: yup.boolean(),
      value: reqWhen(`referrals.${ref.id}.selected`, `${ref.name} detail required`),
    })
  } else {
    referralShape[ref.id] = yup.object({ selected: yup.boolean() })
  }
})

export const step1Schema = yup.object({
  firstName: yup
    .string()
    .required('First name is required')
    .min(2, 'Too short')
    .matches(/^[A-Za-z\s'-]+$/, 'Letters only'),
  lastName: yup.string().required('Last name is required').min(2, 'Too short'),
  email: yup.string().required('Email is required').email('Enter a valid email'),
  phone: yup
    .string()
    .required('Phone is required')
    .transform((v) => (v ? v.replace(/\D/g, '') : v))
    .matches(/^\d{10}$/, 'Invalid phone number'),
  password: yup
    .string()
    .required('Password is required')
    .min(8, 'At least 8 characters')
    .matches(/[A-Za-z]/, 'Must include a letter')
    .matches(/\d/, 'Must include a number'),
  businessName: yup.string().required('Business name is required'),
  credentials: yup
    .object(credentialShape)
    .test('one-selected', 'Select at least one credential', (c) =>
      c ? Object.values(c).some((x) => x && x.selected === true) : false
    ),
  referrals: yup
    .object(referralShape)
    .test('one-selected', 'Select at least one referral source', (r) =>
      r ? Object.values(r).some((x) => x && x.selected === true) : false
    ),
})

// Field paths react-hook-form trigger() needs for this step
export const step1Fields = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'password',
  'businessName',
  'credentials',
  'referrals',
]
