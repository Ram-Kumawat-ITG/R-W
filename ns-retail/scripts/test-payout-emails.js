/**
 * Test script for ns-retail payout notifications — sends sample emails to verify
 * the new table-based templates render correctly.
 * 
 * Usage: vite-node --config scripts/vite-node.config.js scripts/test-payout-emails.js [type]
 * 
 * Supported types:
 *   - all (default): sends all test emails
 *   - payout-processed
 *   - payout-failed
 *   - batch-summary
 */

import { 
  notifyCommissionPayoutProcessed,
  notifyCommissionPayoutFailed,
  notifyPayoutBatchSummary,
} from '../app/services/notifications/payoutNotification.service.js'

const testEmail = process.env.TEST_EMAIL || 'test@example.com'
const notificationType = process.argv[2] || 'all'

console.log(`\n📧 Payout Notification Test (ns-retail)\n`)
console.log(`Sending to: ${testEmail}`)
console.log(`Type: ${notificationType}\n`)

async function runTests() {
  try {
    // Test 1: Commission Payout Processed
    if (notificationType === 'all' || notificationType === 'payout-processed') {
      console.log('📤 Sending: Commission Payout Processed...')
      await notifyCommissionPayoutProcessed({
        email: testEmail,
        practitionerName: 'Dr. Sarah Johnson',
        amount: 1250.50,
        currency: 'USD',
        method: 'ach',
        reference: 'ACH-2026-07-001',
        paidAt: new Date().toISOString()
      })
      console.log('✅ Commission Payout Processed sent\n')
    }

    // Test 2: Commission Payout Failed
    if (notificationType === 'all' || notificationType === 'payout-failed') {
      console.log('📤 Sending: Commission Payout Failed...')
      await notifyCommissionPayoutFailed({
        email: testEmail,
        practitionerName: 'Dr. Michael Chen',
        amount: 875.00,
        currency: 'USD',
        reference: 'CHK-2026-07-015',
        reason: 'Bank account verification failed',
        returnCode: 'BANK_VERIFY_FAILED',
        failedAt: new Date().toISOString()
      })
      console.log('✅ Commission Payout Failed sent\n')
    }

    // Test 3: Payout Batch Summary
    if (notificationType === 'all' || notificationType === 'batch-summary') {
      console.log('📤 Sending: Payout Batch Summary (admin)...')
      await notifyPayoutBatchSummary({
        reference: 'BATCH-2026-07-15',
        status: 'paid',
        startedAt: new Date(Date.now() - 180000).toISOString(),
        completedAt: new Date().toISOString(),
        totalPractitioners: 18,
        totalAmount: 18750.25,
        paidCount: 16,
        failedCount: 2,
        skippedCount: 0,
        rows: [
          {
            practitionerName: 'Dr. Sarah Johnson',
            practitionerEmail: 'sarah@wellness.com',
            totalAmount: 1250.50,
            currency: 'USD',
            commissionCount: 12,
            status: 'paid',
            txnRef: 'ACH-2026-07-001',
            processedAt: new Date(Date.now() - 60000).toISOString()
          },
          {
            practitionerName: 'Dr. Michael Chen',
            practitionerEmail: 'michael@clinic.com',
            totalAmount: 875.00,
            currency: 'USD',
            commissionCount: 8,
            status: 'failed',
            txnRef: 'CHK-2026-07-015',
            processedAt: new Date(Date.now() - 30000).toISOString()
          },
          {
            practitionerName: 'Dr. Emily Rodriguez',
            practitionerEmail: 'emily@health.com',
            totalAmount: 2100.75,
            currency: 'USD',
            commissionCount: 15,
            status: 'paid',
            txnRef: 'ACH-2026-07-002',
            processedAt: new Date(Date.now() - 30000).toISOString()
          },
        ]
      })
      console.log('✅ Payout Batch Summary sent\n')
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
