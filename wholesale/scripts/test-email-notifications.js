/**
 * Test script for email notifications — sends sample emails to verify
 * the new table-based templates render correctly in email clients.
 * 
 * Usage: vite-node --config scripts/vite-node.config.js scripts/test-email-notifications.js [type]
 * Or: npm run test:emails
 * 
 * Supported types:
 *   - all (default): sends all test emails
 *   - application-submitted
 *   - application-approved
 *   - application-declined
 *   - payment-failed
 *   - batch-summary
 */

// Import notification services
import { 
  notifyApplicationSubmitted,
  notifyApplicationApproved,
  notifyApplicationDeclined
} from '../app/services/notifications/applicationLifecycleNotification.service.js'
import { notifyPaymentFailure } from '../app/services/payment/paymentFailureNotification.service.js'
import { sendBatchSummaryEmail } from '../app/services/scheduler/batchSummaryNotification.service.js'

const testEmail = process.env.TEST_EMAIL || 'test@example.com'
const notificationType = process.argv[2] || 'all'

console.log(`\n📧 Email Notification Test\n`)
console.log(`Sending to: ${testEmail}`)
console.log(`Type: ${notificationType}\n`)

async function runTests() {
  try {
    // Test 1: Application Submitted
    if (notificationType === 'all' || notificationType === 'application-submitted') {
      console.log('📤 Sending: Application Submitted...')
      await notifyApplicationSubmitted({
        email: testEmail,
        firstName: 'Jane',
        lastName: 'Smith',
        businessName: 'Smith Wellness Clinic',
        applicationDate: new Date().toISOString()
      })
      console.log('✅ Application Submitted sent\n')
    }

    // Test 2: Application Approved
    if (notificationType === 'all' || notificationType === 'application-approved') {
      console.log('📤 Sending: Application Approved...')
      await notifyApplicationApproved({
        email: testEmail,
        firstName: 'Jane',
        lastName: 'Smith',
        businessName: 'Smith Wellness Clinic',
        approvedAt: new Date().toISOString()
      })
      console.log('✅ Application Approved sent\n')
    }

    // Test 3: Application Declined
    if (notificationType === 'all' || notificationType === 'application-declined') {
      console.log('📤 Sending: Application Declined...')
      await notifyApplicationDeclined({
        email: testEmail,
        firstName: 'John',
        lastName: 'Doe',
        businessName: 'Doe Health Services',
        reason: 'Payment method could not be verified'
      })
      console.log('✅ Application Declined sent\n')
    }

    // Test 4: Payment Failed
    if (notificationType === 'all' || notificationType === 'payment-failed') {
      console.log('📤 Sending: Payment Failed...')
      const mockInvoice = {
        _id: { toString: () => 'test-invoice-001' },
        customerEmail: testEmail,
        shopifyOrderId: '123456789',
        qboDocNumber: 'INV-001',
        qboInvoiceId: 'qbo-id-001',
        amountDue: 250.00,
        amountPaid: 0,
        currency: 'USD',
        paymentMethod: 'card',
        attemptCount: 1,
        maxAttempts: 3
      }
      await notifyPaymentFailure({
        invoice: mockInvoice,
        reason: 'Card declined — insufficient funds',
        customerName: 'Jane Smith',
        orderLabel: '#123456789',
        orderDate: new Date(Date.now() - 86400000).toISOString() // yesterday
      })
      console.log('✅ Payment Failed sent\n')
    }

    // Test 5: Batch Summary
    if (notificationType === 'all' || notificationType === 'batch-summary') {
      console.log('📤 Sending: CRON Batch Summary (admin)...')
      await sendBatchSummaryEmail({
        jobName: 'process-pending-payments',
        tick: 42,
        tickId: 'test-tick-001',
        status: 'partial',
        startedAt: new Date(Date.now() - 120000).toISOString(), // 2 min ago
        finishedAt: new Date().toISOString(),
        durationMs: 120000,
        processed: 42,
        approved: 40,
        declined: 1,
        errored: 1,
        skipped: 0,
        followupsLogged: 2,
        sweepProcessed: 8,
        sweepOk: 7,
        sweepFailed: 1,
        totalInvoiceAmount: 12450.75,
        totalPractitioners: 32,
        errorDetails: [
          { qboInvoiceId: 'INV-401', invoiceId: 'inv-401', message: 'NMI gateway timeout' },
          { qboInvoiceId: 'INV-402', invoiceId: 'inv-402', message: 'QBO customer sync failed' }
        ]
      })
      console.log('✅ Batch Summary sent\n')
    }

    console.log('🎉 All tests completed successfully!\n')
  } catch (error) {
    console.error('\n❌ Error sending test emails:')
    console.error(error.message)
    if (error.stack) {
      console.error(error.stack)
    }
    process.exit(1)
  }
}

runTests()
