/* eslint-env node */
// Migrate existing practitioner discounts from plain DiscountCodeBasic
// (customerSelection: {all: true} — usable by ANY customer) to the new
// Function-backed DiscountCodeApp created by createShopifyDiscount(), which
// the practitioner-discount Shopify Function gates on the buyer's bound
// practitioner. Every code created BEFORE that change is still wide open —
// this script closes that gap for existing rows in cdo_practitioner_codes.
//
// Shopify code strings are globally unique, so the old DiscountCodeBasic
// must be DELETED (not just deactivated) before a new DiscountCodeApp can be
// created with the same code — the shareable /discount/<code> link keeps
// working unchanged since the code string itself never changes.
//
// SAFE BY DEFAULT: runs as a dry run (logs what it would do, touches
// nothing) unless you pass --apply. Continues past individual failures —
// one bad row never blocks the rest of the batch — and prints a summary at
// the end so failures are easy to spot and re-run.
//
// Run with:
//   node --env-file-if-exists=.env scripts/migrate-practitioner-discounts.js            (dry run)
//   node --env-file-if-exists=.env scripts/migrate-practitioner-discounts.js --apply     (for real)
//
// Requires CDO_PRACTITIONER_DISCOUNT_FUNCTION_ID to be set (same requirement
// as createShopifyDiscount() itself) and the practitioner-discount function
// extension already deployed.

import mongoose from "mongoose";
import connectDB from "../app/db/mongo.server.js";
import CdoPractitionerCode from "../app/models/cdoPractitionerCode.server.js";
import { unauthenticated } from "../app/shopify.server.js";
import {
  createShopifyDiscount,
  deleteShopifyDiscount,
} from "../app/services/cdo/cdo.discount.service.js";

const APPLY = process.argv.includes("--apply");

// `cdo_practitioner_codes.shop` is metadata recording which app CREATED the
// row (often the wholesale app's shop domain, cross-app) — it is NOT
// necessarily the shop where the backing Shopify discount actually lives.
// The real retail shop is wherever this app has an installed OFFLINE
// session, since that's the only shop Admin API calls (unauthenticated.admin)
// can actually authenticate against. Resolve it once at startup rather than
// trusting doc.shop per-row.
async function resolveRetailShop() {
  if (process.env.CDO_RETAIL_SHOP) return process.env.CDO_RETAIL_SHOP;
  const session = await mongoose.connection.db
    .collection("shopify_sessions")
    .findOne({ isOnline: false });
  if (!session?.shop) {
    throw new Error(
      "Could not resolve the retail shop — no offline session found in shopify_sessions, and CDO_RETAIL_SHOP is not set.",
    );
  }
  return session.shop;
}

const QUERY_DISCOUNT_TYPE = `#graphql
  query CheckDiscountType($id: ID!) {
    discountNode(id: $id) {
      id
      discount { __typename }
    }
  }
`;

async function getDiscountTypename(shop, discountId) {
  const { admin } = await unauthenticated.admin(shop);
  const res = await admin.graphql(QUERY_DISCOUNT_TYPE, {
    variables: { id: discountId },
  });
  const data = await res.json();
  if (data?.errors?.length) {
    throw new Error(
      `discountNode lookup failed: ${JSON.stringify(data.errors).slice(0, 200)}`,
    );
  }
  // null discountNode → the id no longer resolves to anything (deleted,
  // or never existed) — treat as "not yet migrated, nothing to delete".
  return data?.data?.discountNode?.discount?.__typename || null;
}

async function migrateOne(doc, retailShop) {
  const label = `[${doc.code}] (practitioner ${doc.practitionerId})`;

  if (doc.status !== "active") {
    return { code: doc.code, outcome: "skipped", reason: `status is "${doc.status}", not active` };
  }
  if (!(doc.discountPercent > 0)) {
    return { code: doc.code, outcome: "skipped", reason: "0% code — attribution-only, no storefront discount to migrate" };
  }

  let typename = null;
  if (doc.shopifyDiscountId) {
    try {
      typename = await getDiscountTypename(retailShop, doc.shopifyDiscountId);
    } catch (err) {
      return { code: doc.code, outcome: "error", reason: `type lookup failed: ${err.message}` };
    }
  }

  if (typename === "DiscountCodeApp") {
    return { code: doc.code, outcome: "skipped", reason: "already Function-backed" };
  }

  console.log(`${label} → will delete old ${typename || "(missing)"} discount and recreate as Function-backed`);
  if (!APPLY) {
    return { code: doc.code, outcome: "dry-run", reason: typename || "no existing discount found" };
  }

  if (typename === "DiscountCodeBasic" && doc.shopifyDiscountId) {
    const del = await deleteShopifyDiscount({ shop: retailShop, discountId: doc.shopifyDiscountId });
    if (!del.ok) {
      return { code: doc.code, outcome: "error", reason: `delete failed: ${del.error}` };
    }
  }

  const created = await createShopifyDiscount({
    shop: retailShop,
    code: doc.code,
    discountPercent: doc.discountPercent,
    practitionerId: doc.practitionerId,
    practitionerName: doc.practitionerName,
  });
  if (!created.ok) {
    return { code: doc.code, outcome: "error", reason: `recreate failed: ${created.error}` };
  }

  doc.shopifyDiscountId = created.shopifyDiscountId || null;
  doc.shopifyDiscountUrl = created.shopifyDiscountUrl || doc.shopifyDiscountUrl;
  await doc.save();

  return { code: doc.code, outcome: "migrated" };
}

async function main() {
  if (!process.env.CDO_PRACTITIONER_DISCOUNT_FUNCTION_ID) {
    console.error(
      "CDO_PRACTITIONER_DISCOUNT_FUNCTION_ID is not set — deploy the practitioner-discount function extension and set its Function ID first.",
    );
    process.exit(1);
  }

  console.log(APPLY ? "Running LIVE (--apply) — this will delete and recreate Shopify discounts.\n" : "Running DRY RUN — pass --apply to actually migrate.\n");

  await connectDB();

  const retailShop = await resolveRetailShop();
  console.log(`Resolved retail shop: ${retailShop}\n`);

  const codes = await CdoPractitionerCode.find({ status: "active" });
  console.log(`Found ${codes.length} active practitioner code(s).\n`);

  const results = [];
  for (const doc of codes) {
    try {
      results.push(await migrateOne(doc, retailShop));
    } catch (err) {
      results.push({ code: doc.code, outcome: "error", reason: err?.message || String(err) });
    }
  }

  const byOutcome = results.reduce((acc, r) => {
    (acc[r.outcome] ||= []).push(r);
    return acc;
  }, {});

  console.log("\n── Summary ──────────────────────────────");
  for (const [outcome, rows] of Object.entries(byOutcome)) {
    console.log(`${outcome}: ${rows.length}`);
    for (const r of rows) {
      console.log(`  - ${r.code}${r.reason ? ` — ${r.reason}` : ""}`);
    }
  }

  if (byOutcome.error?.length) {
    console.log("\nSome codes failed — safe to re-run this script, it only touches rows that still need migrating.");
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Migration script crashed:", err);
    process.exit(1);
  });
