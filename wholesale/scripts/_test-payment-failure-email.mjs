process.env.SMTP_HOST = 'smtp.test.com'
process.env.SMTP_USER = 'user'
process.env.SMTP_PASSWORD = 'pass'
process.env.SMTP_FROM_EMAIL = 'noreply@test.com'

const { buildPaymentFailureEmail, notifyPaymentFailure } = await import(
  '../app/services/payment/paymentFailureNotification.service.js'
)

const built = buildPaymentFailureEmail({
  customerName: 'Jane Doe',
  invoiceLabel: 'INV-1042',
  amount: 129.5,
  currency: 'usd',
  reason: 'Card declined by issuer',
  supportEmail: 'support@naturalsolutionsphc.com',
})
console.log('---built---')
console.log(built.subject)
console.log(built.text)

console.log('---notify (bad SMTP host, should not throw)---')
const res = await notifyPaymentFailure({
  invoice: {
    _id: 'abc123',
    customerEmail: 'jane@example.com',
    qboDocNumber: '1042',
    amountDue: 129.5,
    amountPaid: 0,
    currency: 'usd',
  },
  reason: 'Card declined by issuer',
  customerName: 'Jane Doe',
})
console.log(JSON.stringify(res))

console.log('---notify (no customerEmail, should short-circuit)---')
const res2 = await notifyPaymentFailure({
  invoice: { _id: 'abc456', amountDue: 50, amountPaid: 0, currency: 'usd' },
  reason: 'No card on file',
})
console.log(JSON.stringify(res2))
