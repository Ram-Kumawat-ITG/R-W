/* eslint-env node */
// Backfill `migrationSource` (+ where derivable) on CDO records that were
// imported from GoAffPro BEFORE the uniform provenance stamp existed, so the
// admin "Migrated" badge/filter recognizes them too.
//
// Provenance markers this uses to recognize legacy migrated rows:
//   cdo_orders            → migratedFromGoAffPro: true  OR  shopifyOrderId ^= "legacy:goaffpro:"
//   cdo_commissions       → orderId ∈ (migrated orders above)   [join — commissions carry no own marker]
//   cdo_practitioner_codes→ note === "Migrated from GoAffPro"
//   cdo_payouts           → remarks[].message ~ /Migrated from GoAffPro/
//   cdo_referrals         → NO reliable legacy marker exists — cannot be backfilled;
//                            only referrals imported AFTER this change are stamped.
//
// Only rows with no migrationSource yet are touched (idempotent — safe to re-run).
//
// Run (DRY RUN, writes nothing):
//   node --experimental-loader ./scripts/extensionless-loader.mjs --env-file-if-exists=.env scripts/backfill-cdo-migration-source.js
// Add --commit to actually write:
//   node --experimental-loader ./scripts/extensionless-loader.mjs --env-file-if-exists=.env scripts/backfill-cdo-migration-source.js --commit

import connectDB from "../app/db/mongo.server.js";
import mongoose from "mongoose";
import CdoOrder from "../app/models/cdoOrder.server.js";
import CdoCommission from "../app/models/cdoCommission.server.js";
import CdoPractitionerCode from "../app/models/cdoPractitionerCode.server.js";
import CdoPayout from "../app/models/cdoPayout.server.js";
import CdoReferral from "../app/models/cdoReferral.server.js";

const COMMIT = process.argv.includes("--commit");
const SOURCE = "goaffpro";
// `migrationSource: null` matches both an explicit null AND a missing field in
// MongoDB — exactly the pre-stamp rows we want, and never a freshly-stamped one.
const UNSTAMPED = { migrationSource: null };

async function main() {
  await connectDB();

  const orderFilter = {
    ...UNSTAMPED,
    $or: [{ migratedFromGoAffPro: true }, { shopifyOrderId: /^legacy:goaffpro:/ }],
  };
  const codeFilter = { ...UNSTAMPED, note: "Migrated from GoAffPro" };
  const payoutFilter = { ...UNSTAMPED, "remarks.message": /Migrated from GoAffPro/i };

  // Commissions inherit provenance from their migrated order.
  const migratedOrderIds = (await CdoOrder.find(orderFilter).select("_id").lean()).map((o) => o._id);
  const commissionFilter = { ...UNSTAMPED, orderId: { $in: migratedOrderIds } };

  const [orders, codes, payouts, commissions] = await Promise.all([
    CdoOrder.countDocuments(orderFilter),
    CdoPractitionerCode.countDocuments(codeFilter),
    CdoPayout.countDocuments(payoutFilter),
    migratedOrderIds.length ? CdoCommission.countDocuments(commissionFilter) : 0,
  ]);

  // Referrals: report how many exist with no marker (informational only).
  const referralsUnstamped = await CdoReferral.countDocuments(UNSTAMPED);

  console.log(`\n${COMMIT ? "COMMIT" : "DRY RUN"} — backfill migrationSource="${SOURCE}"\n`);
  console.log(`  cdo_orders            to stamp: ${orders}`);
  console.log(`  cdo_commissions       to stamp: ${commissions}  (joined via ${migratedOrderIds.length} migrated orders)`);
  console.log(`  cdo_practitioner_codes to stamp: ${codes}`);
  console.log(`  cdo_payouts           to stamp: ${payouts}`);
  console.log(`  cdo_referrals         NOT backfillable (no legacy marker): ${referralsUnstamped} unstamped left as-is`);

  if (!COMMIT) {
    console.log(`\nDry run only — nothing written. Re-run with --commit to apply.\n`);
    await mongoose.disconnect();
    return;
  }

  const set = { $set: { migrationSource: SOURCE } };
  const [ro, rc, rk, rp] = await Promise.all([
    CdoOrder.updateMany(orderFilter, set),
    migratedOrderIds.length ? CdoCommission.updateMany(commissionFilter, set) : { modifiedCount: 0 },
    CdoPractitionerCode.updateMany(codeFilter, set),
    CdoPayout.updateMany(payoutFilter, set),
  ]);

  console.log(`\nWrote:`);
  console.log(`  cdo_orders             modified: ${ro.modifiedCount}`);
  console.log(`  cdo_commissions        modified: ${rc.modifiedCount}`);
  console.log(`  cdo_practitioner_codes modified: ${rk.modifiedCount}`);
  console.log(`  cdo_payouts            modified: ${rp.modifiedCount}`);
  console.log(`\nDone.\n`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("backfill failed:", err?.message || err);
  process.exit(1);
});
