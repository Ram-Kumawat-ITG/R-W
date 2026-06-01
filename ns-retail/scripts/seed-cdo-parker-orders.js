/* eslint-env node */
// Seed a PATIENT of practitioner Parker + sample orders, so you can run a
// commission payout for Parker.
//
//   Practitioner : Parker (parker@itgeeks.com, code PARKER20)
//   Patient      : Sophia Nguyen (sophia.nguyen@cdo-ref.test) — created here
//   Orders       : placed by the patient under PARKER20, attributed to Parker
//
// Note on rates: PARKER20's "20" is the CUSTOMER discount. Parker's
// COMMISSION rate is null on the code → inherits the program default
// (10%). So commission = order amount * 10%. Orders are sized to clear
// cdo_settings.minimumPayoutAmount ($50) so a payout batch forms.
//
// After running:  CDO Program → Payouts → Generate payout batch → Approve
//                 → Execute (posts Vendor Bill + BillPayment to QBO).
//
// Run with:  npm run seed:cdo-parker
//            npm run seed:cdo-parker -- --clear
//
// Idempotent: the patient is keyed by email; orders/commissions by the
// CDO-PARKER marker; ledger entries by description. Never touches
// wholesale_applications.

import mongoose from "mongoose";
import connectDB from "../app/db/mongo.server.js";
import WholesaleApplication from "../app/models/wholesaleApplication.server.js";
import CdoApplication from "../app/models/cdoApplication.server.js";
import CdoPractitionerCode from "../app/models/cdoPractitionerCode.server.js";
import CdoOrder from "../app/models/cdoOrder.server.js";
import CdoCommission from "../app/models/cdoCommission.server.js";
import CdoTransaction from "../app/models/cdoTransaction.server.js";
import CdoSetting from "../app/models/cdoSetting.server.js";

const PRACTITIONER_EMAIL = "parker@itgeeks.com";
const CODE = "PARKER20";
const PATIENT = { firstName: "Sophia", lastName: "Nguyen", email: "sophia.nguyen@cdo-ref.test" };
const MARKER = "CDO-PARKER";

// Order amounts (commission = amount * commissionRate).
const ORDER_SPECS = [
  { suffix: "4001", amount: 400 },
  { suffix: "4002", amount: 250 },
];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function clearSeed() {
  const [cust, o, c, t] = await Promise.all([
    CdoApplication.deleteMany({ email: PATIENT.email }),
    CdoOrder.deleteMany({ orderName: new RegExp(MARKER) }),
    CdoCommission.deleteMany({ orderName: new RegExp(MARKER) }),
    CdoTransaction.deleteMany({ description: new RegExp(MARKER) }),
  ]);
  return {
    patients: cust.deletedCount,
    orders: o.deletedCount,
    commissions: c.deletedCount,
    transactions: t.deletedCount,
  };
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
  console.log("[seed-parker] connected");

  const removed = await clearSeed();
  console.log("[seed-parker] cleared existing sample rows:", removed);
  if (clearOnly) {
    await mongoose.connection.close();
    return;
  }

  // Resolve Parker (practitioner) + the PARKER20 code.
  const prac = await WholesaleApplication.findOne({ email: PRACTITIONER_EMAIL }).lean();
  if (!prac) {
    throw new Error(`Practitioner ${PRACTITIONER_EMAIL} not found in wholesale_applications.`);
  }
  const code = await CdoPractitionerCode.findOne({ code: CODE }).lean();
  if (!code) {
    throw new Error(`Code ${CODE} not found — run \`npm run seed:cdo-ref\` first.`);
  }
  const settings = await CdoSetting.findOne({ singletonKey: "cdo-program" }).lean();
  const defaultRate = settings?.defaultCommissionRate ?? 0.1;
  const minPayout = settings?.minimumPayoutAmount ?? 50;
  const currency = settings?.currency ?? "USD";
  const shop = prac.shop ?? code.shop ?? null;

  const practitioner = {
    practitionerId: prac._id.toString(),
    practitionerEmail: (prac.email || "").toLowerCase(),
    practitionerName: `${prac.firstName || ""} ${prac.lastName || ""}`.trim(),
  };
  const commissionRate = code.commissionRate != null ? code.commissionRate : defaultRate;

  // Create the PATIENT with a referral snapshot mapping to Parker.
  const referral = {
    code: code.code,
    codeId: code._id.toString(),
    practitionerId: practitioner.practitionerId,
    practitionerSource: "wholesale",
    practitionerName: practitioner.practitionerName,
    practitionerEmail: practitioner.practitionerEmail,
    discountPercent: code.discountPercent ?? 0,
    commissionRate,
    linkedAt: new Date(),
  };
  const patient = await CdoApplication.create({
    shop,
    applicantType: "patient",
    firstName: PATIENT.firstName,
    lastName: PATIENT.lastName,
    email: PATIENT.email,
    status: "approved",
    submittedAt: new Date(),
    referral,
  });
  console.log(
    `[seed-parker] patient ${PATIENT.firstName} ${PATIENT.lastName} (cdo_app=${patient._id}) → referred by ${practitioner.practitionerName} via ${code.code}`,
  );

  const now = new Date();
  const customerName = `${PATIENT.firstName} ${PATIENT.lastName}`;
  let totalCommission = 0;

  for (const spec of ORDER_SPECS) {
    const commissionAmount = round2(spec.amount * commissionRate);
    const order = await CdoOrder.create({
      shop,
      practitionerId: practitioner.practitionerId,
      practitionerEmail: practitioner.practitionerEmail,
      practitionerName: practitioner.practitionerName,
      shopifyOrderId: `gid://shopify/Order/77${spec.suffix}`,
      orderName: `#${MARKER}-${spec.suffix}`,
      orderNumber: spec.suffix,
      customerEmail: PATIENT.email,
      customerName,
      currency,
      amount: spec.amount,
      commissionAmount,
      referralCode: code.code,
      status: "paid",
      placedAt: now,
    });
    await CdoCommission.create({
      shop,
      practitionerId: practitioner.practitionerId,
      practitionerEmail: practitioner.practitionerEmail,
      practitionerName: practitioner.practitionerName,
      orderId: order._id,
      orderName: order.orderName,
      currency,
      amount: commissionAmount,
      rate: commissionRate,
      status: "approved",
      earnedAt: now,
    });
    await appendLedgerCredit({ order, practitioner, amount: commissionAmount });
    totalCommission = round2(totalCommission + commissionAmount);
    console.log(`[seed-parker] ${order.orderName}: $${spec.amount} → commission $${commissionAmount} (approved)`);
  }

  console.log(
    `\n[seed-parker] Practitioner ${practitioner.practitionerName} (${code.code}, commission ${(commissionRate * 100).toFixed(0)}%)`,
  );
  console.log(
    `[seed-parker] Eligible approved commission total: $${totalCommission} | minimum payout: $${minPayout} -> ${
      totalCommission >= minPayout ? "WILL form a payout" : "below minimum (add orders or lower minimum)"
    }`,
  );
  console.log("[seed-parker] Next: CDO Program → Payouts → Generate payout batch → Approve → Execute.\n");

  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error("[seed-parker] failed:", err?.message || err);
  try {
    await mongoose.connection.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
