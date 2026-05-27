/* eslint-env node */
// Seed dummy data for the CDO Program portal.
//
// Inserts coherent demo records into the cdo_* collections so the
// Dashboard, Reports, and per-tab tables render with realistic content
// before the live attribution pipeline exists.
//
// Run with:  npm run seed:cdo
// (loads ns-retail/.env via node --env-file so MONGODB_URI is available)
//
// Idempotent + non-destructive: every demo record is tagged with a
// practitioner email under the DEMO_DOMAIN, and the script deletes only
// those rows before re-inserting — so re-running refreshes the demo set
// without touching any real CDO data. Re-run with `--clear` to remove
// the demo data and exit without re-seeding.

import mongoose from "mongoose";
import connectDB from "../app/db/mongo.server.js";
import CdoOrder from "../app/models/cdoOrder.server.js";
import CdoCommission from "../app/models/cdoCommission.server.js";
import CdoPayout from "../app/models/cdoPayout.server.js";
import CdoReferral from "../app/models/cdoReferral.server.js";
import CdoTransaction from "../app/models/cdoTransaction.server.js";
import CdoSetting from "../app/models/cdoSetting.server.js";

const SHOP =
  process.env.SHOPIFY_SHOP || process.env.SHOP || "cdo-demo.myshopify.com";
const DEMO_DOMAIN = "cdo-demo.test";
const CURRENCY = "USD";
const COMMISSION_RATE = 0.1;

const DEMO_EMAIL_RX = new RegExp(`@${DEMO_DOMAIN.replace(".", "\\.")}$`);

// ---- tiny deterministic-ish RNG helpers -------------------------------

const rand = (min, max) => Math.random() * (max - min) + min;
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const pick = (arr) => arr[randInt(0, arr.length - 1)];
const round2 = (n) => Math.round(n * 100) / 100;
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const weighted = (pairs) => {
  // pairs: [[value, weight], ...]
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rand(0, total);
  for (const [value, w] of pairs) {
    if ((r -= w) <= 0) return value;
  }
  return pairs[0][0];
};

// ---- demo practitioners ----------------------------------------------

const FIRST = ["Ava", "Liam", "Maya", "Noah", "Elena", "Owen", "Priya", "Jonas"];
const LAST = ["Bennett", "Cho", "Diaz", "Fischer", "Greene", "Patel", "Reyes", "Vance"];
const BIZ = ["Wellness", "Vitality", "Holistic", "Natural", "Pure", "Thrive"];

function makePractitioners(count) {
  const used = new Set();
  const out = [];
  for (let i = 0; i < count; i++) {
    let first;
    let last;
    let email;
    do {
      first = pick(FIRST);
      last = pick(LAST);
      email = `${first}.${last}`.toLowerCase() + `@${DEMO_DOMAIN}`;
    } while (used.has(email));
    used.add(email);
    out.push({
      id: new mongoose.Types.ObjectId().toString(),
      name: `${first} ${last}`,
      email,
      business: `${first[0]}${last} ${pick(BIZ)} Co.`,
    });
  }
  return out;
}

// ---- builders ---------------------------------------------------------

function buildOrders(practitioners) {
  const orders = [];
  const orderCount = randInt(34, 44);
  for (let i = 0; i < orderCount; i++) {
    const p = pick(practitioners);
    const amount = round2(rand(45, 820));
    const status = weighted([
      ["paid", 5],
      ["approved", 3],
      ["pending", 2],
      ["cancelled", 1],
    ]);
    const commissionAmount =
      status === "cancelled" ? 0 : round2(amount * COMMISSION_RATE);
    const placedAt = daysAgo(randInt(1, 175));
    orders.push({
      _id: new mongoose.Types.ObjectId(),
      shop: SHOP,
      practitionerId: p.id,
      practitionerEmail: p.email,
      practitionerName: p.name,
      shopifyOrderId: `gid://shopify/Order/${randInt(5000000, 5999999)}`,
      orderName: `#CDO${1000 + i}`,
      orderNumber: String(1000 + i),
      customerEmail: `customer${i}@example.com`,
      customerName: `${pick(FIRST)} ${pick(LAST)}`,
      currency: CURRENCY,
      amount,
      commissionAmount,
      referralCode: `${p.name.split(" ")[0].toUpperCase()}-${randInt(100, 999)}`,
      status,
      placedAt,
    });
  }
  return orders;
}

function buildCommissions(orders) {
  return orders
    .filter((o) => o.status !== "cancelled")
    .map((o) => {
      const status =
        o.status === "paid"
          ? weighted([
              ["paid", 6],
              ["approved", 3],
            ])
          : o.status === "approved"
            ? "approved"
            : "pending";
      return {
        _id: new mongoose.Types.ObjectId(),
        shop: SHOP,
        practitionerId: o.practitionerId,
        practitionerEmail: o.practitionerEmail,
        practitionerName: o.practitionerName,
        orderId: o._id,
        orderName: o.orderName,
        currency: CURRENCY,
        amount: o.commissionAmount,
        rate: COMMISSION_RATE,
        status,
        earnedAt: o.placedAt,
      };
    });
}

