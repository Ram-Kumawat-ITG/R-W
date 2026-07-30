/* eslint-env node */
// Removes ALL migrated data so the stores can be reused for a fresh migration test.
//
// TARGETING: every record is identified by its own migration marker, never by a
// tag search. Shopify's customersCount() silently IGNORES its query filter (every
// tag variant returns the same total), so a tag-based sweep could delete native
// customers. Instead the retail customers to delete are exactly the
// cdo_applications.customerId values carrying migrationSource:'retail_customer'.
//
// PRESERVED (asserted before and after):
//   • retail Shopify customers not linked to a migrated cdo_application (3)
//   • cdo_applications without migrationSource:'retail_customer' (2)
//   • cdo_practitioner_codes without migrationSource:'goaffpro' (4 wholesale test codes)
//   • cdo_transactions (none are migrated)
//   • wholesale_applications without a migration marker (1)
//
// NOT POSSIBLE HERE: the WHOLESALE Shopify store. There is no offline session and
// no admin token for ns-wholesale-stagging-1, so its ~1,094 customers cannot be
// deleted from code — see the summary this prints. Its Mongo records ARE removed.
//
// EMAIL: Shopify does not email on customerDelete / discountCodeDelete, and this
// script calls no notification path. The global email kill switch is verified ON
// before anything is deleted, and the run aborts if it is off.
//
// SAFE BY DEFAULT: dry run unless you pass --apply.
//
//   node --experimental-loader ./scripts/extensionless-loader.mjs --env-file-if-exists=.env \
//        scripts/delete-migrated-data.js            # dry run
//   ... scripts/delete-migrated-data.js --apply     # delete

import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import connectDB from "../app/db/mongo.server.js";

const arg = (n, d = null) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.slice(n.length + 3) : d;
};
const APPLY = process.argv.includes("--apply");
const LIMIT = Number(arg("limit", 0)) || 0;
const PACING_MS = Math.max(0, Number(arg("pacing", 120)) || 0);
const LOG_DIR = arg("log-dir", "../docs/Goaffpro/logs");
const SKIP_SHOPIFY = process.argv.includes("--skip-shopify");

const API = "2025-10";
const nowIso = () => new Date().toISOString();
const stamp = () => nowIso().replace(/[:.]/g, "-").slice(0, 19);

