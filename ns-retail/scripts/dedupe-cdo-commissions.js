/* eslint-env node */
// Remove DUPLICATE cdo_commissions (more than one row for the same orderId).
//
// Why: createCommissionForOrder historically `findOne`'d on an UNINDEXED
// orderId before inserting, so two webhook deliveries racing could both insert
// — double-paying the practitioner (bug 2). The fix adds a UNIQUE partial index
// on orderId, but that index will FAIL to build while duplicates exist. Run
// this first to clear them.
//
// Run with:  node --env-file=.env scripts/dedupe-cdo-commissions.js          (dry-run, report only)
//            node --env-file=.env scripts/dedupe-cdo-commissions.js --apply  (actually delete)
//
// SAFETY: money. For each duplicated orderId we KEEP exactly one row, choosing
// the most-progressed (paid > approved > pending > reversed; earliest createdAt
// as tiebreak) and delete the rest. If MORE THAN ONE of the duplicates is
// already `paid` or batched (has a payoutId), we REFUSE to touch that group and
// flag it for manual review — never auto-delete settled money.

import mongoose from "mongoose";
import connectDB from "../app/db/mongo.server.js";
import CdoCommission from "../app/models/cdoCommission.server.js";

const APPLY = process.argv.includes("--apply");
const STATUS_RANK = { paid: 4, approved: 3, pending: 2, reversed: 1 };

function rank(c) {
  return (STATUS_RANK[c.status] || 0) * 1e15 - new Date(c.createdAt || 0).getTime();
}

async function main() {
  await connectDB();
  const groups = await CdoCommission.aggregate([
    { $match: { orderId: { $ne: null } } },
    { $group: { _id: "$orderId", ids: { $push: "$_id" }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);

  console.log(`Found ${groups.length} orderId group(s) with duplicate commissions.`);
  let deleted = 0;
  let flagged = 0;

  for (const g of groups) {
    const rows = await CdoCommission.find({ _id: { $in: g.ids } }).lean();
    const settled = rows.filter((r) => r.status === "paid" || r.payoutId);
    if (settled.length > 1) {
      flagged += 1;
      console.warn(
        `  ⚠ order ${g._id}: ${rows.length} commissions, ${settled.length} already paid/batched — SKIPPING (needs manual review): ${rows.map((r) => r._id).join(", ")}`,
      );
      continue;
    }
    const keep = rows.slice().sort((a, b) => rank(b) - rank(a))[0];
    const drop = rows.filter((r) => String(r._id) !== String(keep._id));
    console.log(
      `  order ${g._id}: keep ${keep._id} (${keep.status}), drop ${drop.map((d) => `${d._id}(${d.status})`).join(", ")}`,
    );
    if (APPLY) {
      await CdoCommission.deleteMany({ _id: { $in: drop.map((d) => d._id) } });
      deleted += drop.length;
    }
  }

  console.log(
    APPLY
      ? `\nDONE — deleted ${deleted} duplicate row(s); ${flagged} group(s) flagged for manual review.`
      : `\nDRY-RUN — would delete duplicates above; ${flagged} group(s) need manual review. Re-run with --apply to delete.`,
  );
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
