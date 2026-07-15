// Global pause/resume control for the process-pending-payments CRON's two
// email notifications (customer "Payment Failed" + admin "Batch Processing
// Summary"). Backed by a one-row singleton (models/cronNotificationSettings.
// server.js) so the toggle is admin-UI-controllable and survives restarts —
// env vars can't be flipped without a redeploy, which doesn't fit "pause
// this for now, resume later today" usage.
//
// Charge processing is never gated by this — only notifyPaymentFailure()
// and sendBatchSummaryEmail() check it, each via isEmailNotificationsPaused().

import connectDB from '../APIService/mongo.service'
import CronNotificationSettings from '../../models/cronNotificationSettings.server'

async function getOrCreateSettings() {
  await connectDB()
  let doc = await CronNotificationSettings.findOne()
  if (!doc) doc = await CronNotificationSettings.create({})
  return doc
}

function shapeSettings(doc) {
  return {
    emailNotificationsPaused: doc.emailNotificationsPaused === true,
    pausedAt: doc.pausedAt || null,
    pausedBy: doc.pausedBy || null,
    pauseNote: doc.pauseNote || null,
    resumedAt: doc.resumedAt || null,
    resumedBy: doc.resumedBy || null,
  }
}

// Cheap read for the two notification services — called on every send
// attempt, so this stays a single findOne (no aggregation, no joins).
export async function isEmailNotificationsPaused() {
  const doc = await getOrCreateSettings()
  return doc.emailNotificationsPaused === true
}

// Full shape for the admin UI (CRON Batch page).
export async function getNotificationSettings() {
  return shapeSettings(await getOrCreateSettings())
}

export async function pauseEmailNotifications({ by, note } = {}) {
  const doc = await getOrCreateSettings()
  const wasPaused = doc.emailNotificationsPaused === true
  doc.emailNotificationsPaused = true
  doc.pausedAt = new Date()
  doc.pausedBy = by || null
  doc.pauseNote = note || null
  await doc.save()
  return { ...shapeSettings(doc), reapplied: wasPaused }
}

export async function resumeEmailNotifications({ by } = {}) {
  const doc = await getOrCreateSettings()
  const wasPaused = doc.emailNotificationsPaused === true
  doc.emailNotificationsPaused = false
  doc.resumedAt = new Date()
  doc.resumedBy = by || null
  await doc.save()
  return { ...shapeSettings(doc), wasAlreadyRunning: !wasPaused }
}