function readEnvFile(p) {
  const t = fs.readFileSync(p, "utf8");
  return (k) => (t.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
}

async function main() {
  const started = Date.now();
  console.log(`\n=== DELETE MIGRATED DATA — ${APPLY ? "APPLY (deleting)" : "DRY RUN"} ===\n`);

  const rv = readEnvFile(path.resolve("./.env"));
  const wv = readEnvFile(path.resolve("../wholesale/.env"));
  const RETAIL = rv("RETAIL_SHOP_DOMAIN");
  const WHOLESALE = rv("WHOLESALE_SHOP");
  // The app's own offline session token is revoked; the custom-app token works.
  const TOKEN = wv("RETAIL_ADMIN_ACCESS_TOKEN");

  await connectDB();
  const db = mongoose.connection.db;

  // ── hard safety gate: email must be suppressed ──
  const settings = await db.collection("cron_notification_settings").findOne({});
  const emailPaused = settings?.emailNotificationsPaused === true;
  console.log(`email kill switch : ${emailPaused ? "ON (suppressed)" : "*** OFF ***"}`);
  let liveCron = 0;
  for (const c of ["agenda_jobs", "cdo_agenda_jobs"]) {
    try { liveCron += await db.collection(c).countDocuments({ repeatInterval: { $exists: true, $ne: null }, disabled: { $ne: true } }); } catch { /* collection may not exist */ }
  }
  console.log(`live recurring cron: ${liveCron}`);
  if (APPLY && !emailPaused) {
    console.error("\nABORT: the global email kill switch is OFF. Turn it on before deleting real customer data.");
    process.exit(1);
  }
  if (APPLY && liveCron > 0) {
    console.error(`\nABORT: ${liveCron} recurring cron job(s) are live. Pause them before deleting.`);
    process.exit(1);
  }

  // ── what we are about to touch ──
  const migratedApps = await db.collection("cdo_applications")
    .find({ migrationSource: "retail_customer" }, { projection: { customerId: 1, email: 1 } }).toArray();
  const deletableCustomerIds = migratedApps.map((a) => a.customerId).filter(Boolean);

  const PRESERVE = {
    cdo_applications: await db.collection("cdo_applications").countDocuments({ migrationSource: { $ne: "retail_customer" } }),
    cdo_practitioner_codes: await db.collection("cdo_practitioner_codes").countDocuments({ migrationSource: { $ne: "goaffpro" } }),
    cdo_transactions: await db.collection("cdo_transactions").countDocuments({}),
    wholesale_applications: await db.collection("wholesale_applications").countDocuments({
      migratedFromTalon: { $ne: true }, migratedFromPdffiller: { $ne: true },
    }),
  };

  const PLAN = [
    ["retail Shopify customers", deletableCustomerIds.length, "by cdo_applications.customerId"],
    ["retail Shopify discounts", await db.collection("cdo_practitioner_codes").countDocuments({ migrationSource: "goaffpro", shopifyDiscountId: { $ne: null } }), "by cdo_practitioner_codes.shopifyDiscountId"],
    ["cdo_applications", migratedApps.length, "migrationSource=retail_customer"],
    ["cdo_orders", await db.collection("cdo_orders").countDocuments({ migrationSource: "goaffpro" }), "migrationSource=goaffpro"],
    ["cdo_commissions", await db.collection("cdo_commissions").countDocuments({ migrationSource: "goaffpro" }), "migrationSource=goaffpro"],
    ["cdo_payouts", await db.collection("cdo_payouts").countDocuments({ migrationSource: "goaffpro" }), "migrationSource=goaffpro"],
    ["cdo_referrals", await db.collection("cdo_referrals").countDocuments({ migrationSource: "goaffpro" }), "migrationSource=goaffpro"],
    ["cdo_practitioner_codes", await db.collection("cdo_practitioner_codes").countDocuments({ migrationSource: "goaffpro" }), "migrationSource=goaffpro"],
    ["cdo_migration_runs", await db.collection("cdo_migration_runs").countDocuments({}), "all (audit log of the test imports)"],
    ["practitioner_migration_runs", await db.collection("practitioner_migration_runs").countDocuments({}), "all (audit log)"],
    ["wholesale_applications", await db.collection("wholesale_applications").countDocuments({ $or: [{ migratedFromTalon: true }, { migratedFromPdffiller: true }] }), "migratedFromTalon / migratedFromPdffiller"],
  ];

  console.log(`\nretail shop    : ${RETAIL}  (token ${TOKEN ? "present" : "MISSING"})`);
  console.log(`wholesale shop : ${WHOLESALE}  (token MISSING — its Shopify customers CANNOT be deleted here)`);
  console.log("\nTO DELETE");
  for (const [label, n, how] of PLAN) console.log(`  ${String(n).padStart(6)}  ${label.padEnd(30)} ${how}`);
  console.log("\nTO PRESERVE (asserted after)");
  for (const [k, v] of Object.entries(PRESERVE)) console.log(`  ${String(v).padStart(6)}  ${k}`);

  if (!APPLY) {
    console.log("\nDRY RUN — nothing deleted. Re-run with --apply.\n");
    await mongoose.disconnect();
    return;
  }

  fs.mkdirSync(path.resolve(LOG_DIR), { recursive: true });
  const failCsv = path.resolve(LOG_DIR, `delete-migrated-failed-${stamp()}.csv`);
  fs.writeFileSync(failCsv, "kind,id,email,reason\n");
  const csv = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

  // ── throttle-aware Shopify call (200 + errors[].extensions.code, never a 429) ──
  async function gql(query, variables) {
    let delay = 1000;
    for (let attempt = 1; attempt <= 8; attempt++) {
      const res = await fetch(`https://${RETAIL}/admin/api/${API}/graphql.json`, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      const json = await res.json();
      const throttled = (Array.isArray(json?.errors) ? json.errors : []).some((e) => {
        const c = e?.extensions?.code;
        return c === "THROTTLED" || c === "MAX_COST_EXCEEDED";
      });
      if (!throttled) return json;
      if (attempt === 8) return json;
      await new Promise((r) => setTimeout(r, Math.round(delay * (0.75 + Math.random() * 0.5))));
      delay = Math.min(30000, delay * 2);
    }
    return null;
  }

  let stopping = false;
  const onSig = () => { if (stopping) process.exit(130); stopping = true; console.log("\n! interrupt — finishing the current record, then exiting. Re-run to resume.\n"); };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  // ── 1. Shopify discounts (before the codes that reference them) ──
  let discDeleted = 0, discFailed = 0;
  if (!SKIP_SHOPIFY && TOKEN) {
    const codes = await db.collection("cdo_practitioner_codes")
      .find({ migrationSource: "goaffpro", shopifyDiscountId: { $ne: null } }, { projection: { code: 1, shopifyDiscountId: 1 } }).toArray();
    console.log(`\ndeleting ${codes.length} Shopify discounts…`);
    for (const k of codes) {
      if (stopping) break;
      const j = await gql(
        `mutation D($id: ID!) { discountCodeDelete(id: $id) { deletedCodeDiscountId userErrors { message } } }`,
        { id: k.shopifyDiscountId },
      );
      const ue = j?.data?.discountCodeDelete?.userErrors || [];
      const gone = /not found|does not exist/i.test(JSON.stringify(j?.errors || ue));
      if (j?.data?.discountCodeDelete?.deletedCodeDiscountId || gone) discDeleted++;
      else { discFailed++; fs.appendFileSync(failCsv, `${["discount", k.shopifyDiscountId, k.code, JSON.stringify(ue || j?.errors)].map(csv).join(",")}\n`); }
      if (discDeleted % 50 === 0 && discDeleted) console.log(`   discounts ${discDeleted}/${codes.length}`);
      if (PACING_MS) await new Promise((r) => setTimeout(r, PACING_MS));
    }
    console.log(`   discounts deleted ${discDeleted}, failed ${discFailed}`);
  }

  // ── 2. Retail Shopify customers + their cdo_applications doc, one at a time ──
  // Deleting the Mongo doc immediately after the Shopify delete makes the run
  // naturally resumable: whatever is still in cdo_applications is still to do.
  let custDeleted = 0, custFailed = 0, custGone = 0;
  if (!SKIP_SHOPIFY && TOKEN) {
    const targets = LIMIT ? migratedApps.slice(0, LIMIT) : migratedApps;
    console.log(`\ndeleting ${targets.length} retail Shopify customers…`);
    for (const a of targets) {
      if (stopping) break;
      if (!a.customerId) { await db.collection("cdo_applications").deleteOne({ _id: a._id }); continue; }
      const j = await gql(
        `mutation D($id: ID!) { customerDelete(input: { id: $id }) { deletedCustomerId userErrors { field message } } }`,
        { id: a.customerId },
      );
      const ue = j?.data?.customerDelete?.userErrors || [];
      const topErr = JSON.stringify(j?.errors || "");
      const notFound = /not found|does not exist|Customer does not exist/i.test(topErr + JSON.stringify(ue));
      if (j?.data?.customerDelete?.deletedCustomerId) { custDeleted++; await db.collection("cdo_applications").deleteOne({ _id: a._id }); }
      else if (notFound) { custGone++; await db.collection("cdo_applications").deleteOne({ _id: a._id }); }
      else {
        custFailed++;
        fs.appendFileSync(failCsv, `${["customer", a.customerId, a.email, JSON.stringify(ue.length ? ue : j?.errors)].map(csv).join(",")}\n`);
      }
      const done = custDeleted + custGone + custFailed;
      if (done % 200 === 0) {
        const rate = done / ((Date.now() - started) / 1000);
        console.log(`   customers ${done}/${targets.length} · deleted ${custDeleted} · already gone ${custGone} · failed ${custFailed} · ${rate.toFixed(1)}/s`);
      }
      if (PACING_MS) await new Promise((r) => setTimeout(r, PACING_MS));
    }
    console.log(`   customers deleted ${custDeleted}, already gone ${custGone}, failed ${custFailed}`);
  }

  // ── 3. Mongo — migrated records only ──
  console.log("\ndeleting Mongo records…");
  const MONGO = [
    ["cdo_applications", { migrationSource: "retail_customer" }],
    ["cdo_commissions", { migrationSource: "goaffpro" }],
    ["cdo_payouts", { migrationSource: "goaffpro" }],
    ["cdo_referrals", { migrationSource: "goaffpro" }],
    ["cdo_orders", { migrationSource: "goaffpro" }],
    ["cdo_practitioner_codes", { migrationSource: "goaffpro" }],
    ["cdo_migration_runs", {}],
    ["practitioner_migration_runs", {}],
    ["wholesale_applications", { $or: [{ migratedFromTalon: true }, { migratedFromPdffiller: true }] }],
  ];
  for (const [name, filter] of MONGO) {
    const r = await db.collection(name).deleteMany(filter);
    console.log(`   ${name.padEnd(30)} deleted ${r.deletedCount}`);
  }

  // ── 4. assert the preserve list survived ──
  console.log("\nverifying preserved records…");
  let broke = 0;
  const after = {
    cdo_applications: await db.collection("cdo_applications").countDocuments({ migrationSource: { $ne: "retail_customer" } }),
    cdo_practitioner_codes: await db.collection("cdo_practitioner_codes").countDocuments({ migrationSource: { $ne: "goaffpro" } }),
    cdo_transactions: await db.collection("cdo_transactions").countDocuments({}),
    wholesale_applications: await db.collection("wholesale_applications").countDocuments({ migratedFromTalon: { $ne: true }, migratedFromPdffiller: { $ne: true } }),
  };
  for (const [k, before] of Object.entries(PRESERVE)) {
    const ok = after[k] === before;
    if (!ok) broke++;
    console.log(`   ${ok ? "OK  " : "FAIL"} ${k.padEnd(30)} before ${before} → after ${after[k]}`);
  }

  console.log(`\n=== ${stopping ? "INTERRUPTED" : "DONE"} in ${Math.round((Date.now() - started) / 1000)}s ===`);
  console.log(`   Shopify discounts deleted : ${discDeleted}${discFailed ? ` (${discFailed} failed)` : ""}`);
  console.log(`   Shopify customers deleted : ${custDeleted}${custGone ? ` (+${custGone} already gone)` : ""}${custFailed ? ` (${custFailed} failed)` : ""}`);
  console.log(`   preserve assertions       : ${broke ? `${broke} FAILED` : "all passed"}`);
  if (custFailed || discFailed) console.log(`   failures: ${path.relative(process.cwd(), failCsv)}`);
  console.log(`\n   NOT DONE — the wholesale Shopify store (${WHOLESALE}) has no token here, so its`);
  console.log("   customers still exist. Delete them from Shopify admin (Customers → select → Delete),");
  console.log("   or add an admin token and re-run. Its Mongo records ARE removed.\n");

  await mongoose.disconnect();
  if (broke) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch(async (err) => {
  console.error(`\n[delete-migrated-data] FAILED: ${err?.message || err}`);
  if (err?.stack) console.error(err.stack);
  try { await mongoose.disconnect(); } catch { /* already down */ }
  process.exit(1);
});
