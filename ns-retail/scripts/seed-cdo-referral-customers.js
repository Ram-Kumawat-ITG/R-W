/* eslint-env node */
// Seed CDO customer applications mapped to EXISTING practitioners via
// referral codes — for verifying referral validation, practitioner→
// customer mapping, discount application, and cross-collection reporting.
//
// User-type model:
//   • Practitioner → wholesale_applications  (owns + shares a referral code)
//   • Customer     → cdo_applications         (Retailer + Patient)
//
// This script targets two practitioners that ALREADY EXIST in
// wholesale_applications (Durgesh Selkari + Parker), ensures each has a
// referral code in cdo_practitioner_codes (practitionerSource:"wholesale"),
// then seeds one customer per practitioner in cdo_applications carrying a
// referral snapshot that maps back to the practitioner + the discount the
// customer is eligible for.
//
// Safety:
//   • It NEVER creates or deletes wholesale_applications rows — the
//     practitioners must already exist (the script errors out if not).
//   • Customers are tagged under SEED_DOMAIN (@cdo-ref.test) and the codes
//     are tracked by their exact code strings, so --clear / re-runs only
//     touch this script's own data (and not the seed:cdo-apps set, which
//     lives under @cdo-seed.test).
//
// Run with:  npm run seed:cdo-ref
//            npm run seed:cdo-ref -- --clear   (remove this script's rows)

import mongoose from "mongoose";
import connectDB from "../app/db/mongo.server.js";
import WholesaleApplication from "../app/models/wholesaleApplication.server.js";
import CdoApplication from "../app/models/cdoApplication.server.js";
import CdoPractitionerCode from "../app/models/cdoPractitionerCode.server.js";
import CdoSetting from "../app/models/cdoSetting.server.js";

const SEED_DOMAIN = "cdo-ref.test";
const SEED_EMAIL_RX = new RegExp(`@${SEED_DOMAIN.replace(".", "\\.")}$`);

// Practitioner (by existing email) → referral code → customer scenario.
const TARGETS = [
  {
    practitionerEmail: "durgeshselkari@itgeeks.com",
    code: "DURGESH10",
    discountPercent: 0.1, // 10%
    customer: { applicantType: "patient", firstName: "Aarav", lastName: "Patel" },
  },
  {
    practitionerEmail: "parker@itgeeks.com",
    code: "PARKER20",
    discountPercent: 0.2, // 20%
    customer: {
      applicantType: "retailer",
      firstName: "Linda",
      lastName: "Brooks",
      businessName: "Brooks Natural Health",
    },
  },
];

const CODES = TARGETS.map((t) => t.code);
const emailFor = (first, last) =>
  `${first}.${last}`.toLowerCase() + `@${SEED_DOMAIN}`;

async function clearSeed() {
  const [custRes, codeRes] = await Promise.all([
    CdoApplication.deleteMany({ email: SEED_EMAIL_RX }),
    CdoPractitionerCode.deleteMany({ code: { $in: CODES } }),
  ]);
  return { customers: custRes.deletedCount, codes: codeRes.deletedCount };
}

async function main() {
  const clearOnly = process.argv.includes("--clear");

  await connectDB();
  console.log("[seed-ref] connected");

  const removed = await clearSeed();
  console.log("[seed-ref] cleared existing seed rows:", removed);

  if (clearOnly) {
    console.log("[seed-ref] --clear specified, done.");
    await mongoose.connection.close();
    return;
  }

  // Program default commission rate (mirrors cdo.service.getSettings) so
  // the snapshot matches what the live buildReferralSnapshot would store
  // when a code inherits the default.
  const settings = await CdoSetting.findOne({ singletonKey: "cdo-program" }).lean();
  const defaultCommissionRate = settings?.defaultCommissionRate ?? 0.1;

  const now = new Date();

  for (const t of TARGETS) {
    // 1) Practitioner must already exist in wholesale_applications.
    const practitioner = await WholesaleApplication.findOne({
      email: t.practitionerEmail,
    }).lean();
    if (!practitioner) {
      throw new Error(
        `Practitioner ${t.practitionerEmail} not found in wholesale_applications — create it first.`,
      );
    }
    const practitionerName =
      `${practitioner.firstName || ""} ${practitioner.lastName || ""}`.trim();
    const shop = practitioner.shop ?? null;

    // 2) Ensure the referral code exists (source = wholesale). Clear any
    //    stale primary on this practitioner first so the partial unique
    //    index { practitionerId, isPrimary } can't trip.
    await CdoPractitionerCode.updateMany(
      { practitionerId: practitioner._id.toString(), isPrimary: true },
      { $set: { isPrimary: false, updatedBy: "seed-cdo-referral" } },
    );
    const code = await CdoPractitionerCode.create({
      shop,
      practitionerId: practitioner._id.toString(),
      practitionerSource: "wholesale",
      practitionerEmail: (practitioner.email || "").toLowerCase(),
      practitionerName,
      code: t.code,
      isPrimary: true,
      discountPercent: t.discountPercent,
      commissionRate: null, // inherit program default
      status: "active",
      createdBy: "seed-cdo-referral",
      updatedBy: "seed-cdo-referral",
    });

    // 3) Customer in cdo_applications with the referral snapshot (built
    //    the same way cdo.service.buildReferralSnapshot would).
    const referral = {
      code: code.code,
      codeId: code._id.toString(),
      practitionerId: practitioner._id.toString(),
      practitionerSource: "wholesale",
      practitionerName,
      practitionerEmail: (practitioner.email || "").toLowerCase(),
      discountPercent: code.discountPercent,
      commissionRate:
        code.commissionRate != null ? code.commissionRate : defaultCommissionRate,
      linkedAt: now,
    };
    const customer = await CdoApplication.create({
      shop,
      applicantType: t.customer.applicantType,
      firstName: t.customer.firstName,
      lastName: t.customer.lastName,
      email: emailFor(t.customer.firstName, t.customer.lastName),
      businessName: t.customer.businessName || undefined,
      status: "approved",
      submittedAt: now,
      referral,
    });

    console.log(
      `[seed-ref] ${practitionerName} (wholesale_app=${practitioner._id}) → code ${code.code} @ ${(t.discountPercent * 100).toFixed(0)}%  ⇒  customer ${t.customer.firstName} ${t.customer.lastName} [${t.customer.applicantType}] (cdo_app=${customer._id})`,
    );
  }

  console.log(`[seed-ref] done — ${TARGETS.length} codes + ${TARGETS.length} customers.`);
  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error("[seed-ref] failed:", err);
  try {
    await mongoose.connection.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
