import * as yup from 'yup'
import { validateZipForState, validateCityForState } from '../utils/zipValidation'

const addressShape = (countryField) => ({
  line1: yup.string().required('Required'),
  line2: yup.string().notRequired(),
  city: yup
    .string()
    .required('Required')
    .test('city-state-match', 'City not found in the selected state', async function (city) {
      const { state, country } = this.parent
      if (country !== 'United States' || !city || !state) return true
      const result = await validateCityForState(city, state)
      if (result.valid) return true
      return this.createError({ message: result.message })
    }),
  state: yup.string().required('Required'),
  zip: yup
    .string()
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
  country: yup.string().required('Required'),
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
        taxIdType: yup.string().required('Required').oneOf(['ein', 'ssn']),
        taxId: yup.string().required('Required'),
        salesPermit: yup.string().notRequired(),
        exemptState: yup.string().required('Required'),
        itemsToResell: yup.string().required('Required'),
        businessActivity: yup.string().required('Required'),
      }),
    otherwise: (s) => s.notRequired(),
  }),
})

export const step2Fields = [
  'billingAddress',
  'shippingSameAsBilling',
  'shippingAddress',
  'shippingPropertyType',
  'resellsProducts',
  'tax',
]
