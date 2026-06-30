/* eslint-env node */
// Backfill `commissionSnapshot` on LEGACY attributed orders that have none
// (bug 9). Orders ingested before the per-line commission snapshot existed
// carry `commissionSnapshot: null` forever, so an admin can't later explain
// exactly how a historical commission was computed.
//
// This writes a best-effort RECONSTRUCTED snapshot: a single blended line from
// the stored `commissionAmount` ÷ the commission base (product subtotal, else
// the order gross), with `reconstructed: true` so it's never mistaken for the
// original per-vendor capture. (Live reads already get the same reconstruction
// via cdo.service.projectCommissionSnapshot; this persists it for reporting.)
//
// Run with:  node --env-file=.env scripts/backfill-cdo-commission-snapshots.js          (dry-run)
//            node --env-file=.env scripts/backfill-cdo-commission-snapshots.js --apply
//
// Idempotent: only touches orders where commissionSnapshot is missing AND
// commissionAmount > 0; never overwrites a real snapshot.

import mongoose from "mongoose";
import connectDB from "../app/db/mongo.server.js";
import CdoOrder from "../app/models/cdoOrder.server.js";

const APPLY = process.argv.includes("--apply");

function round(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

async function main() {
  await connectDB();
  const orders = await CdoOrder.find({
    attributed: true,
    commissionAmount: { $gt: 0 },
    $or: [{ commissionSnapshot: null }, { commissionSnapshot: { $exists: false } }],
  })
    .select("_id orderName amount commissionAmount pricing")
    .lean();

  console.log(`Found ${orders.length} attributed order(s) missing a commission snapshot.`);
  let written = 0;

  for (const o of orders) {
    const amount = round(o.commissionAmount);
    const revenue = Number(o.pricing?.subtotal) || Number(o.amount) || 0;
    const effectiveRate = revenue > 0 ? Number((amount / revenue).toFixed(4)) : 0;
    const snapshot = {
      configVersion: null,
      vendorRates: [],
      lines: [{ vendor: null, revenue, rate: effectiveRate, amount }],
      effectiveRate,
      reconstructed: true,
      computedAt: new Date(),
    };
    console.log(
      `  ${o.orderName || o._id}: amount ${amount}, revenue ${revenue}, rate ${(effectiveRate * 100).toFixed(2)}%`,
    );
    if (APPLY) {
      await CdoOrder.updateOne({ _id: o._id }, { $set: { commissionSnapshot: snapshot } });
      written += 1;
    }
  }

  console.log(
    APPLY
      ? `\nDONE — wrote ${written} reconstructed snapshot(s).`
      : `\nDRY-RUN — re-run with --apply to write the snapshots above.`,
  );
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