function buildPayouts(practitioners, commissions) {
  const payouts = [];
  for (const p of practitioners) {
    const paid = commissions.filter(
      (c) => c.practitionerEmail === p.email && c.status === "paid",
    );
    if (paid.length === 0) continue;
    const total = round2(paid.reduce((s, c) => s + c.amount, 0));
    if (total < 25) continue;
    const status = weighted([
      ["paid", 5],
      ["pending", 2],
      ["processing", 2],
      ["failed", 1],
    ]);
    const periodEnd = daysAgo(randInt(1, 30));
    const periodStart = new Date(periodEnd.getTime() - 30 * 24 * 60 * 60 * 1000);
    payouts.push({
      _id: new mongoose.Types.ObjectId(),
      shop: SHOP,
      practitionerId: p.id,
      practitionerEmail: p.email,
      practitionerName: p.name,
      currency: CURRENCY,
      amount: total,
      method: pick(["bank", "paypal", "check", "manual"]),
      status,
      periodStart,
      periodEnd,
      reference: `PO-${randInt(10000, 99999)}`,
      paidAt: status === "paid" ? periodEnd : null,
    });
  }
  return payouts;
}

function buildReferrals(practitioners, orders) {
  const referrals = [];
  const count = randInt(24, 32);
  for (let i = 0; i < count; i++) {
    const p = pick(practitioners);
    const status = weighted([
      ["converted", 5],
      ["pending", 4],
      ["expired", 2],
    ]);
    const referredAt = daysAgo(randInt(1, 170));
    let orderId = null;
    let convertedAt = null;
    if (status === "converted") {
      const match = orders.find((o) => o.practitionerEmail === p.email);
      orderId = match ? match._id : null;
      convertedAt = new Date(
        referredAt.getTime() + randInt(1, 20) * 24 * 60 * 60 * 1000,
      );
    }
    referrals.push({
      shop: SHOP,
      practitionerId: p.id,
      practitionerEmail: p.email,
      practitionerName: p.name,
      referralCode: `${p.name.split(" ")[0].toUpperCase()}-${randInt(100, 999)}`,
      referredEmail: `lead${i}@example.com`,
      referredName: `${pick(FIRST)} ${pick(LAST)}`,
      status,
      orderId,
      referredAt,
      convertedAt,
    });
  }
  return referrals;
}

// Build a per-practitioner ledger: commission credits + payout debits,
// sorted chronologically with a running balance.
function buildTransactions(commissions, payouts) {
  const events = [];
  for (const c of commissions) {
    if (c.status === "reversed") continue;
    events.push({
      practitionerId: c.practitionerId,
      practitionerEmail: c.practitionerEmail,
      practitionerName: c.practitionerName,
      type: "commission",
      amount: c.amount,
      relatedType: "CdoCommission",
      relatedId: c._id,
      description: `Commission earned on ${c.orderName}`,
      occurredAt: c.earnedAt,
    });
  }
  for (const po of payouts) {
    if (po.status !== "paid") continue;
    events.push({
      practitionerId: po.practitionerId,
      practitionerEmail: po.practitionerEmail,
      practitionerName: po.practitionerName,
      type: "payout",
      amount: -po.amount,
      relatedType: "CdoPayout",
      relatedId: po._id,
      description: `Payout ${po.reference} via ${po.method}`,
      occurredAt: po.paidAt || po.periodEnd,
    });
  }

  // running balance per practitioner
  const byPractitioner = new Map();
  events.sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
  for (const e of events) {
    const prev = byPractitioner.get(e.practitionerEmail) || 0;
    const balanceAfter = round2(prev + e.amount);
    byPractitioner.set(e.practitionerEmail, balanceAfter);
    e.shop = SHOP;
    e.currency = CURRENCY;
    e.balanceAfter = balanceAfter;
  }
  return events;
}

// ---- main -------------------------------------------------------------

async function clearDemo() {
  const filter = { practitionerEmail: DEMO_EMAIL_RX };
  const [o, c, p, r, t] = await Promise.all([
    CdoOrder.deleteMany(filter),
    CdoCommission.deleteMany(filter),
    CdoPayout.deleteMany(filter),
    CdoReferral.deleteMany(filter),
    CdoTransaction.deleteMany(filter),
  ]);
  return {
    orders: o.deletedCount,
    commissions: c.deletedCount,
    payouts: p.deletedCount,
    referrals: r.deletedCount,
    transactions: t.deletedCount,
  };
}

async function main() {
  const clearOnly = process.argv.includes("--clear");

  await connectDB();
  console.log(`[seed] connected — shop=${SHOP}`);

  const removed = await clearDemo();
  console.log("[seed] cleared existing demo rows:", removed);

  if (clearOnly) {
    console.log("[seed] --clear specified, done.");
    await mongoose.connection.close();
    return;
  }

  const practitioners = makePractitioners(6);
  const orders = buildOrders(practitioners);
  const commissions = buildCommissions(orders);
  const payouts = buildPayouts(practitioners, commissions);
  const referrals = buildReferrals(practitioners, orders);
  const transactions = buildTransactions(commissions, payouts);

  await CdoOrder.insertMany(orders);
  await CdoCommission.insertMany(commissions);
  await CdoPayout.insertMany(payouts);
  await CdoReferral.insertMany(referrals);
  await CdoTransaction.insertMany(transactions);

  // Settings singleton — upsert so we never create a duplicate.
  await CdoSetting.updateOne(
    { singletonKey: "cdo-program" },
    {
      $set: {
        shop: SHOP,
        programName: "CDO Program",
        defaultCommissionRate: COMMISSION_RATE,
        currency: CURRENCY,
        payoutSchedule: "monthly",
        minimumPayoutAmount: 50,
        autoApproveCommissions: false,
        cookieWindowDays: 30,
      },
    },
    { upsert: true },
  );

  console.log("[seed] inserted:", {
    practitioners: practitioners.length,
    orders: orders.length,
    commissions: commissions.length,
    payouts: payouts.length,
    referrals: referrals.length,
    transactions: transactions.length,
    settings: 1,
  });

  await mongoose.connection.close();
  console.log("[seed] done.");
}

main().catch(async (err) => {
  console.error("[seed] failed:", err);
  try {
    await mongoose.connection.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
