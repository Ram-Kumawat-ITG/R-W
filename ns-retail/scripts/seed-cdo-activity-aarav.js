/* eslint-env node */
// Seed the CDO activity collections for ONE customer applicant
// (aarav.patel@cdo-ref.test) so the practitioner-facing tabs + reports
// render a full, coherent lifecycle for the referral he came in on.
//
// Aarav is a cdo_applications customer referred by practitioner Durgesh
// Selkari (code DURGESH10, 10%). This script attributes a realistic chain
// of activity to that relationship across the cdo_* collections:
//
//   cdo_referrals    — Aarav, referred by Durgesh via DURGESH10, converted
//   cdo_orders       — 2 orders Aarav placed (1 paid, 1 approved)
//   cdo_commissions  — one commission per order (paid / approved), 10%
//   cdo_payouts      — a paid payout settling the paid commission
//   cdo_transactions — the practitioner ledger: 2 credits + 1 debit,
//                      with a chronological running balance
//
// All activity is attributed to the practitioner (the cdo_* collections
// are practitioner-scoped), but every row is tagged so it can be cleaned
// up for THIS customer alone — orders/referrals by Aarav's email, and
// commissions/payouts/transactions by the "CDO-AARAV" marker baked into
// orderName / reference / description. Re-runs and other practitioners'
// data are never touched.
//
// Prereq: run `npm run seed:cdo-ref` first (creates Aarav + DURGESH10).
//
// Run with:  npm run seed:cdo-activity
//            npm run seed:cdo-activity -- --clear

import mongoose from "mongoose";
import connectDB from "../app/db/mongo.server.js";
import CdoApplication from "../app/models/cdoApplication.server.js";
import CdoOrder from "../app/models/cdoOrder.server.js";
import CdoCommission from "../app/models/cdoCommission.server.js";
import CdoPayout from "../app/models/cdoPayout.server.js";
import CdoReferral from "../app/models/cdoReferral.server.js";
import CdoTransaction from "../app/models/cdoTransaction.server.js";

const CUSTOMER_EMAIL = "aarav.patel@cdo-ref.test";
const MARKER = "CDO-AARAV"; // baked into orderName / reference / description
const CURRENCY = "USD";

const round2 = (n) => Math.round(n * 100) / 100;
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

async function clearSeed() {
  const [r, o, c, p, t] = await Promise.all([
    CdoReferral.deleteMany({ referredEmail: CUSTOMER_EMAIL }),
    CdoOrder.deleteMany({ customerEmail: CUSTOMER_EMAIL }),
    CdoCommission.deleteMany({ orderName: new RegExp(MARKER) }),
    CdoPayout.deleteMany({ reference: new RegExp(MARKER) }),
    CdoTransaction.deleteMany({ description: new RegExp(MARKER) }),
  ]);
  return {
    referrals: r.deletedCount,
    orders: o.deletedCount,
    commissions: c.deletedCount,
    payouts: p.deletedCount,
    transactions: t.deletedCount,
  };
}

