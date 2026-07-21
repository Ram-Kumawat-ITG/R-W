// Email transport + notification tester.
//
// Sends real notification emails through the configured SMTP transport and
// prints, per message: success/failure, messageId, and (on the Ethereal test
// transport) a clickable preview URL. Use it to confirm the pipeline works and
// — once staging points at a real provider — that mail actually lands.
//
// Usage:
//   npm run test:email                         # sends ALL types to SMTP_FROM_EMAIL
//   npm run test:email -- you@example.com      # sends ALL types to you@example.com
//   npm run test:email -- you@example.com blocked
//
// Or directly:
//   npx vite-node --config scripts/vite-node.config.js scripts/test-email.js [recipient] [type]
//
// Types: all (default) | submitted | approved | declined | blocked | profile
/* eslint-env node */
import 'dotenv/config'
import { emailConfig, assertEmailConfigured } from '../app/services/email/email.config.js'
import {
  notifyApplicationSubmitted,
  notifyApplicationApproved,
  notifyApplicationDeclined,
} from '../app/services/notifications/applicationLifecycleNotification.service.js'
import {
  notifyAccountBlocked,
  notifyProfileUpdated,
} from '../app/services/notifications/accountNotification.service.js'

const recipient = process.argv[2] || emailConfig.fromEmail
const type = (process.argv[3] || 'all').toLowerCase()

const person = {
  email: recipient,
  firstName: 'Test',
  lastName: 'Practitioner',
  businessName: 'Test Clinic',
}

// Each entry: [type key, label, () => Promise<result>]
const ALL = [
  ['submitted', 'Registration acknowledgement', () => notifyApplicationSubmitted(person)],
  ['approved', 'Application approved', () => notifyApplicationApproved(person)],
  ['declined', 'Application declined', () =>
    notifyApplicationDeclined({ ...person, reason: 'Test decline reason' })],
  ['blocked', 'Account blocked', () => notifyAccountBlocked({ ...person, reason: 'Test block reason' })],
  ['profile', 'Profile updated', () =>
    notifyProfileUpdated({ ...person, changes: ['Payment method changed to ACH'], source: 'admin' })],
]

async function main() {
  console.log('\n📧 Email test')
  console.log('   transport:', `${emailConfig.host}:${emailConfig.port} (user ${emailConfig.user || '—'})`)
  console.log('   recipient:', recipient)
  console.log('   type:', type, '\n')

  try {
    assertEmailConfigured()
  } catch (e) {
    console.error('❌ SMTP not configured —', e.message)
    console.error('   Set SMTP_HOST / SMTP_USER / SMTP_PASSWORD / SMTP_FROM_EMAIL.')
    process.exit(1)
  }

  const selected = type === 'all' ? ALL : ALL.filter(([key]) => key === type)
  if (!selected.length) {
    console.error(`❌ Unknown type "${type}". Use: all | ${ALL.map(([k]) => k).join(' | ')}`)
    process.exit(1)
  }

  let allOk = true
  for (const [, label, run] of selected) {
    process.stdout.write(`→ ${label} … `)
    let result
    try {
      result = await run()
    } catch (e) {
      result = { success: false, error: e?.message || String(e) }
    }
    if (result?.success) {
      console.log('✅ sent')
      if (result.previewUrl) console.log(`   preview: ${result.previewUrl}`)
    } else if (result?.skipped) {
      console.log(`⏭️  skipped (${result.reason})`)
    } else {
      allOk = false
      console.log(`❌ FAILED — ${result?.error || 'unknown error'}`)
    }
  }

  console.log(`\n${allOk ? '✅ All sends accepted by SMTP.' : '❌ One or more sends failed (see above).'}`)
  console.log('Note: on the Ethereal test transport, "sent" means captured — open the preview URL to view; it is NOT delivered to a real inbox.\n')
  process.exit(allOk ? 0 : 2)
}

main()
