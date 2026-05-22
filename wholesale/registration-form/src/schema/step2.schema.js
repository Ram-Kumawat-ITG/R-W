import * as yup from 'yup'
import { validateZipForState, validateCityForState } from '../utils/zipValidation'

const addressShape = (countryField) => ({
  line1: yup.string().trim().required('Required'),
  line2: yup.string().trim().notRequired(),
  city: yup
    .string()
    .trim()
    .required('Required')
    .test('city-state-match', 'City not found in the selected state', async function (city) {
      const { state, country } = this.parent
      if (country !== 'United States' || !city || !state) return true
      const result = await validateCityForState(city, state)
      if (result.valid) return true
      return this.createError({ message: result.message })
    }),
  state: yup.string().trim().required('Required'),
  zip: yup
    .string()
    .trim()
    .required('Required')
    .when(countryField, {
      is: 'United States',
      then: (s) =>
        s
          .matches(/^\d{5}(-\d{4})?$/, 'Enter a valid US ZIP (e.g. 90210)')
          .test('zip-state-match', 'ZIP code does not match the selected state', async function (zip) {
            const { state } = this.parent
            if (!zip || !state) return true
            const result = await validateZipForState(zip, state)
            if (result.valid) return true
            return this.createError({ message: result.message })
          }),
    }),
  country: yup.string().trim().required('Required'),
})

export const step2Schema = yup.object({
  billingAddress: yup.object(addressShape('billingAddress.country')),
  shippingSameAsBilling: yup.boolean().required(),
  shippingAddress: yup.object().when('shippingSameAsBilling', {
    is: false,
    then: () => yup.object(addressShape('shippingAddress.country')),
    otherwise: (s) => s.nullable().notRequired(),
  }),
  shippingPropertyType: yup
    .string()
    .required('Required')
    .oneOf(['Residential', 'Commercial'], 'Invalid value'),
  resellsProducts: yup.boolean().required(),
  tax: yup.object().when('resellsProducts', {
    is: true,
    then: () =>
      yup.object({
        taxIdType: yup.string().trim().required('Required').oneOf(['ein', 'ssn']),
        taxId: yup.string().trim().required('Required')
          .when('taxIdType', {
            is: 'ein',
            then: (s) => s.matches(/^\d{2}-?\d{7}$/, 'Enter a valid 9-digit EIN (e.g. 12-3456789)'),
            otherwise: (s) => s.matches(/^\d{3}-?\d{2}-?\d{4}$/, 'Enter a valid 9-digit SSN (e.g. 123-45-6789)'),
          }),
        salesPermit: yup.string().trim().notRequired(),
        exemptState: yup.string().trim().required('Required'),
        itemsToResell: yup.string().trim().required('Required'),
        businessActivity: yup.string().trim().required('Required'),
      }),
    otherwise: (s) => s.notRequired(),
  }),
})

export const step2Fields = [
  // Billing address — always rendered, use nested paths so RHF triggers each registered field
  'billingAddress.line1',
  'billingAddress.city',
  'billingAddress.state',
  'billingAddress.zip',
  'billingAddress.country',
  // Conditional sections — top-level only; sub-fields are registered when visible,
  // so trigger(parentKey) correctly validates all mounted children
  'shippingSameAsBilling',
  'shippingAddress',
  'shippingPropertyType',
  'resellsProducts',
  'tax',
]
