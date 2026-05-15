import * as yup from 'yup'

const addressShape = (countryField) => ({
  line1: yup.string().required('Required'),
  line2: yup.string().notRequired(),
  city: yup.string().required('Required'),
  state: yup.string().required('Required'),
  zip: yup
    .string()
    .required('Required')
    .when(countryField, {
      is: 'United States',
      then: (s) => s.matches(/^\d{5}(-\d{4})?$/, 'Enter a valid US ZIP'),
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
    .required('Select Residential or Commercial')
    .oneOf(['Residential', 'Commercial'], 'Invalid value'),
  resellsProducts: yup.boolean().required(),
  tax: yup.object().when('resellsProducts', {
    is: true,
    then: () =>
      yup.object({
        taxIdType: yup.string().required('Required').oneOf(['ein', 'ssn']),
        taxId: yup.string().required('Tax ID is required'),
        salesPermit: yup.string().notRequired(),
        exemptState: yup.string().required('Exempt state is required'),
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
