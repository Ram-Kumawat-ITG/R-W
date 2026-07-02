/* eslint-env node */
// Clean up ORPHANED CDO commission + payout rows (test-data drift).
//
// An "orphaned" commission is one whose `orderId` references no existing
// `cdo_orders` document (or is null) — it can't be a real attributed
// commission, and it inflates the dashboard's "Total Commission Earned"
// relative to the actual orders. Payouts seeded from those commissions are
// cleaned too: a payout referencing ZERO surviving (real) commissions is
// deleted; a payout referencing a mix has its dead `commissionIds` pulled.
//
// SAFETY:
//   • Dry-run by DEFAULT — prints exactly what WOULD change and exits.
//   • Pass `--apply` to actually delete/update.
//   • Only ever touches commissions with no backing order + payouts that
//     reference them. Real-order commissions are always kept.
//   • Leaves cdo_orders, cdo_referrals, and cdo_transactions untouched.
//
// Run:
//   node --env-file-if-exists=.env scripts/cleanup-orphaned-cdo.js          (dry run)
//   node --env-file-if-exists=.env scripts/cleanup-orphaned-cdo.js --apply  (delete)

import mongoose from "mongoose";
import connectDB from "../app/db/mongo.server.js";
import CdoOrder from "../app/models/cdoOrder.server.js";
import CdoCommission from "../app/models/cdoCommission.server.js";
import CdoPayout from "../app/models/cdoPayout.server.js";

const APPLY = process.argv.includes("--apply");
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function main() {
  await connectDB();
  console.log(`\n[cleanup-orphaned-cdo] mode: ${APPLY ? "APPLY (will delete)" : "DRY RUN (no changes)"}\n`);

  // 1. Valid order ids.
  const orders = await CdoOrder.find({}).select("_id").lean();
  const validOrderIds = new Set(orders.map((o) => String(o._id)));
  console.log(`cdo_orders: ${validOrderIds.size} document(s)`);

  // 2. Classify commissions by whether their orderId ties to a real order.
  const commissions = await CdoCommission.find({})
    .select("_id orderId amount status")
    .lean();
  const orphanedCommissions = commissions.filter(
    (c) => !c.orderId || !validOrderIds.has(String(c.orderId)),
  );
  const realCommissionIds = new Set(
    commissions
      .filter((c) => c.orderId && validOrderIds.has(String(c.orderId)))
      .map((c) => String(c._id)),
  );
  const orphanedCommissionIds = orphanedCommissions.map((c) => c._id);
  const orphanedSum = r2(orphanedCommissions.reduce((s, c) => s + (Number(c.amount) || 0), 0));
  console.log(
    `cdo_commissions: ${commissions.length} total · ${orphanedCommissions.length} orphaned ($${orphanedSum}) · ${realCommissionIds.size} kept`,
  );

  // 3. Classify payouts by whether they reference any surviving commission.
  const payouts = await CdoPayout.find({})
    .select("_id commissionIds amount status")
    .lean();
  const fullyOrphanedPayouts = [];
  const mixedPayouts = []; // keep, but pull dead refs
  for (const p of payouts) {
    const ids = (p.commissionIds || []).map(String);
    const live = ids.filter((id) => realCommissionIds.has(id));
    const dead = ids.filter((id) => !realCommissionIds.has(id));
    if (live.length === 0) fullyOrphanedPayouts.push(p);
    else if (dead.length > 0) mixedPayouts.push({ payout: p, dead });
  }
  const payoutSum = r2(fullyOrphanedPayouts.reduce((s, p) => s + (Number(p.amount) || 0), 0));
  console.log(
    `cdo_payouts: ${payouts.length} total · ${fullyOrphanedPayouts.length} fully-orphaned ($${payoutSum}) → delete · ${mixedPayouts.length} mixed → prune dead refs`,
  );

  if (!APPLY) {
    console.log("\nDRY RUN — nothing changed. Re-run with --apply to delete.\n");
    await mongoose.connection.close();
    return;
  }

  // 4. Apply.
  if (orphanedCommissionIds.length) {
    const res = await CdoCommission.deleteMany({ _id: { $in: orphanedCommissionIds } });
    console.log(`deleted ${res.deletedCount} orphaned commission(s)`);
  }
  if (fullyOrphanedPayouts.length) {
    const res = await CdoPayout.deleteMany({
      _id: { $in: fullyOrphanedPayouts.map((p) => p._id) },
    });
    console.log(`deleted ${res.deletedCount} fully-orphaned payout(s)`);
  }
  for (const { payout, dead } of mixedPayouts) {
    await CdoPayout.updateOne(
      { _id: payout._id },
      { $pull: { commissionIds: { $in: dead.map((id) => new mongoose.Types.ObjectId(id)) } } },
    );
  }
  if (mixedPayouts.length) {
    console.log(`pruned dead commission refs on ${mixedPayouts.length} payout(s)`);
  }

  console.log("\n[cleanup-orphaned-cdo] done.\n");
  await mongoose.connection.close();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