async function main() {
  const clearOnly = process.argv.includes("--clear");

  await connectDB();
  console.log("[seed-activity] connected");

  const removed = await clearSeed();
  console.log("[seed-activity] cleared existing seed rows:", removed);

  if (clearOnly) {
    console.log("[seed-activity] --clear specified, done.");
    await mongoose.connection.close();
    return;
  }

  // Drive everything off the real seeded customer + its referral snapshot.
  const customer = await CdoApplication.findOne({ email: CUSTOMER_EMAIL }).lean();
  if (!customer) {
    throw new Error(
      `Customer ${CUSTOMER_EMAIL} not found — run \`npm run seed:cdo-ref\` first.`,
    );
  }
  const ref = customer.referral;
  if (!ref?.practitionerId) {
    throw new Error(`Customer ${CUSTOMER_EMAIL} has no referral mapping.`);
  }

  const shop = customer.shop ?? null;
  const customerName = `${customer.firstName || ""} ${customer.lastName || ""}`.trim();
  const commissionRate = ref.commissionRate ?? 0.1; // resolved on the snapshot
  const practitioner = {
    practitionerId: ref.practitionerId,
    practitionerEmail: ref.practitionerEmail,
    practitionerName: ref.practitionerName,
  };
  const referralCode = ref.code;

  // ── cdo_referrals ──────────────────────────────────────────────────
  const referral = await CdoReferral.create({
    shop,
    ...practitioner,
    referralCode,
    referredEmail: CUSTOMER_EMAIL,
    referredName: customerName,
    status: "converted",
    referredAt: daysAgo(20),
    convertedAt: daysAgo(15),
  });

  // ── cdo_orders ─────────────────────────────────────────────────────
  const orderSpecs = [
    { suffix: "1001", amount: 200, status: "paid", placedAt: daysAgo(15) },
    { suffix: "1002", amount: 120, status: "approved", placedAt: daysAgo(5) },
  ];
  const orders = [];
  for (const spec of orderSpecs) {
    const commissionAmount = round2(spec.amount * commissionRate);
    const order = await CdoOrder.create({
      shop,
      ...practitioner,
      shopifyOrderId: `gid://shopify/Order/99${spec.suffix}`,
      orderName: `#${MARKER}-${spec.suffix}`,
      orderNumber: spec.suffix,
      customerEmail: CUSTOMER_EMAIL,
      customerName,
      currency: CURRENCY,
      amount: spec.amount,
      commissionAmount,
      referralId: referral._id,
      referralCode,
      status: spec.status,
      placedAt: spec.placedAt,
    });
    orders.push({ order, commissionAmount });
  }

  // Link the referral to the first (converting) order.
  referral.orderId = orders[0].order._id;
  await referral.save();

  // ── cdo_commissions ────────────────────────────────────────────────
  // Paid order → paid commission; approved order → approved commission.
  const commissions = [];
  for (const { order, commissionAmount } of orders) {
    const commission = await CdoCommission.create({
      shop,
      ...practitioner,
      orderId: order._id,
      orderName: order.orderName,
      currency: CURRENCY,
      amount: commissionAmount,
      rate: commissionRate,
      status: order.status === "paid" ? "paid" : "approved",
      earnedAt: order.placedAt,
    });
    commissions.push(commission);
  }

  // ── cdo_payouts ────────────────────────────────────────────────────
  // One payout settling only the PAID commission(s).
  const paidCommissions = commissions.filter((c) => c.status === "paid");
  const payoutAmount = round2(paidCommissions.reduce((s, c) => s + c.amount, 0));
  const paidAt = daysAgo(2);
  const payout = await CdoPayout.create({
    shop,
    ...practitioner,
    currency: CURRENCY,
    amount: payoutAmount,
    method: "bank",
    status: "paid",
    periodStart: daysAgo(30),
    periodEnd: daysAgo(3),
    reference: `${MARKER}-PO-0001`,
    paidAt,
  });
  // Stamp the payout id back on the commissions it settled.
  await CdoCommission.updateMany(
    { _id: { $in: paidCommissions.map((c) => c._id) } },
    { $set: { payoutId: payout._id } },
  );

  // ── cdo_transactions ───────────────────────────────────────────────
  // Append-only ledger: commission credits + payout debits, sorted by
  // time with a running balance.
  const events = [
    ...commissions.map((c) => ({
      type: "commission",
      amount: c.amount,
      relatedType: "CdoCommission",
      relatedId: c._id,
      description: `Commission earned on ${c.orderName} (referral ${referralCode}, customer ${customerName})`,
      occurredAt: c.earnedAt,
    })),
    {
      type: "payout",
      amount: -payout.amount,
      relatedType: "CdoPayout",
      relatedId: payout._id,
      description: `Payout ${payout.reference} via ${payout.method} (${MARKER})`,
      occurredAt: paidAt,
    },
  ].sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));

  let balance = 0;
  for (const e of events) {
    balance = round2(balance + e.amount);
    await CdoTransaction.create({
      shop,
      ...practitioner,
      type: e.type,
      currency: CURRENCY,
      amount: e.amount,
      balanceAfter: balance,
      relatedType: e.relatedType,
      relatedId: e.relatedId,
      description: e.description,
      occurredAt: e.occurredAt,
    });
  }

  console.log(
    `[seed-activity] ${customerName} → practitioner ${practitioner.practitionerName} (${referralCode} @ ${(commissionRate * 100).toFixed(0)}%)`,
  );
  console.log("[seed-activity] inserted:", {
    referrals: 1,
    orders: orders.length,
    commissions: commissions.length,
    payouts: 1,
    transactions: events.length,
    payoutAmount,
    endingBalance: balance,
  });

  await mongoose.connection.close();
  console.log("[seed-activity] done.");
}

main().catch(async (err) => {
  console.error("[seed-activity] failed:", err);
  try {
    await mongoose.connection.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
