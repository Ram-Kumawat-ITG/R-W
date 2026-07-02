/* eslint-env node */
// Seed sample PATIENT orders so you can exercise the commission payout
// flow end to end.
//
// The patient (Aarav Patel, a cdo_applications customer) places orders
// using practitioner Durgesh's referral code (DURGESH10). Each order
// accrues a commission TO THE PRACTITIONER (Durgesh) — that's who gets
// paid out. We seed the orders + APPROVED commissions directly, sized so
// the practitioner's eligible total clears cdo_settings.minimumPayoutAmount
// ($50 by default), so a payout batch will actually form.
//
// After running this:
//   1. Open CDO Program → Payouts → "Generate payout batch".
//      A payout for Durgesh (~$65) appears as "Awaiting approval".
//   2. Approve it. (Execute posts to QBO — needs QBO_* / QBO_RETAIL_* connected.)
//
// Run with:  npm run seed:cdo-orders
//            npm run seed:cdo-orders -- --clear
//
// Idempotent: sample rows are tagged with the CDO-PAYTEST marker (orders/
// commissions by orderName, transactions by description) and removed
// before re-inserting. Does not touch wholesale_applications.

import mongoose from "mongoose";
import connectDB from "../app/db/mongo.server.js";
import CdoApplication from "../app/models/cdoApplication.server.js";
import CdoOrder from "../app/models/cdoOrder.server.js";
import CdoCommission from "../app/models/cdoCommission.server.js";
import CdoTransaction from "../app/models/cdoTransaction.server.js";
import CdoSetting from "../app/models/cdoSetting.server.js";

const CUSTOMER_EMAIL = "aarav.patel@cdo-ref.test";
const MARKER = "CDO-PAYTEST";

// Sample orders the patient placed. Commission = amount * referral rate.
const ORDER_SPECS = [
  { suffix: "3001", amount: 400 },
  { suffix: "3002", amount: 250 },
];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function clearSeed() {
  const [o, c, t] = await Promise.all([
    CdoOrder.deleteMany({ orderName: new RegExp(MARKER) }),
    CdoCommission.deleteMany({ orderName: new RegExp(MARKER) }),
    CdoTransaction.deleteMany({ description: new RegExp(MARKER) }),
  ]);
  return { orders: o.deletedCount, commissions: c.deletedCount, transactions: t.deletedCount };
}

async function appendLedgerCredit({ order, practitioner, amount }) {
  const last = await CdoTransaction.findOne({ practitionerId: practitioner.practitionerId })
    .sort({ occurredAt: -1, createdAt: -1 })
    .lean();
  const balanceAfter = round2((last?.balanceAfter ?? 0) + amount);
  await CdoTransaction.create({
    shop: order.shop,
    practitionerId: practitioner.practitionerId,
    practitionerEmail: practitioner.practitionerEmail,
    practitionerName: practitioner.practitionerName,
    type: "commission",
    currency: order.currency,
    amount,
    balanceAfter,
    relatedType: "CdoCommission",
    relatedId: order._id,
    description: `Commission earned on ${order.orderName} (${MARKER})`,
    occurredAt: order.placedAt,
  });
}

async function main() {
  const clearOnly = process.argv.includes("--clear");
  await connectDB();
  console.log("[seed-orders] connected");

  const removed = await clearSeed();
  console.log("[seed-orders] cleared existing sample rows:", removed);
  if (clearOnly) {
    await mongoose.connection.close();
    return;
  }

  // Resolve the patient + their referral (practitioner + commission rate).
  const customer = await CdoApplication.findOne({ email: CUSTOMER_EMAIL }).lean();
  if (!customer) {
    throw new Error(`Patient ${CUSTOMER_EMAIL} not found — run \`npm run seed:cdo-ref\` first.`);
  }
  const ref = customer.referral;
  if (!ref?.practitionerId) {
    throw new Error(`Patient ${CUSTOMER_EMAIL} has no referral mapping — run \`npm run seed:cdo-ref\` first.`);
  }
  const rate = ref.commissionRate ?? 0.1;
  const practitioner = {
    practitionerId: ref.practitionerId,
    practitionerEmail: ref.practitionerEmail,
    practitionerName: ref.practitionerName,
  };
  const shop = customer.shop ?? null;
  const customerName = `${customer.firstName || ""} ${customer.lastName || ""}`.trim();
  const settings = await CdoSetting.findOne({ singletonKey: "cdo-program" }).lean();
  const minPayout = settings?.minimumPayoutAmount ?? 50;
  const currency = ref.currency || settings?.currency || "USD";

  const now = new Date();
  let totalCommission = 0;

  for (const spec of ORDER_SPECS) {
    const commissionAmount = round2(spec.amount * rate);
    const order = await CdoOrder.create({
      shop,
      practitionerId: practitioner.practitionerId,
      practitionerEmail: practitioner.practitionerEmail,
      practitionerName: practitioner.practitionerName,
      shopifyOrderId: `gid://shopify/Order/88${spec.suffix}`,
      orderName: `#${MARKER}-${spec.suffix}`,
      orderNumber: spec.suffix,
      customerEmail: CUSTOMER_EMAIL,
      customerName,
      currency,
      amount: spec.amount,
      commissionAmount,
      referralCode: ref.code,
      status: "paid",
      placedAt: now,
    });

    // Approved commission → immediately eligible for a payout batch.
    await CdoCommission.create({
      shop,
      practitionerId: practitioner.practitionerId,
      practitionerEmail: practitioner.practitionerEmail,
      practitionerName: practitioner.practitionerName,
      orderId: order._id,
      orderName: order.orderName,
      currency,
      amount: commissionAmount,
      rate,
      status: "approved",
      earnedAt: now,
    });

    await appendLedgerCredit({ order, practitioner, amount: commissionAmount });

    totalCommission = round2(totalCommission + commissionAmount);
    console.log(
      `[seed-orders] ${order.orderName}: $${spec.amount} → commission $${commissionAmount} (approved)`,
    );
  }

  console.log(
    `\n[seed-orders] Patient: ${customerName} | Practitioner: ${practitioner.practitionerName} (${ref.code} @ ${(rate * 100).toFixed(0)}%)`,
  );
  console.log(
    `[seed-orders] Eligible approved commission total: $${totalCommission} | minimum payout: $${minPayout} -> ${
      totalCommission >= minPayout
        ? "WILL form a payout"
        : "below minimum (lower minimumPayoutAmount or add orders)"
    }`,
  );
  console.log(
    "[seed-orders] Next: CDO Program → Payouts → Generate payout batch → Approve.\n",
  );

  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error("[seed-orders] failed:", err?.message || err);
  try {
    await mongoose.connection.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
