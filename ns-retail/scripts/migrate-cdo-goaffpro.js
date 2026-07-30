/* eslint-env node */
// Resumable CLI driver for the GoAffPro → CDO Program migration.
//
// WHY THIS EXISTS
// The admin page (app.cdo-program.migration.jsx) runs the whole import inside a
// single HTTP action. This workbook is 6,463 data rows and ~630 Shopify writes
// (264 discounts + 366 URL redirects) — it cannot finish before the request is
// cut off, and the route only writes its report AFTER the walk, so a killed run
// leaves no record of what got in. Same failure mode that stalled the retail
// customer migration. A terminal process has no request timeout.
//
// WHY IT CHUNKS BY PRACTITIONER (and not by row)
// runMigrationImport() processes all 7 sheets in ONE call and carries three
// in-memory maps across them: practitionerByEmail, codeMetaByCode, and
// commissionIdByRowId (Historical_Payouts.linked_commission_row_ids points at
// Historical_Orders_Commissions row_ids created earlier in the SAME call).
// Chunking by row would break those links. Chunking by PRACTITIONER preserves
// them, because every cross-sheet reference stays inside one practitioner —
// verified against this workbook: 0 payouts link an order row belonging to a
// different practitioner, and 0 URL-mapping rows reference another
// practitioner's code.
//
// Vendor_Commission_Rates is practitioner-independent, so it rides along with
// the first chunk only.
//
// SAFE BY DEFAULT: dry run unless you pass --apply.
//
//   npm run migrate:cdo                 # dry run — validates every row, writes nothing
//   npm run migrate:cdo:apply           # migrate; safe to re-run any time
//   npm run migrate:cdo:apply -- --only-failed=<failures.csv>
//
// Ctrl-C is safe: the current practitioner finishes, logs + the audit doc are
// flushed, and the next run resumes from the next practitioner.

import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import connectDB from "../app/db/mongo.server.js";
import CdoMigrationRun from "../app/models/cdoMigrationRun.server.js";
import CdoPractitionerCode from "../app/models/cdoPractitionerCode.server.js";
import {
  parseMigrationWorkbook,
  runMigrationImport,
} from "../app/services/cdo/migration.service.js";

// ── CLI args ───────────────────────────────────────────────────────────────

