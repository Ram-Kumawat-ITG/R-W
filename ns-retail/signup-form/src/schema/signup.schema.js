import * as yup from 'yup'

// Regex patterns intentionally identical to wholesale/registration-form/src/schema/step1.schema.js
// so the two forms apply the same validation rules across both stores.
const NAME_REGEX = /^[A-Za-zÀ-ÖØ-öø-ÿ' -]+$/
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const signupSchema = yup.object({
  firstName: yup
    .string()
    .trim()
    .required('Required')
    .min(3, 'Too short')
    .matches(NAME_REGEX, 'Only letters, spaces, hyphens, and apostrophes allowed'),
  lastName: yup
    .string()
    .trim()
    .required('Required')
    .min(3, 'Too short')
    .matches(NAME_REGEX, 'Only letters, spaces, hyphens, and apostrophes allowed'),
  email: yup
    .string()
    .trim()
    .required('Required')
    .matches(EMAIL_REGEX, 'Enter a valid email'),
  // Password field removed — retail store uses Shopify's passwordless
  // (new) customer accounts. Shopify sends an OTP activation email after
  // customerCreate; the user sets up auth on Shopify's hosted page.
  // Practitioner code is optional. If filled, it MUST be verified before
  // submit — the form blocks submit until the user clicks the Verify
  // button and the backend confirms the code exists. Validation here is
  // just for format; the "must be verified" gate lives in SignupForm.jsx.
  practitionerCode: yup
    .string()
    .trim()
    .notRequired(),
})

export const signupFields = [
  'firstName',
  'lastName',
  'email',
  'practitionerCode',
]
