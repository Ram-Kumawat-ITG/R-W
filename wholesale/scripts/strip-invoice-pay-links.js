/* eslint-env node */
// One-off cleanup for the removed Immediate Payment (pay-link) feature.
//
// createInvoiceForOrder stopped baking a "Pay your invoice online: <url>"
// block into new QBO invoices' CustomerMemo on 2026-06-30 (see CLAUDE.md
// changelog), but invoices created before that date — and any since then
// whose payment method was later realigned (paymentPreference.service only
// rewrites the fee line + DueDate, never the memo) — still carry the old
// block on their live QBO invoice.
//
// This script finds every local Invoice that ever minted a pay token
// (Invoice.payToken is only ever set by the removed feature — a reliable,
// permanent marker even after the method changed) and strips the block from
// its QBO CustomerMemo via qbo.service.stripPayLinkMemo. No-op per invoice
// if the live memo has already been cleaned (idempotent — safe to re-run).
//
// Usage:
//   npm run cleanup:pay-links                 # process every flagged invoice
//   npm run cleanup:pay-links -- --dry-run    # list candidates, change nothing

import connectDB from '../app/services/APIService/mongo.service.js'
import Invoice from '../app/models/invoice.server.js'
import { stripPayLinkMemo } from '../app/services/qbo/qbo.service.js'

const dryRun = process.argv.includes('--dry-run')

async function main() {
  await connectDB()

  const candidates = await Invoice.find({ payToken: { $ne: null }, qboInvoiceId: { $ne: null } })
    .select('_id qboInvoiceId qboDocNumber shop')
    .lean()

  console.log(`[cleanup:pay-links] found ${candidates.length} invoice(s) with a legacy pay token`)
  if (dryRun) {
    for (const inv of candidates) {
      console.log(`  would check qboInvoiceId=${inv.qboInvoiceId} (doc #${inv.qboDocNumber || '?'}, shop=${inv.shop})`)
    }
    console.log('[cleanup:pay-links] --dry-run — no changes made.')
    process.exit(0)
  }

  let stripped = 0
  let clean = 0
  let failed = 0
  for (const inv of candidates) {
    try {
      const updated = await stripPayLinkMemo({ qboInvoiceId: inv.qboInvoiceId })
      if (updated) {
        stripped += 1
        console.log(`  ✓ stripped pay link — qboInvoiceId=${inv.qboInvoiceId} (doc #${inv.qboDocNumber || '?'})`)
      } else {
        clean += 1
      }
    } catch (err) {
      failed += 1
      console.error(`  ✗ FAILED qboInvoiceId=${inv.qboInvoiceId}: ${err.message}`)
    }
  }

  console.log(
    `[cleanup:pay-links] done — ${stripped} stripped, ${clean} already clean, ${failed} failed ` +
      `(of ${candidates.length} checked)`,
  )
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('[cleanup:pay-links] FAILED:', err?.message || err)
  process.exit(1)
})
