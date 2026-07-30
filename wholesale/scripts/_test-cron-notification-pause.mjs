const {
  isEmailNotificationsPaused,
  getNotificationSettings,
  pauseEmailNotifications,
  resumeEmailNotifications,
} = await import('../app/services/scheduler/cronNotificationSettings.service.js')
const { sendBatchSummaryEmail } = await import('../app/services/scheduler/batchSummaryNotification.service.js')
const { notifyPaymentFailure } = await import('../app/services/payment/paymentFailureNotification.service.js')

console.log('--- initial state ---')
console.log(JSON.stringify(await getNotificationSettings(), null, 2))
console.log('isPaused:', await isEmailNotificationsPaused())

console.log('\n--- pause ---')
console.log(JSON.stringify(await pauseEmailNotifications({ by: 'test@example.com', note: 'testing pause' }), null, 2))
console.log('isPaused:', await isEmailNotificationsPaused())

console.log('\n--- attempt sendBatchSummaryEmail while paused (should skip, not send) ---')
console.log(JSON.stringify(await sendBatchSummaryEmail({ jobName: 'process-pending-payments', tick: 'manual', tickId: 'test01', status: 'success', processed: 1, approved: 1, declined: 0, errored: 0, skipped: 0 }), null, 2))

console.log('\n--- attempt notifyPaymentFailure while paused (should skip, not send) ---')
console.log(JSON.stringify(await notifyPaymentFailure({ invoice: { _id: 'x', customerEmail: process.env.SMTP_FROM_EMAIL, amountDue: 10, amountPaid: 0, currency: 'usd' }, reason: 'test' }), null, 2))

console.log('\n--- resume ---')
console.log(JSON.stringify(await resumeEmailNotifications({ by: 'test@example.com' }), null, 2))
console.log('isPaused:', await isEmailNotificationsPaused())

console.log('\n--- sendBatchSummaryEmail after resume (should actually send) ---')
console.log(JSON.stringify(await sendBatchSummaryEmail({ jobName: 'process-pending-payments', tick: 'manual', tickId: 'test02', status: 'success', processed: 1, approved: 1, declined: 0, errored: 0, skipped: 0 }), null, 2))
