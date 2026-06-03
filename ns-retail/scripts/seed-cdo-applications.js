/* eslint-env node */
// Seed the CDO referral / non-referral CUSTOMER workflows.
//
// User-type model:
//   • Practitioner → wholesale_applications (owns + shares a referral code)
//   • Customer     → cdo_applications        (Retailer + Patient)
//
// This script seeds, end to end:
//   1. A practitioner in `wholesale_applications` (approved, resells) and
//      a primary, active referral code in `cdo_practitioner_codes`
//      (practitionerSource:"wholesale") carrying a 15% discount.
//   2. A CUSTOMER WITH that referral code in `cdo_applications` — the
//      referral snapshot maps back to the practitioner and captures the
//      15% discount the customer is eligible for.
//   3. A CUSTOMER WITHOUT a referral code in `cdo_applications` —
//      referral:null, no discount.
//
// Run with:  npm run seed:cdo-apps
//            npm run seed:cdo-apps -- --clear   (remove the seeded rows)
//
// Idempotent: every seeded row is tagged with an email under SEED_DOMAIN
// and removed before re-inserting (across all three collections), so
// re-running refreshes the scenarios without touching real data.

import mongoose from "mongoose";
import connectDB from "../app/db/mongo.server.js";
import WholesaleApplication from "../app/models/wholesaleApplication.server.js";
import CdoApplication from "../app/models/cdoApplication.server.js";
import CdoPractitionerCode from "../app/models/cdoPractitionerCode.server.js";

const SEED_DOMAIN = "cdo-seed.test";
const SEED_EMAIL_RX = new RegExp(`@${SEED_DOMAIN.replace(".", "\\.")}$`);

// One practitioner, who owns the referral code customers apply with.
const PRACTITIONER = {
  firstName: "Emily",
  lastName: "Carter",
  businessName: "Carter Wellness Co.",
  code: "EMILY15",
  discountPercent: 0.15, // 15% — fraction, matches cdo_practitioner_codes format
};

// Two customers covering both workflows + both applicant types.
const CUSTOMERS = [
  {
    // Scenario 1 — customer WITH a referral code.
    applicantType: "patient",
    firstName: "John",
    lastName: "Smith",
    referralCode: PRACTITIONER.code,
  },
  {
    // Scenario 2 — customer WITHOUT a referral code.
    applicantType: "retailer",
    firstName: "Rita",
    lastName: "Gomez",
    businessName: "Gomez Family Pharmacy",
    referralCode: null,
  },
];

const emailFor = (first, last) =>
  `${first}.${last}`.toLowerCase() + `@${SEED_DOMAIN}`;

async function clearSeed() {
  const [pract, cust] = await Promise.all([
    WholesaleApplication.find({ email: SEED_EMAIL_RX }).select("_id").lean(),
    CdoApplication.find({ email: SEED_EMAIL_RX }).select("_id").lean(),
  ]);
  const ids = [...pract, ...cust].map((d) => d._id.toString());

  const [codeRes, practRes, custRes] = await Promise.all([
    CdoPractitionerCode.deleteMany({
      $or: [
        { practitionerEmail: SEED_EMAIL_RX },
        { practitionerId: { $in: ids } },
      ],
    }),
    WholesaleApplication.deleteMany({ email: SEED_EMAIL_RX }),
    CdoApplication.deleteMany({ email: SEED_EMAIL_RX }),
  ]);

  return {
    practitioners: practRes.deletedCount,
    customers: custRes.deletedCount,
    codes: codeRes.deletedCount,
  };
}

async function main() {
  const clearOnly = process.argv.includes("--clear");

  await connectDB();
  console.log("[seed-apps] connected");

  const removed = await clearSeed();
  console.log("[seed-apps] cleared existing seed rows:", removed);

  if (clearOnly) {
    console.log("[seed-apps] --clear specified, done.");
    await mongoose.connection.close();
    return;
  }

  // Reuse a shop value from real data so the { shop, code } unique index
  // on cdo_practitioner_codes is consistent.
  const sample =
    (await WholesaleApplication.findOne({}).select("shop").lean()) ||
    (await CdoApplication.findOne({}).select("shop").lean());
  const shop = sample?.shop || null;
  console.log(`[seed-apps] using shop=${shop ?? "(none)"}`);

  const now = new Date();

  // 1) Practitioner in wholesale_applications.
  const practEmail = emailFor(PRACTITIONER.firstName, PRACTITIONER.lastName);
  const practitioner = await WholesaleApplication.create({
    shop,
    firstName: PRACTITIONER.firstName,
    lastName: PRACTITIONER.lastName,
    email: practEmail,
    businessName: PRACTITIONER.businessName,
    status: "approved",
    submittedAt: now,
    resellsProducts: true,
    tax: { itemsToResell: "yes" },
  });

  // 1b) The practitioner's referral code (source = wholesale).
  const code = await CdoPractitionerCode.create({
    shop,
    practitionerId: practitioner._id.toString(),
    practitionerSource: "wholesale",
    practitionerEmail: practEmail,
    practitionerName: `${PRACTITIONER.firstName} ${PRACTITIONER.lastName}`,
    code: PRACTITIONER.code,
    isPrimary: true,
    discountPercent: PRACTITIONER.discountPercent,
    commissionRate: null, // inherit program default
    status: "active",
    createdBy: "seed-cdo-applications",
    updatedBy: "seed-cdo-applications",
  });
  console.log(
    `[seed-apps] practitioner ${PRACTITIONER.firstName} ${PRACTITIONER.lastName} (wholesale_app=${practitioner._id}) → code ${code.code} @ ${(PRACTITIONER.discountPercent * 100).toFixed(0)}%`,
  );

  // 2 + 3) Customers in cdo_applications.
  for (const c of CUSTOMERS) {
    const email = emailFor(c.firstName, c.lastName);

    // Build the referral snapshot the same way the registration flow
    // would: resolve the code → practitioner + discount. null when no
    // code (or an invalid one) was supplied.
    let referral = null;
    if (c.referralCode) {
      referral = {
        code: code.code,
        codeId: code._id.toString(),
        practitionerId: practitioner._id.toString(),
        practitionerSource: "wholesale",
        practitionerName: `${PRACTITIONER.firstName} ${PRACTITIONER.lastName}`,
        practitionerEmail: practEmail,
        discountPercent: code.discountPercent,
        commissionRate: code.commissionRate,
        linkedAt: now,
      };
    }

    const customer = await CdoApplication.create({
      shop,
      applicantType: c.applicantType,
      firstName: c.firstName,
      lastName: c.lastName,
      email,
      businessName: c.businessName || undefined,
      status: "approved",
      submittedAt: now,
      referral,
    });

    console.log(
      `[seed-apps] customer ${c.firstName} ${c.lastName} [${c.applicantType}] (cdo_app=${customer._id}) → ${
        referral
          ? `referral ${referral.code} @ ${(referral.discountPercent * 100).toFixed(0)}% (practitioner ${referral.practitionerId})`
          : "no referral, no discount"
      }`,
    );
  }

  console.log("[seed-apps] done — 1 practitioner, 1 code, 2 customers.");
  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error("[seed-apps] failed:", err);
  try {
    await mongoose.connection.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
