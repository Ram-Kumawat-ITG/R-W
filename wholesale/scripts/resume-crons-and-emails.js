/* eslint-env node */
// Resume everything that was paused on 2026-07-29 (scheduled jobs + email).
//
// There are three independent switches; this script owns the two that live in
// MongoDB and therefore survive a restart:
//
//   1. env SCHEDULER_DISABLED / CDO_SCHEDULER_DISABLED  -> NOT handled here.
//      Flip these to false in the environment (local .env + the Render
//      dashboard for staging/production) and restart the app. On boot,
//      ensureRecurring() calls agenda.every(), which re-creates AND re-enables
//      every recurring job document, so the agenda collections self-heal.
//   2. cron_notification_settings.emailNotificationsPaused (the GLOBAL email
//      kill switch — SMTP + QBO invoice emails + Shopify invites). A restart
//      does NOT clear this. Resumed here.
//   3. `disabled: true` on individual job docs in `agenda_jobs` (wholesale) /
//      `cdo_agenda_jobs` (ns-retail). Cleared here so the jobs run even before
//      the next boot re-registers them.
//
// Both Mongo steps are idempotent — re-running is a no-op.
//
// Usage:
//   npm run resume:crons -- --dry-run   # report current state, write nothing
//   npm run resume:crons                # apply
//
// Point MONGODB_URI / DATABASE_NAME at the environment you mean to resume.
// (Runs via vite-node so the app's ESM + extensionless imports resolve.)

import mongoose from 'mongoose'
import connectDB from '../app/services/APIService/mongo.service.js'
import { resumeEmailNotifications } from '../app/services/scheduler/cronNotificationSettings.service.js'

const dryRun = process.argv.includes('--dry-run')

const AGENDA_COLLECTIONS = ['agenda_jobs', 'cdo_agenda_jobs']

async function main() {
  await connectDB()
  const db = mongoose.connection.db
  console.log(`[resume] db=${db.databaseName}${dryRun ? ' (DRY RUN — no writes)' : ''}\n`)

  // ── 1. Global email kill switch ──────────────────────────────────────────
  // Read the singleton directly rather than via getNotificationSettings() —
  // that helper creates the doc when missing, which a dry run must not do.
  const before = (await db.collection('cron_notification_settings').findOne({})) || {}
  if (before.emailNotificationsPaused === true) {
    console.log(
      `[resume] email notifications are PAUSED (by ${before.pausedBy || 'unknown'} at ${before.pausedAt || '?'}` +
        `${before.pauseNote ? `, note: "${before.pauseNote}"` : ''})`,
    )
    if (dryRun) {
      console.log('[resume] would resume email notifications')
    } else {
      await resumeEmailNotifications({ by: 'scripts/resume-crons-and-emails' })
      console.log('[resume] email notifications RESUMED')
    }
  } else {
    console.log('[resume] email notifications already active — nothing to do')
  }

  // ── 2. Disabled recurring job documents ─────────────────────────────────
  for (const name of AGENDA_COLLECTIONS) {
    const exists = await db.listCollections({ name }).hasNext()
    if (!exists) {
      console.log(`\n[resume] ${name}: collection does not exist yet (created on first boot)`)
      continue
    }
    const coll = db.collection(name)
    const jobs = await coll
      .find({}, { projection: { name: 1, disabled: 1, nextRunAt: 1, repeatInterval: 1 } })
      .toArray()
    const disabled = jobs.filter((j) => j.disabled === true)
    console.log(`\n[resume] ${name}: ${jobs.length} job doc(s), ${disabled.length} disabled`)
    for (const j of jobs) {
      console.log(
        `   ${j.disabled === true ? 'OFF' : 'ON '} ${j.name} ` +
          `| interval=${j.repeatInterval ?? '—'} | nextRunAt=${j.nextRunAt ? new Date(j.nextRunAt).toISOString() : 'null'}`,
      )
    }
    if (!disabled.length) continue
    if (dryRun) {
      console.log(`[resume] would re-enable ${disabled.length} job(s) in ${name}`)
      continue
    }
    // Clear the flag only. nextRunAt is deliberately left alone: the restored
    // timestamps are in the past, and boot's agenda.every() recomputes a
    // correct next run for every recurring job anyway.
    const res = await coll.updateMany({ disabled: true }, { $set: { disabled: false } })
    console.log(`[resume] re-enabled ${res.modifiedCount} job(s) in ${name}`)
  }

  console.log(
    '\n[resume] done. Remaining manual step: ensure SCHEDULER_DISABLED=false ' +
      '(wholesale) and CDO_SCHEDULER_DISABLED=false (ns-retail) in the target ' +
      'environment, then restart so the schedulers boot and re-register.',
  )
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[resume] FAILED:', err?.stack || err)
    process.exit(1)
  })
