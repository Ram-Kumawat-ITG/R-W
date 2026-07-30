// One-off diagnostic: prove whether the registration + block notifications
// actually fire and are accepted by the configured SMTP.
// Run: npx vite-node --config scripts/vite-node.config.js scripts/check-email-send.js [recipient]
/* eslint-env node */
import 'dotenv/config'
import { emailConfig, assertEmailConfigured } from '../app/services/email/email.config.js'
import { notifyApplicationSubmitted } from '../app/services/notifications/applicationLifecycleNotification.service.js'
import { notifyAccountBlocked } from '../app/services/notifications/accountNotification.service.js'

console.log('[check-email] transport target:', {
  host: emailConfig.host,
  port: emailConfig.port,
  user: emailConfig.user,
  fromEmail: emailConfig.fromEmail,
})

try {
  assertEmailConfigured()
  console.log('[check-email] assertEmailConfigured: OK')
} catch (e) {
  console.error('[check-email] assertEmailConfigured FAILED:', e.message)
  process.exit(1)
}

const to = process.argv[2] || emailConfig.fromEmail
const person = { email: to, firstName: 'Test', lastName: 'Practitioner', businessName: 'Test Clinic' }

console.log('\n[check-email] 1/2 registration acknowledgement → notifyApplicationSubmitted')
const submitted = await notifyApplicationSubmitted(person)
console.log('   result:', submitted)

console.log('\n[check-email] 2/2 account blocked → notifyAccountBlocked')
const blocked = await notifyAccountBlocked({ ...person, reason: 'diagnostic test' })
console.log('   result:', blocked)

const ok = submitted?.success && blocked?.success
console.log(`\n[check-email] DONE — both accepted by SMTP: ${ok ? 'YES' : 'NO'}`)
process.exit(ok ? 0 : 2)