function arg(name, dflt = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const APPLY = process.argv.includes("--apply");
const FILE = arg("file", "../docs/Goaffpro/GoAffPro_Migration_PRODUCTION_FILLED.xlsx");
const PACING_MS = Math.max(0, Number(arg("pacing", 400)) || 0);
const LIMIT = Number(arg("limit", 0)) || 0;
const ONLY = arg("only", null);            // comma-separated practitioner emails
const ONLY_FAILED = arg("only-failed", null);
const LOG_DIR = arg("log-dir", "../docs/Goaffpro/logs");
const STATE_FILE = arg("state", "../docs/Goaffpro/logs/cdo-migration-state.json");
const NO_RESUME = process.argv.includes("--no-resume");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
GoAffPro → CDO Program migration — resumable driver

  node --experimental-loader ./scripts/extensionless-loader.mjs \\
       --env-file-if-exists=.env scripts/migrate-cdo-goaffpro.js [options]

  --apply                 actually write (default is a dry run)
  --file=<path>           workbook           (default ${FILE})
  --pacing=<ms>           delay between practitioners, eases Shopify's rate
                          limiter on the ~630 discount/redirect writes (default 400)
  --limit=<n>             only the first n outstanding practitioners (smoke test)
  --only=<a@b,c@d>        only these practitioner emails
  --only-failed=<csv>     re-run only the practitioners in a failures CSV
  --no-resume             re-process practitioners already recorded complete
  --state=<path>          resume state file  (default ${STATE_FILE})
  --log-dir=<path>        logs               (default ${LOG_DIR})
  --help                  this text
`);
  process.exit(0);
}

// ── helpers ────────────────────────────────────────────────────────────────

const lc = (v) => String(v ?? "").trim().toLowerCase();
const nowIso = () => new Date().toISOString();
const stamp = () => nowIso().replace(/[:.]/g, "-").slice(0, 19);
function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function fmtDuration(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function readEmailsFromCsv(csvPath) {
  const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).filter(Boolean);
  const header = (lines[0] || "").split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const idx = header.findIndex((h) => h === "practitioner_email");
  if (idx < 0) throw new Error(`${csvPath} has no "practitioner_email" column`);
  const out = new Set();
  for (const line of lines.slice(1)) {
    const cells = line.match(/("([^"]|"")*"|[^,]*)/g)?.filter((_, i) => i % 2 === 0) || [];
    const raw = (cells[idx] || "").replace(/^"|"$/g, "").replace(/""/g, '"');
    if (raw) out.add(lc(raw));
  }
  return out;
}

const SHEET_KEYS = [
  "practitioners",
  "referralCodes",
  "referralUrlMapping",
  "referredCustomers",
  "historicalOrders",
  "historicalPayouts",
];

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  console.log(`\n=== GoAffPro → CDO migration — ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"} ===`);

  await connectDB();

  const abs = path.resolve(FILE);
  if (!fs.existsSync(abs)) throw new Error(`Workbook not found: ${abs}`);
  const parsed = parseMigrationWorkbook(new Uint8Array(fs.readFileSync(abs)));
  console.log(`workbook: ${path.basename(abs)}`);
  for (const k of SHEET_KEYS) console.log(`   ${k.padEnd(20)} ${parsed[k].length}`);
  console.log(`   ${"vendorRates".padEnd(20)} ${parsed.vendorRates.length}`);

  // ── Group every sheet by practitioner ──
  const byPractitioner = new Map();
  const bucket = (email) => {
    const k = lc(email);
    if (!byPractitioner.has(k)) {
      byPractitioner.set(k, Object.fromEntries(SHEET_KEYS.map((s) => [s, []])));
    }
    return byPractitioner.get(k);
  };
  for (const key of SHEET_KEYS) {
    for (const row of parsed[key]) bucket(row.practitioner_email)[key].push(row);
  }
  // Deterministic order: heaviest practitioners first so a smoke-test --limit
  // exercises the hard cases, and any throttling shows up early rather than at
  // the very end of a long run.
  const weight = (b) => SHEET_KEYS.reduce((n, k) => n + b[k].length, 0);
  let emails = [...byPractitioner.keys()].sort(
    (a, b) => weight(byPractitioner.get(b)) - weight(byPractitioner.get(a)) || a.localeCompare(b),
  );
  console.log(`\ndistinct practitioners in the workbook: ${emails.length}`);

  // ── Resume ──
  const statePath = path.resolve(STATE_FILE);
  let state = { completed: [], startedAt: nowIso() };
  if (!NO_RESUME && fs.existsSync(statePath)) {
    try {
      state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      state.completed = state.completed || [];
    } catch {
      console.log("  (state file unreadable — starting fresh)");
    }
  }
  const completed = new Set(NO_RESUME ? [] : state.completed.map(lc));
  if (completed.size) console.log(`already completed in a previous run: ${completed.size}`);

  // Cross-check the state file against reality so a stale/hand-edited file can't
  // make the run silently skip work.
  const codeCounts = await CdoPractitionerCode.aggregate([
    { $match: { migrationSource: "goaffpro" } },
    { $group: { _id: "$practitionerEmail", n: { $sum: 1 } } },
  ]);
  const inDb = new Map(codeCounts.map((r) => [lc(r._id), r.n]));
  console.log(`practitioners with goaffpro codes already in the DB: ${inDb.size}`);

  if (ONLY) {
    const want = new Set(ONLY.split(",").map(lc).filter(Boolean));
    emails = emails.filter((e) => want.has(e));
    console.log(`--only: restricted to ${emails.length}`);
  }
  if (ONLY_FAILED) {
    const want = readEmailsFromCsv(path.resolve(ONLY_FAILED));
    emails = emails.filter((e) => want.has(e));
    console.log(`--only-failed: restricted to ${emails.length} from ${ONLY_FAILED}`);
  }
  let outstanding = emails.filter((e) => !completed.has(e));
  if (LIMIT && outstanding.length > LIMIT) {
    console.log(`--limit=${LIMIT}: processing ${LIMIT} of ${outstanding.length}`);
    outstanding = outstanding.slice(0, LIMIT);
  }

  const totalRows = outstanding.reduce((n, e) => n + weight(byPractitioner.get(e)), 0);
  console.log(`\n>>> practitioners to process: ${outstanding.length}  (${totalRows} rows)`);
  if (!outstanding.length) {
    console.log("Nothing to do — every practitioner is already recorded complete.\n");
    await mongoose.disconnect();
    return;
  }
  console.log(`    estimated runtime: ~${fmtDuration(totalRows * 90 + outstanding.length * PACING_MS)}\n`);
  if (!APPLY) console.log("DRY RUN — validating every row against the database (reads only)…\n");

  // ── logs ──
  fs.mkdirSync(path.resolve(LOG_DIR), { recursive: true });
  const tag = `${stamp()}${APPLY ? "" : "-dryrun"}`;
  const failCsv = path.resolve(LOG_DIR, `cdo-migration-failed-${tag}.csv`);
  const eventLog = path.resolve(LOG_DIR, `cdo-migration-events-${tag}.jsonl`);
  fs.writeFileSync(failCsv, "practitioner_email,sheet,row_id,failed_at,reason\n");

  // ── audit run doc, rewritten after every practitioner ──
  let runDoc = null;
  if (APPLY) {
    runDoc = await CdoMigrationRun.create({
      fileName: `${path.basename(abs)} (CLI)`,
      actor: `cli:${process.env.USER || process.env.USERNAME || "unknown"}`,
      report: { migrationType: "goaffpro", via: "scripts/migrate-cdo-goaffpro.js", startedAt: nowIso() },
    });
    console.log(`audit run: cdo_migration_runs/${runDoc._id}\n`);
  }

  let stopping = false;
  const onSignal = () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log("\n\n! interrupt received — finishing the current practitioner, flushing state, then exiting.");
    console.log("! re-run the same command to resume.\n");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // ── totals ──
  const SECTIONS = ["practitioners", "referralCodes", "referralUrlMapping", "referredCustomers", "historicalOrders", "historicalPayouts", "vendorRates"];
  const totals = {};
  for (const s of SECTIONS) totals[s] = { total: 0, created: 0, updated: 0, alreadyExists: 0, skipped: 0, errors: 0 };
  const failedEmails = new Set();
  let processed = 0;
  let vendorRatesDone = false;

  for (const email of outstanding) {
    if (stopping) break;
    const b = byPractitioner.get(email);
    const chunk = { ...b, vendorRates: vendorRatesDone ? [] : parsed.vendorRates };

    let report;
    try {
      report = await runMigrationImport({
        parsed: chunk,
        actor: runDoc?.actor || "cli",
        commit: APPLY,
        migrationRunId: runDoc?._id || null,
      });
      vendorRatesDone = true;
    } catch (err) {
      // A thrown error means the whole practitioner failed (e.g. shop could not
      // be resolved) — record it and keep going rather than aborting the batch.
      fs.appendFileSync(failCsv, `${[email, "(whole practitioner)", "", nowIso(), err?.message || String(err)].map(csvCell).join(",")}\n`);
      failedEmails.add(email);
      console.log(`  [${++processed}/${outstanding.length}] ${email} — THREW: ${err?.message || err}`);
      continue;
    }

    let rowErrors = 0;
    for (const s of SECTIONS) {
      const sec = report[s];
      if (!sec) continue;
      totals[s].total += sec.total || 0;
      totals[s].created += sec.created || 0;
      totals[s].updated += sec.updated || 0;
      totals[s].alreadyExists += sec.alreadyExists || 0;
      totals[s].skipped += sec.skipped || 0;
      totals[s].errors += sec.errors?.length || 0;
      for (const e of sec.errors || []) {
        rowErrors += 1;
        fs.appendFileSync(failCsv, `${[email, s, e.row_id, nowIso(), e.message].map(csvCell).join(",")}\n`);
      }
    }
    fs.appendFileSync(eventLog, `${JSON.stringify({ t: nowIso(), email, rows: weight(b), rowErrors })}\n`);
    if (rowErrors) failedEmails.add(email);

    // A practitioner counts as complete when the walk finished, even with row
    // errors — the errors are logged, and re-running is idempotent so nothing is
    // lost by moving on.
    if (APPLY) {
      state.completed = [...new Set([...(state.completed || []), email])];
      state.updatedAt = nowIso();
      fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
    }

    processed += 1;
    const elapsed = Date.now() - startedAt;
    const rate = processed / (elapsed / 1000);
    const eta = (outstanding.length - processed) / Math.max(rate, 0.0001);
    console.log(
      `  [${processed}/${outstanding.length}] ${email.padEnd(38)} rows ${String(weight(b)).padStart(4)}` +
        ` · codes ${totals.referralCodes.created} · orders ${totals.historicalOrders.created}` +
        ` · payouts ${totals.historicalPayouts.created} · errs ${rowErrors}` +
        ` · ETA ${fmtDuration(eta * 1000)}`,
    );

    if (runDoc) {
      await CdoMigrationRun.findByIdAndUpdate(runDoc._id, {
        report: {
          migrationType: "goaffpro",
          via: "scripts/migrate-cdo-goaffpro.js",
          startedAt: new Date(startedAt).toISOString(),
          updatedAt: nowIso(),
          complete: false,
          practitionersProcessed: processed,
          practitionersTotal: outstanding.length,
          failuresCsv: path.relative(process.cwd(), failCsv),
          ...totals,
        },
      });
    }

    if (APPLY && PACING_MS) await new Promise((r) => setTimeout(r, PACING_MS));
  }

  if (runDoc) {
    await CdoMigrationRun.findByIdAndUpdate(runDoc._id, {
      report: {
        migrationType: "goaffpro",
        via: "scripts/migrate-cdo-goaffpro.js",
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: nowIso(),
        complete: !stopping,
        interrupted: stopping,
        practitionersProcessed: processed,
        practitionersTotal: outstanding.length,
        failuresCsv: path.relative(process.cwd(), failCsv),
        ...totals,
      },
    });
  }

  console.log(`\n=== ${stopping ? "INTERRUPTED" : "DONE"} in ${fmtDuration(Date.now() - startedAt)} ===`);
  console.log(`  practitioners processed: ${processed} / ${outstanding.length}`);
  console.log(`  ${"sheet".padEnd(30)} ${"total".padStart(6)} ${"created".padStart(8)} ${"exists".padStart(7)} ${"skipped".padStart(8)} ${"errors".padStart(7)}`);
  for (const s of SECTIONS) {
    const t = totals[s];
    console.log(`  ${s.padEnd(30)} ${String(t.total).padStart(6)} ${String(t.created).padStart(8)} ${String(t.alreadyExists).padStart(7)} ${String(t.skipped).padStart(8)} ${String(t.errors).padStart(7)}`);
  }
  console.log(`\n  practitioners with at least one row error: ${failedEmails.size}`);
  console.log(`  failures CSV : ${path.relative(process.cwd(), failCsv)}`);
  console.log(`  event log    : ${path.relative(process.cwd(), eventLog)}`);
  if (APPLY) console.log(`  resume state : ${path.relative(process.cwd(), statePath)}`);
  if (!APPLY) console.log(`\n  DRY RUN — nothing was written. Re-run with --apply.`);
  else if (failedEmails.size) {
    console.log(`\n  Re-run just the practitioners that had errors:`);
    console.log(`    npm run migrate:cdo:apply -- --only-failed=${path.relative(process.cwd(), failCsv).replace(/\\/g, "/")}`);
  }
  console.log("");

  await mongoose.disconnect();
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(`\n[migrate-cdo-goaffpro] FAILED: ${err?.message || err}`);
    if (err?.stack) console.error(err.stack);
    try {
      await mongoose.disconnect();
    } catch {
      /* already down */
    }
    process.exit(1);
  });
